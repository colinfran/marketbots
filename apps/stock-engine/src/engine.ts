import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { AiRunner } from "@mb/engine-kit/ai/runner"
import { EventCycleQueue, type QueuedEvent } from "@mb/engine-kit/control/event-queue"
import { ControlPlane, type ControlWording } from "@mb/engine-kit/control/plane"
import { StatusReporter } from "@mb/engine-kit/control/status"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { claimDueSeed, finishSeed } from "@mb/engine-kit/state/seed-runs"
import { every, withTimeout } from "@mb/engine-kit/util/async"
import type { AlpacaAccount, AlpacaPosition, TradeUpdate } from "@mb/stock-core/alpaca"
import type { Command } from "@mb/stock-core/commands"
import type { CommandDoc, CoreReviewKind, CycleKind, EngineStatusDoc, HistoryRangeKey, MarketSessionInfo, SeedRunDoc } from "@mb/stock-core/db"
import type { CycleState, EngineRunStatus } from "@mb/stock-core/events"
import { roundTo } from "@mb/stock-core/math"
import { STRATEGY_LABEL } from "@mb/stock-core/options"
import type { Phase, SettingsPatch } from "@mb/stock-core/settings"
import type { EventFocus, WireCategory, WireItemDoc } from "@mb/stock-core/wire"
import { marketDay, minutesBetween } from "@mb/stock-core/time"
import type { HistoryStore } from "@mb/history/store"
import { coverageGaps } from "@mb/wire/calendar"
import { createStockAgent, type StockAgent } from "./agent"
import { eventSection } from "./ai/prompts"
import type { Alerts } from "./alerts"
import type { Alpaca, RestHealth } from "./alpaca/client"
import type { MarketStream } from "./alpaca/market-stream"
import type { TradeStream } from "./alpaca/trade-stream"
import type { EventBus } from "./bus/event-bus"
import { CommandProcessor } from "./commands/processor"
import { CoreRankingStore } from "./core-book/data"
import { runCoreReview } from "./core-book/review"
import { coreReviewDue } from "./core-book/schedule"
import type { EngineContext } from "./bot/context"
import { runCycle, type CycleOutcome } from "./bot/cycle"
import { cancelSymbolOrders } from "./bot/execute"
import { coreHeld } from "./bot/books"
import { flattenStocks, maintain } from "./bot/maintenance"
import { closeOptionPosition, liquidateOptions, monitorOptions, reconcileOptions } from "./bot/options"
import { clientId, syncOrders } from "./bot/orders"
import { planPhase, type PhasePlan } from "./bot/scheduler"
import { getSession, isSessionOpen, type Session } from "./bot/session"
import { chartSymbols, refreshCharts, refreshHistory, writeAccountSnapshot } from "./bot/site-data"
import { handleTradeUpdate } from "./bot/trade-updates"
import type { Database } from "./db/mongo"
import type { Env } from "./env"
import { snapshotPrice } from "./market/indicators"
import type { LivePrices } from "./market/prices"
import type { EngineStateStore, SettingsStore } from "./state/stores"
import type { PriceCoverage } from "./market/price-layers"
import type { StreamServer } from "./stream/server"
import { CORE_REVIEW_RULE, stockRules, WirePolicy, withCoreBook } from "./wire/policy"
import type { Wire } from "./wire/wire"

export const ENGINE_VERSION = "0.1.0"

const FAR_FUTURE = new Date(8.64e15)

/**
 * When a scheduled seed counts as missed: the start of the closing window on its own trading day.
 * A run whose day has passed, or that falls on a day the market is closed, is missed once due.
 */
export const seedDeadline = (session: Session, closeWindowMinutes: number) => (run: SeedRunDoc) => {
  const day = marketDay(run.at)
  if (day > session.day) return FAR_FUTURE
  if (day < session.day || !session.is_trading_day || !session.close) return run.at
  return new Date(session.close.getTime() - closeWindowMinutes * 60_000)
}

const usdText = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/** Stock's words in the shared control results and seed alerts (@mb/engine-kit/control/plane). */
const WORDING: ControlWording = {
  paused: "paused: no new cycles or entries; stops, targets and options exits stay active",
  halted: "halted: no new orders; stops, targets and options exits stay active",
  usd: usdText,
  seedScheduled: "; it runs in the regular session, after the opening buffer",
  seedInterrupted: "check the positions in Alpaca",
  seedFailedPath: () => "/admin",
}

export type EngineDeps = {
  env: Env
  log: Logger
  db: Database
  bus: EventBus
  settings: SettingsStore
  state: EngineStateStore
  alpaca: Alpaca
  prices: LivePrices
  tradeStream: TradeStream
  marketStream: MarketStream
  ai: AiRunner
  calls: AiCallLog
  alerts: Alerts
  stream: StreamServer
  wire: Wire
  /** The news engine's price layers (scan universe, Yahoo, Finnhub…): told what we hold and watch; the agent reads their prices. */
  coverage: Pick<PriceCoverage, "setSymbols" | "price">
  /** The history store; absent or null while HISTORY_URL is unset. */
  history?: HistoryStore<WireCategory> | null
}

const MIN = 60_000
/** A news trigger waits at most this long for its event cycle. */
const EVENT_QUEUE_MAX_MS = 30 * MIN

/**
 * The always-on engine. Owns the run state and every periodic job:
 *
 *   every 1s    dashboard commands
 *   every 5s    heartbeat to MongoDB (the dashboard's Admin page)
 *   every 15s   account snapshot for the dashboard, live-price subscriptions, the daily loss limit
 *   every 30s   the scheduler (premarket / intraday / close / postmarket, plus price-move triggers)
 *   every 60s   maintenance: order sync, stock protection, overnight fallback, options reconciliation
 *   every ~15s  options exits (value stop, take profit, underlying levels, time stop)
 *   periodic    equity history and chart bars for the website
 *   every 1s    the agent (./agent): its observations, watches and the next episode
 *
 * Fills arrive instantly over Alpaca's trade_updates stream. Stocks keep their stops at the broker
 * (bracket/OCO orders), so they stay protected even if the engine is down; options exits need the
 * engine, and the most an options position can lose is what was paid.
 *
 * The parts both bots share come from @mb/engine-kit/control: the owner's controls and the run
 * status (`control`), the heartbeat (`reporter`) and the news engine's event-cycle queue
 * (`eventQueue`: triggers expire after 30 minutes and run only inside the event window).
 */
