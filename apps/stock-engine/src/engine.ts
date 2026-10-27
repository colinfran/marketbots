import type { TradeUpdate } from "@mb/stock-core/alpaca"
import type { Command } from "@mb/stock-core/commands"
import type { CommandDoc, CycleKind, EngineStatusDoc, HistoryRangeKey, MarketSessionInfo, SeedRunDoc } from "@mb/stock-core/db"
import type { CycleState, EngineRunStatus } from "@mb/stock-core/events"
import { roundTo } from "@mb/stock-core/math"
import { STRATEGY_LABEL } from "@mb/stock-core/options"
import type { Phase, SettingsPatch } from "@mb/stock-core/settings"
import type { EventFocus } from "@mb/stock-core/wire"
import { marketDay, minutesBetween } from "@mb/stock-core/time"
import type { AiBudget } from "./ai/budget"
import type { AiRunner } from "./ai/runner"
import type { Alerts } from "./alerts"
import type { Alpaca, RestHealth } from "./alpaca/client"
import type { MarketStream } from "./alpaca/market-stream"
import type { TradeStream } from "./alpaca/trade-stream"
import type { EventBus } from "./bus/event-bus"
import { CommandProcessor } from "./commands/processor"
import type { EngineContext } from "./bot/context"
import { runCycle, type CycleOutcome } from "./bot/cycle"
import { cancelSymbolOrders } from "./bot/execute"
import { flattenStocks, maintain } from "./bot/maintenance"
import { closeOptionPosition, liquidateOptions, monitorOptions, reconcileOptions } from "./bot/options"
import { clientId, syncOrders } from "./bot/orders"
import { planPhase, type PhasePlan } from "./bot/scheduler"
import { getSession, isSessionOpen, type Session } from "./bot/session"
import { chartSymbols, refreshCharts, refreshHistory, writeAccountSnapshot } from "./bot/site-data"
import { handleTradeUpdate } from "./bot/trade-updates"
import type { Database } from "./db/mongo"
import type { Env } from "./env"
import { ResourceSampler } from "./heartbeat"
import { errorMessage, type Logger } from "./log"
import { snapshotPrice } from "./market/indicators"
import type { LivePrices } from "./market/prices"
import { cancelSeed, claimDueSeed, failInterruptedSeeds, failMissedSeeds, finishSeed, scheduleSeed } from "./state/seed-runs"
import type { EngineStateStore, SettingsStore } from "./state/stores"
import type { PriceCoverage } from "./market/price-layers"
import type { StreamServer } from "./stream/server"
import { every, withTimeout } from "./util/async"
import { coverageGaps } from "./wire/calendar"
import { stockRules, WirePolicy } from "./wire/policy"
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
  budget: AiBudget
  alerts: Alerts
  stream: StreamServer
  wire: Wire
  /** The news engine's price layers (scan universe, Yahoo, Finnhub…): told what we hold and watch. */
  coverage: Pick<PriceCoverage, "setSymbols">
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
 *
 * Fills arrive instantly over Alpaca's trade_updates stream. Stocks keep their stops at the broker
 * (bracket/OCO orders), so they stay protected even if the engine is down; options exits need the
 * engine, and the most an options position can lose is what was paid.
 */
export class Engine {
  status: EngineRunStatus = "starting"
  cycleState: CycleState = "idle"
  currentTask: string | null = null
  currentPhase: Phase | null = null
  readonly ctx: EngineContext

  private readonly startedAt = new Date()
  private readonly abort = new AbortController()
  private readonly sampler = new ResourceSampler()
  private stops: (() => void)[] = []
  private commands: CommandProcessor
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
  private readonly eventQueue = new Map<string, EventFocus & { queued_at: number }>()
  private lastEventCycleAt = 0
  private eventTimer: NodeJS.Timeout | null = null
  private triggersToday = 0
  readonly policy: WirePolicy