export class Engine {
  cycleState: CycleState = "idle"
  currentTask: string | null = null
  currentPhase: Phase | null = null
  readonly ctx: EngineContext
  readonly control: ControlPlane<EngineRunStatus, WireItemDoc>
  readonly policy: WirePolicy
  /** The core book's daily ranking (built from the premarket window on; display only until the core review uses it). */
  readonly coreRanking: CoreRankingStore
  /** The agent (docs/plans/LOCAL-AI.md §8), deciding into its shadow book. */
  readonly agent: StockAgent

  private readonly abort = new AbortController()
  private stops: (() => void)[] = []
  private commands: CommandProcessor
  private readonly reporter: StatusReporter<EngineStatusDoc>
  private cycle: Promise<unknown> | null = null
  private lastCycleAt = 0
  private lastCycle: EngineStatusDoc["last_cycle"] = null
  private session: Session | null = null
  private plan: PhasePlan = { phase: null, reason: "starting" }
  private wasOpen: boolean | null = null
  private rest: { state: "ok" | "degraded" | "down" | "unknown"; last_ok_at: Date | null; last_error: string | null; failures: number } = { state: "unknown", last_ok_at: null, last_error: null, failures: 0 }
  private optionsLevel: number | null = null
  /** Price of each held symbol when the last cycle started, for price-move triggers. */
  private readonly reference = new Map<string, number>()
  private readonly triggerCooldown = new Map<string, number>()
  private heldSymbols: string[] = []
  /** The broker's account and positions at the last refresh (every 15 s): the agent's view of the paper account. */
  private snapshot: { account: AlpacaAccount; positions: AlpacaPosition[] } | null = null
  /** The core book's holdings while it is on (refreshed with the account): the trading cycles and their triggers leave them alone. */
  private coreSymbols: ReadonlySet<string> = new Set()
  private watchSymbols: string[] = []
  private watchRefreshedAt = 0
  /** Option underlyings held, and today's movers / most actives (the news engine's breadth set). */
  private underlyings: string[] = []
  private movers: string[] = []
  /** Symbols of the latest cycle's decisions and owner requests (the news engine's "focus"). */
  private focusSymbols: string[] = []
  private nextOpen: Date | null = null
  private lastOptionsCheck = 0
  private lastMaintenance = 0
  private lastHistory: Record<"intraday" | "long", number> = { intraday: 0, long: 0 }
  private lastCharts = 0
  private lastSummaryAt = 0
  private accountRefresh: NodeJS.Timeout | null = null
  /** News-engine event cycles waiting to run, merged by symbol ("MARKET" for market-wide), highest severity kept. */
  private readonly eventQueue: EventCycleQueue
  /** Single-holding core reviews waiting to run (serious bad news about a core holding), merged by symbol. */
  private readonly coreQueue: EventCycleQueue

  constructor(private readonly d: EngineDeps) {
    this.ctx = {
      col: d.db.col,
      log: d.log,
      bus: d.bus,
      alpaca: d.alpaca,
      settings: d.settings,
      state: d.state,
      ai: d.ai,
      alerts: d.alerts,
      prices: d.prices,
      setCycleState: (state, detail) => {
        this.cycleState = state
        this.currentTask = detail ?? null
      },
      signal: this.abort.signal,
      wire: d.wire,
    }
    this.agent = createStockAgent({
      ctx: this.ctx,
      history: d.history ?? null,
      calls: d.calls,
      llmUrl: d.env.LLM_URL ?? null,
      session: () => this.session,
      layerPrice: (s, ms) => d.coverage.price(s, ms),
      snapshot: () => this.snapshot,
      // At level auto the cycle slot runs only the one-time seed and the core book's reviews: the agent waits for them, so they never spend the same cash.
      busy: () => (this.agentTrades && this.cycle ? "a core review or the one-time seed is running" : null),
      demote: (reason) => this.demoteAgent(reason),
      promotion: {
        get: () => d.state.state.agent_promotion ?? null,
        set: (p) => this.promoteAgent(p),
      },
    })
    this.commands = new CommandProcessor(d.db.col, d.bus, d.log.child({ component: "commands" }), (c, doc) => this.handleCommand(c, doc))
    this.coreRanking = new CoreRankingStore({ col: d.db.col, alpaca: d.alpaca, settings: () => d.settings.current, log: d.log.child({ component: "core-book" }), held: () => this.heldSymbols })
    this.eventQueue = new EventCycleQueue({
      col: d.db.col,
      log: d.log,
      state: d.state,
      settings: d.settings,
      busy: () => !!this.cycle,
      // The gate only opens inside a session, so there is one.
      start: (events, trigger) => this.startCycle("intraday", this.session!, trigger, { kind: "event", events, requested: events.map((e) => e.symbol).filter((s): s is string => !!s) }),
      expireAfterMs: EVENT_QUEUE_MAX_MS,
      // Off-hours, the queue simply waits (and expires): the next phase's dossier carries the items anyway.
      gate: () => this.eventWindow().open,
    })
    this.coreQueue = new EventCycleQueue({
      col: d.db.col,
      log: d.log,
      state: d.state,
      settings: d.settings,
      busy: () => !!this.cycle,
      start: (events) => this.startHoldingReviews(events),
      expireAfterMs: EVENT_QUEUE_MAX_MS,
      gate: () => this.eventWindow().open && d.settings.current.core.enabled,
    })
    this.policy = new WirePolicy({
      col: d.db.col,
      bus: d.bus,
      log: d.log.child({ component: "wire-policy" }),
      settings: () => d.settings.current,
      rules: withCoreBook(stockRules, () => this.coreSymbols),
      engine: () => ({ running: d.state.state.status === "running", killSwitch: d.state.state.kill_switch.engaged }),
      session: () => this.eventWindow(),
      held: () => [...new Set([...this.heldSymbols, ...this.underlyings])],
      universe: () => this.wireSymbols().universe,
      request: (focus) => this.requestEventCycle(focus),
      markNotable: (ids, reason) => d.wire.markNotable(ids, reason),
      emergency: (symbol) => this.emergencyAction(symbol),
      alert: (title, message) => d.alerts.send("warning", title, message, { path: "/news" }),
      observe: (item, c) => this.agent.onCandidate(item, c),
    })
    this.control = new ControlPlane<EngineRunStatus, WireItemDoc>({
      col: d.db.col,
      bus: d.bus,
      state: d.state,
      settings: d.settings,
      alerts: d.alerts,
      policy: this.policy,
      liquidate: async () => [...(await liquidateOptions(this.ctx, "kill_switch")), ...(await flattenStocks(this.ctx, " (kill switch)"))],
      wording: WORDING,
      agent: this.agent.agent,
    })
    this.reporter = new StatusReporter<EngineStatusDoc>({
      col: d.db.col,
      bus: d.bus,
      calls: d.calls,
      settings: d.settings,
      ai: d.ai,
      state: d.state,
      stream: d.stream,
      wire: d.wire,
      policy: this.policy,
      instance: d.env.ENGINE_INSTANCE,
      version: ENGINE_VERSION,
      run: () => ({ status: this.status, cycle_state: this.cycleState, current_task: this.currentTask }),
      eventQueue: () => [...this.eventQueue.keys(), ...this.coreQueue.keys().map((k) => `core:${k}`)],
      doc: (p) => {
        const { tradeStream, marketStream, prices } = this.d
        const now = Date.now()
        return {
          ...p.run,
          current_phase: this.currentPhase,
          ...p.live,
          broker: {
            rest: this.rest.state,
            last_ok_at: this.rest.last_ok_at,
            last_error: this.rest.last_error,
            options_level: this.optionsLevel,
            trade_stream: tradeStream.health,
            data_stream: { ...marketStream.health, symbols: marketStream.symbols },
          },
          market: this.marketInfo(),
          schedule: this.plan,
          quotes: prices
            .all()
            .map((q) => ({ symbol: q.symbol, price: q.price, change_pct: q.change_pct, age_s: Math.round((now - q.at) / 1000) }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol)),
          ...p.usage,
          last_cycle: this.lastCycle,
          ...p.health,
          ...(d.history ? { history: d.history.status() } : {}),
          agent: this.agent.agent.status(),
        }
      },
    })
    d.wire.onItem((e) => this.policy.onItem(e))
    // News watches fire on fresh items only: a source's first poll after a restart is old news.
    d.wire.onItem((e) => (e.backfill ? undefined : this.agent.agent.onItem(e.item)))
  }

  /** The run status (owned by the control plane). */
  get status() {
    return this.control.status
  }

  get ready() {
    return this.control.ready
  }

  /** Symbol sets the news engine tags and ranks items against. Held includes option underlyings. */
  wireSymbols() {
    const benchmarks = this.d.settings.current.universe.benchmarks
    return {
      universe: [...new Set([...benchmarks, ...this.watchSymbols, ...this.movers])],
      held: [...new Set([...this.heldSymbols, ...this.underlyings])],
      focus: [...new Set([...this.watchSymbols, ...this.focusSymbols])],
    }
  }

  marketOpen() {
    return !!this.session && isSessionOpen(this.session)
  }

  /** When today's regular session opened, while it is open. */
  sessionOpenAt(): Date | null {
    return this.session && isSessionOpen(this.session) ? this.session.open : null
  }

  /** The macro calendar file needs regenerating before any kind runs out of dates. */
  private async checkCalendar() {
    const gaps = coverageGaps(new Date())
    if (gaps.length) await this.d.alerts.send("info", "Macro calendar running out", `Regenerate packages/wire/src/macro-calendar.json: ${gaps.join("; ")}.`, { key: `calendar|${gaps.join(",")}` })
  }

  /** Called by the Alpaca REST client after every request. */
  onRestHealth(h: RestHealth) {
    if (h.ok) this.rest = { state: "ok", last_ok_at: h.at, last_error: null, failures: 0 }
    else {
      const failures = this.rest.failures + 1
      this.rest = { ...this.rest, state: failures >= 3 ? "down" : "degraded", last_error: h.error, failures }
    }
  }

  /** One closed minute of the price board (the scan universe and what we track): the agent's setup screen. */
  onBoardBars(bars: readonly { symbol: string; t: number; close: number; volume: number }[]) {
    this.agent.onBars(bars)
  }

  onTradeUpdate(update: TradeUpdate) {
    void handleTradeUpdate(this.ctx, update)
      .then(({ filled }) => {
        // Show the new position/cash on the website right away (debounced: fills come in bursts).
        if (filled && !this.accountRefresh) {
          this.accountRefresh = setTimeout(() => {
            this.accountRefresh = null
            void writeAccountSnapshot(this.ctx).catch(() => undefined)
          }, 2_000)
        }
      })
      .catch((error) => this.d.log.warn("trade update failed", { error: errorMessage(error) }))
  }

  /** Why new entries are blocked right now, or null. Checked again just before every order. */
  private entriesBlocked = () => {
    const s = this.d.state.state
    if (s.kill_switch.engaged) return `kill switch engaged: ${s.kill_switch.reason ?? "no reason given"}`
    if (s.status !== "running") return `trading is ${s.status}`
    return null
  }