  constructor(private readonly d: EngineDeps) {
    this.ctx = {
      col: d.db.col,
      log: d.log,
      bus: d.bus,
      alpaca: d.alpaca,
      settings: d.settings,
      state: d.state,
      ai: d.ai,
      budget: d.budget,
      alerts: d.alerts,
      prices: d.prices,
      setCycleState: (state, detail) => {
        this.cycleState = state
        this.currentTask = detail ?? null
      },
      signal: this.abort.signal,
      wire: d.wire,
    }
    this.commands = new CommandProcessor(d.db.col, d.bus, d.log.child({ component: "commands" }), (c, doc) => this.handleCommand(c, doc))
    this.policy = new WirePolicy({
      col: d.db.col,
      bus: d.bus,
      log: d.log.child({ component: "wire-policy" }),
      settings: () => d.settings.current,
      rules: stockRules,
      engine: () => ({ running: d.state.state.status === "running", killSwitch: d.state.state.kill_switch.engaged }),
      session: () => this.eventWindow(),
      held: () => [...new Set([...this.heldSymbols, ...this.underlyings])],
      universe: () => this.wireSymbols().universe,
      budget: d.budget,
      request: (focus) => this.requestEventCycle(focus),
      markNotable: (ids, reason) => d.wire.markNotable(ids, reason),
      emergency: (symbol) => this.emergencyAction(symbol),
      alert: (title, message) => d.alerts.send("warning", title, message, { path: "/research?tab=ours" }),
    })
    d.wire.onItem((e) => this.policy.onItem(e))
  }

  get ready() {
    return this.status === "running" || this.status === "paused" || this.status === "halted"
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
    if (gaps.length) await this.d.alerts.send("info", "Macro calendar running out", `Regenerate apps/stock-engine/src/wire/macro-calendar.json: ${gaps.join("; ")}.`, { key: `calendar|${gaps.join(",")}` })
  }

  /** Called by the Alpaca REST client after every request. */
  onRestHealth(h: RestHealth) {
    if (h.ok) this.rest = { state: "ok", last_ok_at: h.at, last_error: null, failures: 0 }
    else {
      const failures = this.rest.failures + 1
      this.rest = { ...this.rest, state: failures >= 3 ? "down" : "degraded", last_error: h.error, failures }
    }
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

  private emitStatus(reason?: string) {
    const s = this.d.state.state
    this.status = s.kill_switch.engaged ? "halted" : s.status
    this.d.bus.emit("engine.status", { status: this.status, kill_switch: s.kill_switch.engaged, reason }, { summary: `Engine ${this.status}${reason ? `: ${reason}` : ""}` })
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
    if (await failInterruptedSeeds(db.col)) {
      await alerts.send("error", "Seed buy interrupted", "The engine restarted while the one-time seed was running. It is not retried; check the positions in Alpaca, then schedule it again from Admin if needed.", { path: "/admin" })
    }

    await this.refreshSession().catch((e) => log.warn("market calendar unavailable", { error: errorMessage(e) }))
    await syncOrders(db.col, this.d.alpaca).catch((e) => log.warn("initial order sync failed", { error: errorMessage(e) }))
    await this.refreshAccount().catch((e) => log.warn("initial account refresh failed", { error: errorMessage(e) }))
    void this.refreshSiteData(true).catch((e) => log.warn("initial site data refresh failed", { error: errorMessage(e) }))
    this.emitStatus("startup complete")
    if (!this.d.ai.available) await alerts.send("warning", "AI disabled", "AI_GATEWAY_API_KEY is not set: the engine will monitor and protect positions but make no new decisions.")
    if (this.optionsLevel !== null && this.optionsLevel < 3 && this.d.settings.current.options.allow_spreads) {
      await alerts.send("warning", "Options spreads need level 3", `The Alpaca account's options level is ${this.optionsLevel}; debit spreads will be rejected. Raise it in the Alpaca dashboard or turn spreads off in Admin → Settings.`)
    }

    const onError = (job: string) => (error: unknown) => log.warn(`${job} failed`, { error: errorMessage(error) })
    this.stops.push(every(5_000, () => this.writeHeartbeat(), onError("heartbeat"), { immediate: true }))
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
    this.optionsLevel = account.options_trading_level ?? account.options_approved_level ?? null
    const stocks = positions.filter((p) => (p.asset_class ?? "us_equity") === "us_equity")
    this.heldSymbols = stocks.map((p) => p.symbol)
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
    this.plan = await planPhase(this.d.db.col, settings, session, now)
    if (this.cycle) return
    for (const run of await failMissedSeeds(this.d.db.col, seedDeadline(session, settings.schedule.close_window_minutes), now)) {
      await this.d.alerts.send("error", "Seed buy missed", `${run.error}. Nothing was bought; schedule it again from Admin if you still want it.`, { path: "/admin" })
      this.d.bus.emit("seed.completed", { seed_id: run._id, cycle_id: null, status: "failed", allocations: [], executed: 0, error: run.error }, { summary: "One-time seed missed", level: "warn" })
    }
    const st = this.d.state.state
    if (st.status !== "running" || st.kill_switch.engaged) return
    // The one-time seed runs only in the regular session, after the opening buffer and before the closing window.
    const sch = settings.schedule
    if (isSessionOpen(session, now) && -minutesBetween(now, session.open!) >= sch.open_buffer_minutes && minutesBetween(now, session.close!) > sch.close_window_minutes) {
      const seed = await claimDueSeed(this.d.db.col, now)
      if (seed) return this.startCycle("intraday", session, "seed", { kind: "seed", seed })
    }
    // News events go before scheduled intraday cycles (the planner's other phases still come first).
    if ((!this.plan.phase || this.plan.phase === "intraday") && this.drainEvents()) return
    if (this.plan.phase) return this.startCycle(this.plan.phase, session, "schedule", { kind: "scheduled" })

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
    for (const symbol of new Set([...this.heldSymbols, ...underlyings])) {
      const price = this.d.prices.fresh(symbol, 5 * MIN)
      if (price !== null) this.reference.set(symbol, price)
    }
  }

  private startCycle(
    phase: Phase,
    session: Session,
    trigger: string,
    { kind, requested = [], seed, events = [] }: { kind: CycleKind; requested?: string[]; seed?: SeedRunDoc; events?: (EventFocus & { queued_at: number })[] },
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
        // Event-cycle latency: how long each trigger waited, and which cycle served it.
        for (const e of events) {
          await this.d.db.col.wireTriggers.updateOne({ _id: e.trigger_id }, { $set: { cycle_id: r.cycleId, queue_wait_ms: startedAt - e.queued_at } }).catch(() => undefined)
        }
      })
      .catch(async (error) => {
        this.d.log.error("cycle crashed", { error: errorMessage(error) })
        await this.d.alerts.send("error", "Cycle crashed", errorMessage(error))
        if (seed) await this.failSeed(seed, `crashed: ${errorMessage(error)}`, null).catch(() => undefined)
      })
      .finally(() => {
        this.cycle = null
        this.currentPhase = null
        this.ctx.setCycleState("idle")
        // Triggers that arrived meanwhile run now.
        this.drainEvents()
      })
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
  requestEventCycle(focus: EventFocus): "fired" | "queued" {
    const key = focus.symbol ?? "MARKET"
    const prev = this.eventQueue.get(key)
    if (!prev || focus.severity >= prev.severity) {
      this.eventQueue.set(key, { ...focus, item_ids: [...new Set([...(prev?.item_ids ?? []), ...focus.item_ids])], queued_at: prev?.queued_at ?? Date.now() })
    } else {
      prev.item_ids = [...new Set([...prev.item_ids, ...focus.item_ids])]
    }
    return this.drainEvents() ? "fired" : "queued"
  }