  async start() {
    const { bus, log, env, db, alerts } = this.d
    bus.emit("engine.started", { version: ENGINE_VERSION, instance: env.ENGINE_INSTANCE }, { summary: `Engine ${ENGINE_VERSION} started on ${env.ENGINE_INSTANCE}` })
    // A cycle left "running" belonged to a previous process that stopped mid-way.
    const stale = await db.col.cycles.updateMany({ status: "running" }, { $set: { status: "timed_out", finished_at: new Date(), error: "the engine restarted during this cycle" } })
    if (stale.modifiedCount) log.warn("marked interrupted cycles as timed out", { count: stale.modifiedCount })
    // Likewise a core review: it is never resumed (the weekly slot tries again the next trading day).
    const staleReviews = await db.col.coreReviews.updateMany({ status: "running" }, { $set: { status: "failed", finished_at: new Date(), error: "the engine restarted during this review" } })
    if (staleReviews.modifiedCount) await alerts.send("error", "Core review interrupted", "The engine restarted during a core review. Check the core holdings and their stops in Alpaca; the weekly slot tries again the next trading day.", { path: "/core" })
    await this.control.failInterruptedSeed()

    await this.refreshSession().catch((e) => log.warn("market calendar unavailable", { error: errorMessage(e) }))
    await syncOrders(db.col, this.d.alpaca).catch((e) => log.warn("initial order sync failed", { error: errorMessage(e) }))
    await this.refreshAccount().catch((e) => log.warn("initial account refresh failed", { error: errorMessage(e) }))
    void this.refreshSiteData(true).catch((e) => log.warn("initial site data refresh failed", { error: errorMessage(e) }))
    this.control.emitStatus("startup complete")
    if (!this.d.ai.available) await alerts.send("warning", "AI disabled", "LLM_URL is not set: the engine will monitor and protect positions but make no new decisions.")
    if (this.optionsLevel !== null && this.optionsLevel < 3 && this.d.settings.current.options.allow_spreads) {
      await alerts.send("warning", "Options spreads need level 3", `The Alpaca account's options level is ${this.optionsLevel}; debit spreads will be rejected. Raise it in the Alpaca dashboard or turn spreads off in Admin → Settings.`)
    }

    const onError = (job: string) => (error: unknown) => log.warn(`${job} failed`, { error: errorMessage(error) })
    this.stops.push(every(5_000, () => this.reporter.write(), onError("heartbeat"), { immediate: true }))
    this.stops.push(every(15_000, () => this.refreshAccount(), onError("account refresh")))
    this.stops.push(every(30_000, () => this.schedule(), onError("scheduler"), { immediate: true }))
    this.stops.push(every(15_000, () => this.periodicMaintenance(), onError("maintenance")))
    this.stops.push(every(5_000, () => this.watchOptions(), onError("options monitor")))
    this.stops.push(every(60_000, () => this.refreshSiteData(false), onError("site data")))
    this.commands.start()
    this.d.tradeStream.start()
    this.d.marketStream.start()
    this.d.settings.onChange(() => this.d.wire.reconcile())
    // The news engine fails open: if it can't start, trading carries on exactly as before.
    void this.d.wire.start().catch((e) => log.warn("news engine failed to start", { error: errorMessage(e) }))
    this.stops.push(every(86_400_000, () => this.checkCalendar(), onError("calendar check"), { immediate: true }))
    await this.agent.agent.start().catch((e) => log.warn("agent failed to start", { error: errorMessage(e) }))
  }

  // ─── Market session ──────────────────────────────────────────────────────

  private async refreshSession(now = new Date()) {
    this.session = await getSession(this.d.alpaca, now)
    const open = isSessionOpen(this.session, now)
    if (this.wasOpen !== null && open !== this.wasOpen) {
      this.d.bus.emit("market.session", { state: open ? "open" : "closed", day: this.session.day }, { summary: open ? "The market is open" : "The market is closed" })
    }
    this.wasOpen = open
    return this.session
  }

  private marketInfo(now = new Date()): MarketSessionInfo | null {
    const s = this.session
    if (!s) return null
    return { day: s.day, is_trading_day: s.is_trading_day, is_open: isSessionOpen(s, now), open: s.open, close: s.close, early_close: s.early_close, next_open: this.nextOpen }
  }

  // ─── Account & live prices ───────────────────────────────────────────────

  /**
   * Live prices for what matters most: held stocks, option underlyings, the index ETFs, the news
   * engine's current focus, then the watchlist (dropped first when the stream is full).
   */
  private streamSymbols() {
    return [...new Set([...this.heldSymbols, ...this.underlyings, "SPY", "QQQ", ...this.focusSymbols, ...this.watchSymbols])].slice(0, this.d.settings.current.universe.stream_max_symbols)
  }

  /** What the news engine's price layers track on top of the scan universe. */
  private coverageSymbols() {
    return { held: [...this.heldSymbols, ...this.underlyings], benchmarks: this.d.settings.current.universe.benchmarks, watch: this.watchSymbols, movers: this.movers, focus: this.focusSymbols }
  }

  private async refreshAccount() {
    const snapshot = await writeAccountSnapshot(this.ctx)
    const { account, positions } = snapshot
    this.snapshot = { account, positions }
    this.optionsLevel = account.options_trading_level ?? account.options_approved_level ?? null
    const stocks = positions.filter((p) => (p.asset_class ?? "us_equity") === "us_equity")
    this.heldSymbols = stocks.map((p) => p.symbol)
    this.coreSymbols = coreHeld(await this.d.db.col.plans.find({ book: "core" }, { projection: { book: 1 } }).toArray(), this.d.settings.current)
    const optionDocs = await this.d.db.col.optionPositions.find({ status: { $in: ["open", "closing"] } }, { projection: { underlying: 1 } }).toArray()
    const underlyings = optionDocs.map((d) => d.underlying)
    this.underlyings = [...new Set(underlyings)]

    this.nextOpen = snapshot.clock.next_open ? new Date(snapshot.clock.next_open) : null
    if (Date.now() - this.watchRefreshedAt >= 5 * MIN) {
      this.watchRefreshedAt = Date.now()
      const latest = await this.d.db.col.reports.findOne({}, { sort: { created_at: -1 }, projection: { "report.watchlist.symbol": 1 } })
      this.watchSymbols = (latest?.report.watchlist ?? []).map((w) => w.symbol)
      // The news engine's breadth set: today's movers and most actives on top of what we hold and watch.
      if (this.marketOpen()) {
        const [movers, actives] = await Promise.all([this.d.alpaca.getMovers(20).catch(() => null), this.d.alpaca.getMostActives(50).catch(() => null)])
        this.movers = [...new Set([...(movers ? [...movers.gainers, ...movers.losers].map((m) => m.symbol) : []), ...(actives?.most_actives.map((a) => a.symbol) ?? [])])]
      }
      this.d.coverage.setSymbols(this.coverageSymbols())
    }
    const wanted = this.streamSymbols()
    this.d.marketStream.setSymbols(wanted)
    const missing = wanted.filter((s) => !this.d.prices.hasPrevClose(s))
    if (missing.length) {
      const snaps = await this.d.alpaca.getSnapshots(missing).catch(() => ({}) as Awaited<ReturnType<Alpaca["getSnapshots"]>>)
      const today = marketDay()
      for (const [symbol, snap] of Object.entries(snaps)) {
        const barIsToday = snap.dailyBar ? marketDay(new Date(snap.dailyBar.t)) === today : false
        this.d.prices.setPrevClose(symbol, barIsToday ? snap.prevDailyBar?.c : snap.dailyBar?.c)
        const price = snapshotPrice(snap)
        if (price !== null && !this.d.prices.get(symbol) && snap.latestTrade) this.d.prices.onTrade(symbol, price, Date.parse(snap.latestTrade.t))
      }
    }

    if (Date.now() - this.lastSummaryAt >= 30 * MIN) {
      this.lastSummaryAt = Date.now()
      const equity = Number(account.equity)
      const start = Number(account.last_equity) || equity
      const starting = this.d.settings.current.account.starting_capital
      this.d.bus.emit(
        "summary.periodic",
        {
          equity_usd: roundTo(equity, 2),
          day_pnl_usd: roundTo(equity - start, 2),
          day_pnl_pct: start > 0 ? roundTo((equity / start - 1) * 100, 2) : null,
          total_return_pct: starting > 0 ? roundTo((equity / starting - 1) * 100, 2) : null,
          positions: stocks.length,
          option_positions: optionDocs.length,
        },
        { summary: `Equity $${equity.toFixed(2)} · ${stocks.length} stocks · ${optionDocs.length} options positions` },
      )
    }
  }

  // ─── Scheduling ──────────────────────────────────────────────────────────

  private async schedule() {
    const now = new Date()
    const session = await this.refreshSession(now)
    const settings = this.d.settings.current
    // At level auto (and after a breaker's demotion) the agent decides on its own events: no session
    // phases, intraday, price-move or event cycles.
    this.plan = this.cyclesStopped
      ? { phase: null, reason: this.agentTrades ? "The agent trades (level auto): no timed cycles." : "A circuit breaker dropped the agent to shadow: no timed cycles until the owner promotes it again." }
      : await planPhase(this.d.db.col, settings, session, now)
    // In the background: a few REST calls once a day, never blocking a cycle.
    void this.coreRanking.refresh(session, now)
    if (this.cycle) return
    await this.control.failMissedSeeds(seedDeadline(session, settings.schedule.close_window_minutes), now)
    const st = this.d.state.state
    if (st.status !== "running" || st.kill_switch.engaged) return
    // The one-time seed runs only in the regular session, after the opening buffer and before the closing window.
    const sch = settings.schedule
    if (isSessionOpen(session, now) && -minutesBetween(now, session.open!) >= sch.open_buffer_minutes && minutesBetween(now, session.close!) > sch.close_window_minutes) {
      const seed = await claimDueSeed(this.d.db.col, now)
      if (seed) return this.startCycle("intraday", session, "seed", { kind: "seed", seed })
    }
    // The core book's weekly review, ahead of news events and intraday cycles (the planner's premarket catch-up and closing cycle come first).
    if (!this.plan.phase || this.plan.phase === "intraday") {
      const core = await coreReviewDue(this.d.db.col, settings, session, now)
      if (core.due) return this.startCoreReview(session, "schedule", { dryRun: false })
    }
    // News events go before scheduled intraday cycles (the planner's other phases still come first).
    if ((!this.plan.phase || this.plan.phase === "intraday") && (this.coreQueue.drain() || (!this.cyclesStopped && this.eventQueue.drain()))) return
    if (this.plan.phase) return this.startCycle(this.plan.phase, session, "schedule", { kind: "scheduled" })
    if (this.cyclesStopped) return

    // Between scheduled intraday cycles, a held stock or option underlying moving sharply triggers an early one.
    const s = settings.schedule
    if (!isSessionOpen(session, now) || -minutesBetween(now, session.open!) < s.open_buffer_minutes || minutesBetween(now, session.close!) <= s.close_window_minutes) return
    if (Date.now() - this.lastCycleAt < s.min_cycle_gap_minutes * MIN) return
    const moved: string[] = []
    for (const [symbol, ref] of this.reference) {
      const price = this.d.prices.fresh(symbol, MIN)
      if (price === null || !ref) continue
      const cooled = Date.now() - (this.triggerCooldown.get(symbol) ?? 0) >= s.trigger_cooldown_minutes * MIN
      if (cooled && Math.abs(price / ref - 1) * 100 >= s.trigger_move_pct) moved.push(`${symbol} ${price >= ref ? "+" : ""}${((price / ref - 1) * 100).toFixed(1)}%`)
    }
    if (!moved.length) return
    for (const m of moved) this.triggerCooldown.set(m.split(" ")[0], Date.now())
    this.startCycle("intraday", session, `price move: ${moved.join(", ")}`, { kind: "price_move" })
  }

  private async rememberReferencePrices() {
    this.reference.clear()
    const underlyings = (await this.d.db.col.optionPositions.find({ status: "open" }, { projection: { underlying: 1 } }).toArray()).map((d) => d.underlying)
    // Core holdings move on their own clock: their stops rest at the broker and the weekly review judges them.
    for (const symbol of new Set([...this.heldSymbols.filter((s) => !this.coreSymbols.has(s)), ...underlyings])) {
      const price = this.d.prices.fresh(symbol, 5 * MIN)
      if (price !== null) this.reference.set(symbol, price)
    }
  }