  /** Starts the queued event cycle if it can run now. Returns whether one started. */
  private drainEvents(): boolean {
    this.expireEvents()
    if (this.cycle || !this.eventQueue.size || !this.session) return false
    const st = this.d.state.state
    if (st.status !== "running" || st.kill_switch.engaged) return false
    // Off-hours, the queue simply waits (and expires): the next phase's dossier carries the items anyway.
    if (!this.eventWindow().open) return false
    const wait = this.lastEventCycleAt + this.d.settings.current.wire.event_min_gap_seconds * 1000 - Date.now()
    if (wait > 0) {
      if (!this.eventTimer) {
        this.eventTimer = setTimeout(() => {
          this.eventTimer = null
          this.drainEvents()
        }, wait)
        this.eventTimer.unref()
      }
      return false
    }
    const events = [...this.eventQueue.values()]
    this.eventQueue.clear()
    this.lastEventCycleAt = Date.now()
    const label = events.map((e) => `${e.rule.replace(/_/g, " ")} ${e.symbol ?? "market"}`).join(", ")
    this.startCycle("intraday", this.session, `event: ${label}`, { kind: "event", events, requested: events.map((e) => e.symbol).filter((s): s is string => !!s) })
    return true
  }

  /** Drops triggers that waited too long (say, queued just before the bell): stale news never starts a cycle. */
  private expireEvents(now = Date.now()) {
    for (const [key, e] of this.eventQueue) {
      if (now - e.queued_at <= EVENT_QUEUE_MAX_MS) continue
      this.eventQueue.delete(key)
      const reason = `expired: waited ${Math.round((now - e.queued_at) / MIN)} min in the queue`
      void this.d.db.col.wireTriggers.updateOne({ _id: e.trigger_id }, { $set: { status: "suppressed", reason } }).catch(() => undefined)
      this.d.log.info("event trigger expired", { symbol: e.symbol, rule: e.rule, reason })
    }
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
      return this.failSeed(run, why, r.cycleId, result)
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

  private async failSeed(run: SeedRunDoc, error: string, cycleId: string | null, result: SeedRunDoc["result"] = null) {
    await finishSeed(this.d.db.col, run._id, { status: "failed", cycle_id: cycleId, result, error })
    this.d.bus.emit("seed.completed", { seed_id: run._id, cycle_id: cycleId, status: "failed", allocations: result?.allocations.map(({ thesis: _t, ...a }) => a) ?? [], executed: 0, error }, { summary: `One-time seed failed: ${error}`, level: "warn" })
    await this.d.alerts.send("error", "Seed buy failed", `${error}. It is not retried; schedule it again from Admin if you still want it.`, { path: "/admin" })
  }

  // ─── Maintenance, options, site data ─────────────────────────────────────

  private async periodicMaintenance() {
    const session = this.session
    if (!session) return
    const now = new Date()
    const near = this.nearSession(session, now)
    if (Date.now() - this.lastMaintenance < (near ? MIN : 15 * MIN)) return
    this.lastMaintenance = Date.now()
    // While a cycle is trading, only sync: re-protecting a stock the cycle is selling would fight
    // it for the shares. The cycle checks protection itself before it finishes.
    if (this.cycle) {
      await syncOrders(this.d.db.col, this.d.alpaca)
      return
    }
    const notes = await maintain(this.ctx, session, {
      now,
      closeCycleDone: async () => (await this.d.db.col.cycles.countDocuments({ trading_day: session.day, phase: "close", status: { $in: ["succeeded", "running"] } })) > 0,
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

  // ─── Heartbeat ───────────────────────────────────────────────────────────

  private async writeHeartbeat() {
    const { db, bus, budget, settings, env, stream, tradeStream, marketStream, prices } = this.d
    const status = await budget.status().catch(() => null)
    const lastAi = await db.col.aiCalls.findOne({}, { sort: { at: -1 } }).catch(() => null)
    const errors = await db.col.events.countDocuments({ level: "error", ts: { $gte: new Date(Date.now() - 3_600_000).toISOString() } }).catch(() => 0)
    this.triggersToday = await this.policy.triggersToday().catch(() => this.triggersToday)
    const s = settings.current
    const now = Date.now()
    const doc: EngineStatusDoc = {
      _id: "engine",
      at: new Date(),
      instance: env.ENGINE_INSTANCE,
      version: ENGINE_VERSION,
      started_at: this.startedAt,
      status: this.status,
      cycle_state: this.cycleState,
      current_task: this.currentTask,
      current_phase: this.currentPhase,
      kill_switch: this.d.state.state.kill_switch.engaged,
      ws_clients: stream.clientCount,
      event_seq: bus.lastSeq,
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
        .map((p) => ({ symbol: p.symbol, price: p.price, change_pct: p.change_pct, age_s: Math.round((now - p.at) / 1000) }))
        .sort((a, b) => a.symbol.localeCompare(b.symbol)),
      ai: {
        models: s.ai.models,
        spend_today_usd: roundTo(status?.spent_usd ?? 0, 4),
        budget_usd: s.ai.daily_budget_usd,
        calls_today: status?.calls ?? 0,
        last_call_at: lastAi?.at ?? null,
        last_error: lastAi && !lastAi.ok ? lastAi.error : null,
        enabled: this.d.ai.available,
      },
      system: this.sampler.sample(),
      last_cycle: this.lastCycle,
      errors_last_hour: errors,
      wire: this.d.wire.health({ triggers_today: this.triggersToday, event_queue: [...this.eventQueue.keys()] }),
    }
    await db.col.engineStatus.replaceOne({ _id: "engine" }, doc, { upsert: true })
    if (Math.floor(Date.now() / 5_000) % 3 === 0) {
      bus.emit(
        "engine.heartbeat",
        { status: this.status, cycle_state: this.cycleState, ws_clients: stream.clientCount, uptime_s: doc.system.uptime_s, ai_spend_today_usd: doc.ai.spend_today_usd, ai_budget_usd: doc.ai.budget_usd },
        { summary: `Engine ${this.status}, ${this.cycleState}`, level: "debug" },
      )
    }
  }

  // ─── Commands ────────────────────────────────────────────────────────────

  private async engageKillSwitch(reason: string, by: string, liquidate: boolean) {
    await this.d.state.update({ status: "halted", kill_switch: { engaged: true, reason, at: new Date(), by, liquidate } }, by, "kill_switch.engage", { reason })
    this.emitStatus(reason)
    const notes = liquidate ? [...(await liquidateOptions(this.ctx, "kill_switch")), ...(await flattenStocks(this.ctx, " (kill switch)"))] : []
    await this.d.alerts.send("critical", "Kill switch engaged", `${reason}${notes.length ? `\nLiquidation: ${notes.join("; ")}` : ""}`)
    return notes
  }

  private async handleCommand(command: Command, doc: CommandDoc): Promise<string> {
    const { state, settings, alpaca, db } = this.d
    const by = doc.created_by
    switch (command.type) {
      case "pause":
        await state.update({ status: "paused", pause_reason: command.reason ?? null }, by, "pause")
        this.emitStatus(command.reason ?? "paused from the dashboard")
        return "paused: no new cycles or entries; stops, targets and options exits stay active"
      case "resume":
        if (state.state.kill_switch.engaged) throw new Error("the kill switch is engaged; release it first")
        await state.update({ status: "running", pause_reason: null }, by, "resume")
        this.emitStatus("resumed from the dashboard")
        return "running"
      case "kill_switch.engage": {
        const notes = await this.engageKillSwitch(command.reason, by, command.liquidate)
        return command.liquidate ? `halted and liquidated: ${notes.join("; ") || "no positions"}` : "halted: no new orders; stops, targets and options exits stay active"
      }
      case "kill_switch.release":
        // Releasing never resumes trading by itself: the owner resumes explicitly.
        await state.update({ status: "paused", kill_switch: { engaged: false, reason: null, at: null, by: null, liquidate: false } }, by, "kill_switch.release")
        this.emitStatus("kill switch released; paused until resumed")
        return "kill switch released; engine paused until you resume"
      case "settings.update": {
        const res = await settings.apply(command.patch as SettingsPatch, by, command.expected_version)
        if (!res.ok) throw new Error(res.error)
        return res.changes ? `${res.changes} setting${res.changes > 1 ? "s" : ""} updated (v${settings.version})` : "no changes"
      }
      case "cycle.run_now": {
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
        const order = await alpaca.submitOrder({ symbol: command.symbol, qty: position.qty, side: "sell", type: "market", time_in_force: "day", client_order_id: clientId("manual") })
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
      case "seed.schedule": {
        const run = await scheduleSeed(db.col, command, by)
        return `one-time seed of ${usdText(run.amount_usd)} scheduled for ${run.at.toISOString()}${run.force ? " (forced)" : ""}; it runs in the regular session, after the opening buffer`
      }
      case "wire.replay": {
        const item = await db.col.wireItems.findOne({ _id: command.item_id })
        if (!item) throw new Error("no wire item with that id")
        return `${item.title.slice(0, 120)} (severity ${item.severity}): ${await this.policy.replay(item)}`
      }
      case "seed.cancel": {
        const run = await cancelSeed(db.col)
        return `seed scheduled for ${run.at.toISOString()} canceled`
      }
    }
  }

  async shutdown(reason: string) {
    const { bus, log } = this.d
    if (this.status === "stopping") return
    this.status = "stopping"
    log.info("engine shutting down", { reason })
    bus.emit("engine.stopping", { reason }, { summary: `Engine stopping (${reason})`, level: "warn" })
    this.commands.shutdown()
    for (const stop of this.stops) stop()
    this.d.tradeStream.stop()
    this.d.marketStream.stop()
    this.d.wire.stop()
    if (this.eventTimer) clearTimeout(this.eventTimer)
    if (this.accountRefresh) clearTimeout(this.accountRefresh)
    // Abort in-flight AI calls; an order already sent to the broker still completes.
    this.abort.abort()
    if (this.cycle) await withTimeout(this.cycle, 20_000, "cycle shutdown").catch(() => undefined)
    await this.writeHeartbeat().catch(() => undefined)
  }
}