  private startCycle(
    phase: Phase,
    session: Session,
    trigger: string,
    { kind, requested = [], seed, events = [] }: { kind: CycleKind; requested?: string[]; seed?: SeedRunDoc; events?: QueuedEvent[] },
  ) {
    const startedAt = Date.now()
    this.lastCycleAt = startedAt
    this.currentPhase = phase
    this.focusSymbols = [...new Set([...requested, ...events.map((e) => e.symbol).filter((s): s is string => !!s)])]
    // An event's symbol joins the live stream at once, so protection and the next cycles see broker quotes.
    if (events.length) {
      this.d.marketStream.setSymbols(this.streamSymbols())
      this.d.coverage.setSymbols(this.coverageSymbols())
    }
    this.cycle = this.rememberReferencePrices()
      .catch(() => undefined)
      .then(() =>
        runCycle(this.ctx, {
          phase,
          session,
          trigger,
          kind,
          requested,
          entriesBlocked: this.entriesBlocked,
          seed: seed ? { id: seed._id, amountUsd: seed.amount_usd } : undefined,
          events: events.map(({ queued_at: _q, ...e }) => e),
        }),
      )
      .then(async (r) => {
        this.lastCycle = { id: r.cycleId, phase: r.phase, at: new Date(), status: r.status, headline: r.headline }
        if (seed) await this.recordSeed(seed, r)
        await this.eventQueue.served(events, r.cycleId, startedAt)
      })
      .catch(async (error) => {
        this.d.log.error("cycle crashed", { error: errorMessage(error) })
        await this.d.alerts.send("error", "Cycle crashed", errorMessage(error))
        if (seed) await this.control.failSeed(seed, `crashed: ${errorMessage(error)}`, null).catch(() => undefined)
      })
      .finally(() => {
        this.cycle = null
        this.currentPhase = null
        this.ctx.setCycleState("idle")
        // Triggers that arrived meanwhile run now.
        if (!this.coreQueue.drain()) this.eventQueue.drain()
      })
  }

  /** Runs a core book review in the cycle slot, so it never overlaps a trading cycle. */
  private startCoreReview(
    session: Session,
    trigger: string,
    { dryRun, kind = "weekly", events = [] }: { dryRun: boolean; kind?: CoreReviewKind; events?: QueuedEvent[] },
  ) {
    const startedAt = Date.now()
    this.lastCycleAt = startedAt
    this.currentPhase = "intraday"
    const focus = events[0]
    this.cycle = runCoreReview(this.ctx, {
      kind,
      trigger,
      dryRun,
      session,
      entriesBlocked: this.entriesBlocked,
      ranking: this.coreRanking,
      ...(focus?.symbol ? { symbol: focus.symbol, event: eventSection(events.map(({ queued_at: _q, ...e }) => e)) } : {}),
    })
      .then(async (r) => {
        this.lastCycle = { id: r.cycleId, phase: "intraday", at: new Date(), status: r.status === "done" ? "succeeded" : r.status === "skipped" ? "skipped" : "failed", headline: r.summary ? r.summary.slice(0, 140) : null }
        if (events.length) await this.coreQueue.served(events, r.cycleId, startedAt)
      })
      .catch(async (error) => {
        this.d.log.error("core review crashed", { error: errorMessage(error) })
        await this.d.alerts.send("error", "Core review crashed", errorMessage(error), { path: "/core" })
      })
      .finally(() => {
        this.cycle = null
        this.currentPhase = null
        this.ctx.setCycleState("idle")
        if (!this.coreQueue.drain()) this.eventQueue.drain()
      })
  }

  /**
   * Serious bad news about core holdings: one single-holding review at a time (the queue merges by
   * symbol); the others wait for the next slot.
   */
  private startHoldingReviews(events: QueuedEvent[]) {
    const [first, ...rest] = events
    this.startCoreReview(this.session!, `news: ${first.headline.slice(0, 120)}`, { dryRun: false, kind: "holding", events: [first] })
    for (const e of rest) this.coreQueue.request(e)
  }

  /** Whether an event cycle can run now: the regular session, past the opening buffer, more than 3 minutes before the close. */
  private eventWindow(now = new Date()): { open: boolean; reason: string } {
    const s = this.session
    if (!s || !isSessionOpen(s, now)) return { open: false, reason: "outside the regular session" }
    if (-minutesBetween(now, s.open!) < this.d.settings.current.schedule.open_buffer_minutes) return { open: false, reason: "inside the opening buffer" }
    if (minutesBetween(now, s.close!) <= 3) return { open: false, reason: "too close to the bell" }
    return { open: true, reason: "regular session" }
  }

  /**
   * A news-engine trigger asks for a focused intraday cycle. It starts at once when nothing is
   * running and the minimum gap since the last event cycle has passed; otherwise it waits, merged
   * by symbol (highest severity kept), and runs the moment the current cycle ends.
   */
  requestEventCycle(focus: EventFocus): "fired" | "queued" | "agent" {
    // Bad news about a core holding goes to the core book's single-holding review, not an event cycle.
    if (focus.rule === CORE_REVIEW_RULE) return this.coreQueue.request(focus)
    // While the timed cycles are stopped the trigger is the agent's: it has already seen its candidate.
    if (this.cyclesStopped) return "agent"
    return this.eventQueue.request(focus)
  }

  /** Level auto: the agent decides and the timed cycles stop (the core book's reviews carry on). */
  private get agentTrades() {
    return this.d.settings.current.agent.level === "auto"
  }

  /**
   * The timed cycles stop at level auto, and stay stopped after a circuit breaker drops the agent
   * to shadow, until the owner promotes it again.
   */
  private get cyclesStopped() {
    return this.agentTrades || !!this.d.state.state.agent_demotion
  }

  /**
   * A circuit breaker drops the agent to shadow (an audited settings change). The demotion is kept
   * first, so no scheduler tick sees shadow without it and starts a timed cycle.
   */
  private async demoteAgent(reason: string) {
    const { settings, state, log } = this.d
    await state.update({ agent_demotion: { at: new Date(), reason } }, "engine:agent-breaker", "agent.demoted", {})
    const r = await settings.apply({ agent: { level: "shadow" } } as SettingsPatch, "engine:agent-breaker", null)
    if (!r.ok) throw new Error(r.error)
    log.warn("agent dropped to shadow", { reason })
  }

  /** A promotion to auto: its time and equity, for the total-loss breaker. It ends any demotion. */
  private async promoteAgent(p: { at: Date; equity_usd: number }) {
    await this.d.state.update({ agent_promotion: p, agent_demotion: null }, "engine", "agent.promoted", {})
  }

  /** Drops triggers that waited too long (the queue does this on every drain; tests call it with a later clock). */
  private expireEvents(now = Date.now()) {
    this.eventQueue.expire(now)
  }

  /** The owner's emergency action for a held stock hit by critical, confirmed bad news: sell it at market. */
  private async emergencyAction(symbol: string): Promise<string> {
    if (this.d.settings.current.wire.emergency_action !== "exit") return "review only"
    if (!this.marketOpen()) return "market closed; the next phase reviews it"
    const position = (await this.d.alpaca.getPositions()).find((p) => p.symbol === symbol && (p.asset_class ?? "us_equity") === "us_equity")
    if (!position) return "no open position"
    await cancelSymbolOrders(this.d.alpaca, symbol)
    const order = await this.d.alpaca.submitOrder({ symbol, qty: position.qty, side: "sell", type: "market", time_in_force: "day", client_order_id: clientId("emergency") })
    this.d.bus.emit(
      "order.submitted",
      { order_id: order.id, symbol, side: "sell", type: "market", qty: Number(position.qty), limit_price: null, purpose: "news emergency exit", asset_class: "us_equity" },
      { summary: `Order sent: sell ${position.qty} ${symbol} (news emergency exit)`, instrument: symbol },
    )
    await this.d.db.col.plans.deleteOne({ _id: symbol })
    return `selling ${position.qty} ${symbol} at market`
  }

  /** The one-time seed is a single attempt: done if at least one buy went through, else failed and alerted. */
  private async recordSeed(run: SeedRunDoc, r: CycleOutcome) {
    const seed = r.seed ?? { allocations: [], orders: [], notes: [], rationale: null, executed: 0 }
    const result = { allocations: seed.allocations, orders: seed.orders, notes: seed.notes, rationale: seed.rationale }
    if (r.status !== "succeeded" || seed.executed === 0) {
      const reasons = seed.orders.map((o) => `${o.symbol}: ${o.reason ?? o.status}`)
      const why = r.status === "succeeded" ? `no buy went through (${reasons.join("; ") || "nothing allocated"})` : `the seed cycle ${r.status}${seed.notes.length ? `: ${seed.notes.at(-1)}` : ""}`
      return this.control.failSeed(run, why, r.cycleId, result)
    }
    await finishSeed(this.d.db.col, run._id, { status: "done", cycle_id: r.cycleId, result, error: null })
    this.d.bus.emit(
      "seed.completed",
      { seed_id: run._id, cycle_id: r.cycleId, status: "done", allocations: seed.allocations.map(({ thesis: _t, ...a }) => a), executed: seed.executed, error: null },
      { summary: `One-time seed done: ${seed.allocations.map((a) => `${a.symbol} ${usdText(a.notional_usd)}`).join(", ")}` },
    )
    const fields = Object.fromEntries(seed.orders.map((o) => [o.symbol, `${o.status}${o.qty ? ` · ${o.qty} shares` : ""}${o.notional_usd ? ` · ${usdText(o.notional_usd)}` : ""}${o.status === "executed" || !o.reason ? "" : ` (${o.reason})`}`]))
    await this.d.alerts.success("One-time seed done", (seed.rationale ?? "").slice(0, 1_500), { path: "/admin", key: `seed|${run._id}`, fields: { Amount: usdText(run.amount_usd), ...fields } })
  }

  // ─── Maintenance, options, site data ─────────────────────────────────────

  private async periodicMaintenance() {
    const session = this.session
    if (!session) return
    const now = new Date()
    const near = this.nearSession(session, now)
    if (Date.now() - this.lastMaintenance < (near ? MIN : 15 * MIN)) return
    this.lastMaintenance = Date.now()
    // While a cycle or an agent episode is trading, only sync: re-protecting a stock it is selling
    // would fight it for the shares. The cycle checks protection itself before it finishes; the
    // next pass does it after an episode.
    if (this.cycle || (this.agentTrades && this.agent.agent.current)) {
      await syncOrders(this.d.db.col, this.d.alpaca)
      return
    }
    const notes = await maintain(this.ctx, session, {
      now,
      // While the timed cycles are stopped there is no closing cycle: the overnight rules always run in the last minutes.
      closeCycleDone: async () => !this.cyclesStopped && (await this.d.db.col.cycles.countDocuments({ trading_day: session.day, phase: "close", status: { $in: ["succeeded", "running"] } })) > 0,
      cyclesStopped: this.cyclesStopped,
    })
    if (notes.length) this.d.log.info("maintenance", { notes })
  }

  private async watchOptions() {
    const seconds = this.d.settings.current.options.monitor_seconds
    if (Date.now() - this.lastOptionsCheck < seconds * 1000) return
    this.lastOptionsCheck = Date.now()
    const marketOpen = !!this.session && isSessionOpen(this.session)
    const notes = await monitorOptions(this.ctx, { marketOpen })
    if (notes.length) this.d.log.info("options exits", { notes })
  }

  private nearSession(session: Session, now: Date) {
    return !!session.open && !!session.close && now.getTime() >= session.open.getTime() - 30 * MIN && now.getTime() <= session.close.getTime() + 30 * MIN
  }

  /** Equity history and chart bars for the website: often around market hours, rarely otherwise. */
  private async refreshSiteData(force: boolean) {
    const now = new Date()
    const near = !!this.session && this.nearSession(this.session, now)
    const due = (last: number, ms: number) => force || Date.now() - last >= ms
    const keys: HistoryRangeKey[] = []
    if (due(this.lastHistory.intraday, near ? 5 * MIN : 60 * MIN)) {
      keys.push("1D")
      this.lastHistory.intraday = Date.now()
    }
    if (due(this.lastHistory.long, 60 * MIN)) {
      keys.push("1W", "1M", "1A")
      this.lastHistory.long = Date.now()
    }
    if (keys.length) await refreshHistory(this.ctx, keys)
    if (due(this.lastCharts, near ? 10 * MIN : 120 * MIN)) {
      this.lastCharts = Date.now()
      await refreshCharts(this.ctx, await chartSymbols(this.ctx, this.heldSymbols), now)
    }
  }

  // ─── Commands ────────────────────────────────────────────────────────────

  /** Stock's own commands; the shared ones (pause, kill switch, settings, seed, replay) go to the control plane. */
  private async handleCommand(command: Command, doc: CommandDoc): Promise<string> {
    const { state, alpaca, db } = this.d
    const by = doc.created_by
    switch (command.type) {
      case "cycle.run_now": {
        // While the timed cycles are stopped the agent reviews what was asked, and at level auto may act on it.
        if (this.cyclesStopped) return this.agent.agent.review(command.symbols ?? [], by)
        if (this.cycle) throw new Error("a cycle is already running")
        if (state.state.status !== "running" || state.state.kill_switch.engaged) throw new Error(`engine is ${this.status}`)
        const session = await this.refreshSession()
        const phase = command.phase ?? (this.plan.phase && this.plan.phase !== "intraday" ? this.plan.phase : isSessionOpen(session) ? "intraday" : null)
        if (!phase) throw new Error("the market is closed: pick a phase (premarket or postmarket) or wait for the open")
        const symbols = command.symbols ?? []
        this.startCycle(phase, session, symbols.length ? `manual: evaluate ${symbols.join(", ")}` : "manual", { kind: "manual", requested: symbols })
        return symbols.length ? `${phase} cycle started; the AI will evaluate ${symbols.join(", ")}` : `${phase} cycle started`
      }
      case "position.close": {
        const position = (await alpaca.getPositions()).find((p) => p.symbol === command.symbol && (p.asset_class ?? "us_equity") === "us_equity")
        if (!position) throw new Error(`no ${command.symbol} position`)
        await cancelSymbolOrders(alpaca, command.symbol)
        const order = await alpaca.submitOrder({ symbol: command.symbol, qty: position.qty, side: "sell", type: "market", time_in_force: "day", client_order_id: clientId(this.coreSymbols.has(command.symbol) ? "core-manual" : "manual") })
        this.d.bus.emit(
          "order.submitted",
          { order_id: order.id, symbol: command.symbol, side: "sell", type: "market", qty: Number(position.qty), limit_price: null, purpose: "manual close", asset_class: "us_equity" },
          { summary: `Order sent: sell ${position.qty} ${command.symbol} (closed by the owner)`, instrument: command.symbol },
        )
        await db.col.plans.deleteOne({ _id: command.symbol })
        return isSessionOpen(this.session ?? (await this.refreshSession())) ? `selling ${position.qty} ${command.symbol} at market` : `sell order for ${position.qty} ${command.symbol} queued for the open`
      }
      case "option.close": {
        if (!this.session || !isSessionOpen(this.session)) throw new Error("options can only be closed while the market is open")
        const position = await db.col.optionPositions.findOne({ _id: command.structure_id, status: "open" })
        if (!position) throw new Error("no open options position with that id")
        const result = await closeOptionPosition(this.ctx, position, "manual", { urgent: false })
        if (!result.ok) throw new Error(result.detail)
        return `${STRATEGY_LABEL[position.strategy]} on ${position.underlying}: ${result.detail}`
      }
      case "broker.sync": {
        const fills = await syncOrders(db.col, alpaca)
        const snapshot = await writeAccountSnapshot(this.ctx)
        const notes = await reconcileOptions(this.ctx, snapshot.positions)
        // Charts and equity history are nice to have; a failure there doesn't fail the sync.
        await this.refreshSiteData(true).catch((e) => notes.push(`website data refresh failed: ${errorMessage(e)}`))
        return `synced: ${fills} fills on record, ${snapshot.positions.length} positions${notes.length ? `; ${notes.join("; ")}` : ""}`
      }
      case "core.review": {
        if (this.cycle) throw new Error("a cycle is running; try again when it ends")
        const session = await this.refreshSession()
        if (!command.dry_run) {
          if (!this.d.settings.current.core.enabled) throw new Error("the core book is off: turn it on in Admin → Settings → Core book, or run a dry run")
          if (state.state.status !== "running" || state.state.kill_switch.engaged) throw new Error(`engine is ${this.status}`)
          if (!isSessionOpen(session)) throw new Error("a core review trades, so it runs only while the market is open (a dry run works any time)")
        }
        if (!this.d.ai.available) throw new Error("AI is disabled (LLM_URL not set)")
        this.startCoreReview(session, "manual", { dryRun: !!command.dry_run })
        return command.dry_run ? "core review dry run started: its trades are planned, not placed" : "core review started; it counts as this week's"
      }
      default:
        return this.control.handle(command, by)
    }
  }

  async shutdown(reason: string) {
    const { bus, log } = this.d
    if (this.control.status === "stopping") return
    this.control.status = "stopping"
    log.info("engine shutting down", { reason })
    bus.emit("engine.stopping", { reason }, { summary: `Engine stopping (${reason})`, level: "warn" })
    this.commands.shutdown()
    for (const stop of this.stops) stop()
    this.d.tradeStream.stop()
    this.d.marketStream.stop()
    this.d.wire.stop()
    this.eventQueue.stop()
    this.coreQueue.stop()
    if (this.accountRefresh) clearTimeout(this.accountRefresh)
    this.agent.agent.stop()
    // Abort in-flight AI calls; an order already sent to the broker still completes.
    this.abort.abort()
    if (this.cycle) await withTimeout(this.cycle, 20_000, "cycle shutdown").catch(() => undefined)
    if (this.agent.agent.current) await withTimeout(this.agent.agent.current, 20_000, "agent shutdown").catch(() => undefined)
    await this.reporter.write().catch(() => undefined)
  }
}
