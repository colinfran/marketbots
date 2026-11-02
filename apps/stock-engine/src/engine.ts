import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { ModelCalls } from "@mb/engine-kit/ai/monitor"
import type { LocalResearch } from "@mb/wire/research/local"
import { ControlPlane, type ControlWording } from "@mb/engine-kit/control/plane"
import { StatusReporter } from "@mb/engine-kit/control/status"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { every, withTimeout } from "@mb/engine-kit/util/async"
import type { AlpacaAccount, AlpacaPosition, TradeUpdate } from "@mb/stock-core/alpaca"
import type { Command } from "@mb/stock-core/commands"
import type { CommandDoc, EngineStatusDoc, HistoryRangeKey, MarketSessionInfo } from "@mb/stock-core/db"
import type { CycleState, EngineRunStatus } from "@mb/stock-core/events"
import { roundTo } from "@mb/stock-core/math"
import { STRATEGY_LABEL } from "@mb/stock-core/options"
import type { SettingsPatch } from "@mb/stock-core/settings"
import type { WireCategory, WireItemDoc } from "@mb/stock-core/wire"
import { marketDay, minutesBetween } from "@mb/stock-core/time"
import type { HistoryStore } from "@mb/history/store"
import { coverageGaps } from "@mb/wire/calendar"
import { createStockAgent, type StockAgent } from "./agent"
import type { Alerts } from "./alerts"
import type { Alpaca, RestHealth } from "./alpaca/client"
import type { MarketStream } from "./alpaca/market-stream"
import type { TradeStream } from "./alpaca/trade-stream"
import type { EventBus } from "./bus/event-bus"
import { CommandProcessor } from "./commands/processor"
import type { EngineContext } from "./bot/context"
import { cancelSymbolOrders } from "./bot/execute"
import { flattenStocks, maintain, recordDailyStats } from "./bot/maintenance"
import { closeOptionPosition, liquidateOptions, monitorOptions, reconcileOptions } from "./bot/options"
import { clientId, syncOrders } from "./bot/orders"
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
import { stockRules, WirePolicy } from "./wire/policy"
import type { Wire } from "./wire/wire"

export const ENGINE_VERSION = "0.1.0"

/** Stock's words in the shared control results (@mb/engine-kit/control/plane). */
const WORDING: ControlWording = {
  paused: "paused: no new entries; stops, targets and options exits stay active",
  halted: "halted: no new orders; stops, targets and options exits stay active",
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
  calls: AiCallLog
  /** The live model feed. */
  models?: ModelCalls
  /** The agent's web research; null without the search service. */
  research?: LocalResearch | null
  alerts: Alerts
  stream: StreamServer
  wire: Wire
  /** The news engine's price layers (scan universe, Yahoo, Finnhub…): told what we hold and watch; the agent reads their prices. */
  coverage: Pick<PriceCoverage, "setSymbols" | "price">
  /** The history store; absent or null while HISTORY_URL is unset. */
  history?: HistoryStore<WireCategory> | null
}

const MIN = 60_000


/**
 * The always-on engine. Owns the run state and every periodic job:
 *
 *   every 1s    dashboard commands
 *   every 5s    heartbeat to MongoDB (the dashboard's Admin page)
 *   every 15s   account snapshot for the dashboard, live-price subscriptions, the daily loss limit
 *   every 30s   the market calendar (today's session)
 *   every 60s   maintenance: order sync, stock protection, overnight rules, options reconciliation
 *   every ~15s  options exits (value stop, take profit, underlying levels, time stop)
 *   periodic    equity history and chart bars for the website
 *   every 1s    the agent (./agent): its observations, watches and the next episode
 *
 * Fills arrive instantly over Alpaca's trade_updates stream. Stocks keep their stops at the broker
 * (bracket/OCO orders), so they stay protected even if the engine is down; options exits need the
 * engine, and the most an options position can lose is what was paid.
 *
 * The parts both bots share come from @mb/engine-kit/control: the owner's controls and the run
 * status (`control`) and the heartbeat (`reporter`). The agent decides; the news engine's
 * triggers reach it through the wire policy's observe hook.
 */
export class Engine {
  cycleState: CycleState = "idle"
  currentTask: string | null = null
  readonly ctx: EngineContext
  readonly control: ControlPlane<EngineRunStatus, WireItemDoc>
  readonly policy: WirePolicy
  /** The agent (docs/plans/LOCAL-AI.md §8): it trades the paper account. */
  readonly agent: StockAgent

  private readonly abort = new AbortController()
  private stops: (() => void)[] = []
  private commands: CommandProcessor
  private readonly reporter: StatusReporter<EngineStatusDoc>
  private session: Session | null = null
  private wasOpen: boolean | null = null
  private rest: { state: "ok" | "degraded" | "down" | "unknown"; last_ok_at: Date | null; last_error: string | null; failures: number } = { state: "unknown", last_ok_at: null, last_error: null, failures: 0 }
  private optionsLevel: number | null = null
  private heldSymbols: string[] = []
  /** The broker's account and positions at the last refresh (every 15 s): the agent's view of the paper account. */
  private snapshot: { account: AlpacaAccount; positions: AlpacaPosition[] } | null = null
  private breadthRefreshedAt = 0
  /** Option underlyings held, and today's movers / most actives (the news engine's breadth set). */
  private underlyings: string[] = []
  private movers: string[] = []
  private nextOpen: Date | null = null
  private lastOptionsCheck = 0
  private lastMaintenance = 0
  /** The trading day whose record (the journal's day) this process last saw written. */
  private statsDay: string | null = null
  private lastHistory: Record<"intraday" | "long", number> = { intraday: 0, long: 0 }
  private lastCharts = 0
  private lastSummaryAt = 0
  private accountRefresh: NodeJS.Timeout | null = null

  constructor(private readonly d: EngineDeps) {
    this.ctx = {
      col: d.db.col,
      log: d.log,
      bus: d.bus,
      alpaca: d.alpaca,
      settings: d.settings,
      state: d.state,
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
      models: d.models,
      research: d.research ?? null,
      llmUrl: d.env.LLM_URL ?? null,
      session: () => this.session,
      layerPrice: (s, ms) => d.coverage.price(s, ms),
      snapshot: () => this.snapshot,
      pause: {
        get: () => d.state.state.agent_pause ?? null,
        // A breaker's pause takes effect before it is saved; resuming is saved first.
        set: (p, by) => d.state.update({ agent_pause: p }, by, p ? "agent.entries_paused" : "agent.entries_resumed", {}, { first: p ? "memory" : "save" }),
      },
      promotion: {
        get: () => d.state.state.agent_promotion ?? null,
        set: (p) => this.promoteAgent(p),
      },
    })
    this.commands = new CommandProcessor(d.db.col, d.bus, d.log.child({ component: "commands" }), (c, doc) => this.handleCommand(c, doc))
    d.stream.setCommands(this.commands)
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
      // The agent has already seen the trigger's candidate (observe).
      request: () => "agent",
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
      ai: { available: !!d.env.LLM_URL },
      state: d.state,
      stream: d.stream,
      wire: d.wire,
      policy: this.policy,
      instance: d.env.ENGINE_INSTANCE,
      version: ENGINE_VERSION,
      run: () => ({ status: this.status, cycle_state: this.cycleState, current_task: this.currentTask }),
      doc: (p) => {
        const { tradeStream, marketStream, prices } = this.d
        const now = Date.now()
        return {
          ...p.run,
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
          quotes: prices
            .all()
            .map((q) => ({ symbol: q.symbol, price: q.price, change_pct: q.change_pct, age_s: Math.round((now - q.at) / 1000) }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol)),
          ...p.usage,
          ...p.health,
          ...(d.history ? { history: d.history.status() } : {}),
          agent: this.agent.agent.status(),
        }
      },
      detail: ["wire"],
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

  /** The symbols the agent's active watches name. */
  private watchedSymbols() {
    return this.agent.agent.watchedSymbols()
  }

  /** What the bot watches: held stocks and option underlyings, the agent's watches and the benchmarks. */
  private watchlist() {
    return [...new Set([...this.heldSymbols, ...this.underlyings, ...this.watchedSymbols(), ...this.d.settings.current.universe.benchmarks])]
  }

  /** Symbol sets the news engine tags and ranks items against. Held includes option underlyings; the agent's watches are its focus. */
  wireSymbols() {
    const benchmarks = this.d.settings.current.universe.benchmarks
    return {
      universe: [...new Set([...benchmarks, ...this.watchlist(), ...this.movers])],
      held: [...new Set([...this.heldSymbols, ...this.underlyings])],
      focus: this.watchedSymbols(),
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

  async start() {
    const { bus, log, env, db, alerts } = this.d
    bus.emit("engine.started", { version: ENGINE_VERSION, instance: env.ENGINE_INSTANCE }, { summary: `Engine ${ENGINE_VERSION} started on ${env.ENGINE_INSTANCE}` })
    await this.upgradeDemotion().catch((e) => this.d.log.error("upgrading the agent's demotion failed", { error: errorMessage(e) }))

    await this.refreshSession().catch((e) => log.warn("market calendar unavailable", { error: errorMessage(e) }))
    await syncOrders(db.col, this.d.alpaca).catch((e) => log.warn("initial order sync failed", { error: errorMessage(e) }))
    await this.refreshAccount().catch((e) => log.warn("initial account refresh failed", { error: errorMessage(e) }))
    void this.refreshSiteData(true).catch((e) => log.warn("initial site data refresh failed", { error: errorMessage(e) }))
    this.control.emitStatus("startup complete")
    if (!env.LLM_URL) await alerts.send("warning", "AI disabled", "LLM_URL is not set: the engine will monitor and protect positions but make no new decisions.")
    if (this.optionsLevel !== null && this.optionsLevel < 3 && this.d.settings.current.options.allow_spreads) {
      await alerts.send("warning", "Options spreads need level 3", `The Alpaca account's options level is ${this.optionsLevel}; debit spreads will be rejected. Raise it in the Alpaca dashboard or turn spreads off in Admin → Settings.`)
    }

    const onError = (job: string) => (error: unknown) => log.warn(`${job} failed`, { error: errorMessage(error) })
    this.stops.push(every(10_000, () => this.reporter.write(), onError("heartbeat"), { immediate: true }))
    this.stops.push(every(15_000, () => this.refreshAccount(), onError("account refresh")))
    this.stops.push(every(30_000, () => this.refreshSession().then(() => undefined), onError("market calendar"), { immediate: true }))
    this.stops.push(every(15_000, () => this.periodicMaintenance(), onError("maintenance")))
    this.stops.push(every(5_000, () => this.watchOptions(), onError("options monitor")))
    this.stops.push(every(60_000, () => this.refreshSiteData(false), onError("site data")))
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
   * Live prices for what matters most: held stocks, option underlyings, the index ETFs, the agent's
   * watches, then the rest of the watchlist (dropped first when the stream is full).
   */
  /**
   * The live stream's symbols: what it holds, SPY and QQQ, and what the agent watches. The rest of the
   * benchmarks stay with the price layers: a full stream leaves no room for the all-symbol minute
   * bars (the setup screen), which Alpaca then refuses.
   */
  private streamSymbols() {
    return [...new Set([...this.heldSymbols, ...this.underlyings, "SPY", "QQQ", ...this.watchedSymbols()])].slice(0, this.d.settings.current.universe.stream_max_symbols)
  }

  /** What the news engine's price layers track on top of the scan universe. */
  private coverageSymbols() {
    return { held: [...this.heldSymbols, ...this.underlyings], benchmarks: this.d.settings.current.universe.benchmarks, watch: this.watchlist(), movers: this.movers, focus: this.watchedSymbols() }
  }

  private async refreshAccount() {
    const snapshot = await writeAccountSnapshot(this.ctx)
    const { account, positions } = snapshot
    this.snapshot = { account, positions }
    this.optionsLevel = account.options_trading_level ?? account.options_approved_level ?? null
    const stocks = positions.filter((p) => (p.asset_class ?? "us_equity") === "us_equity")
    this.heldSymbols = stocks.map((p) => p.symbol)
    const optionDocs = await this.d.db.col.optionPositions.find({ status: { $in: ["open", "closing"] } }, { projection: { underlying: 1 } }).toArray()
    const underlyings = optionDocs.map((d) => d.underlying)
    this.underlyings = [...new Set(underlyings)]

    this.nextOpen = snapshot.clock.next_open ? new Date(snapshot.clock.next_open) : null
    if (Date.now() - this.breadthRefreshedAt >= 5 * MIN) {
      this.breadthRefreshedAt = Date.now()
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

  // ─── News and the agent ──────────────────────────────────────────────────

  /**
   * The wire policy's session gate: the regular session, past the opening buffer, more than 3
   * minutes before the close. Outside it a trigger is suppressed (the agent still sees its
   * candidate) and bad news about a holding is alerted.
   */
  private eventWindow(now = new Date()): { open: boolean; reason: string } {
    const s = this.session
    if (!s || !isSessionOpen(s, now)) return { open: false, reason: "outside the regular session" }
    if (-minutesBetween(now, s.open!) < this.d.settings.current.schedule.open_buffer_minutes) return { open: false, reason: "inside the opening buffer" }
    if (minutesBetween(now, s.close!) <= 3) return { open: false, reason: "too close to the bell" }
    return { open: true, reason: "regular session" }
  }

  /** When the agent was turned on or its entries resumed: its time and equity, for the total-loss breaker. */
  private async promoteAgent(p: { at: Date; equity_usd: number }) {
    await this.d.state.update({ agent_promotion: p }, "engine", "agent.promoted", {})
  }

  /**
   * Before the agent-only bots a breaker dropped the agent to a "shadow" level (and stopped the
   * timed cycles). Such a drop becomes what a breaker does now: the agent on, its new entries paused
   * until the owner resumes them.
   */
  private async upgradeDemotion() {
    const { state, settings, log } = this.d
    const demotion = state.state.agent_demotion
    if (!demotion) return
    if (settings.current.agent.level === "off") {
      const r = await settings.apply({ agent: { level: "on" } } as SettingsPatch, "engine:migration", null)
      if (!r.ok) throw new Error(r.error)
    }
    await state.update({ agent_pause: demotion, agent_demotion: null }, "engine:migration", "agent.entries_paused", {})
    log.warn("the agent's earlier drop to shadow is now a pause on its entries", { reason: demotion.reason })
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

  // ─── Maintenance, options, site data ─────────────────────────────────────

  private async periodicMaintenance() {
    const session = this.session
    if (!session) return
    const now = new Date()
    const near = this.nearSession(session, now)
    if (Date.now() - this.lastMaintenance < (near ? MIN : 15 * MIN)) return
    this.lastMaintenance = Date.now()
    // While an agent episode is trading, only sync: re-protecting a stock it is selling would fight
    // it for the shares. The next pass does it after the episode.
    if (this.agent.agent.current) {
      await syncOrders(this.d.db.col, this.d.alpaca)
      return
    }
    const notes = await maintain(this.ctx, session, { now })
    if (notes.length) this.d.log.info("maintenance", { notes })
    await this.recordDay(session, now)
  }

  /** The day's record (the journal's day, with SPY's), once its session has closed: written once a day, after the postmarket delay. */
  private async recordDay(session: Session, now: Date) {
    if (!session.close || session.day === this.statsDay) return
    if (now.getTime() < session.close.getTime() + this.d.settings.current.schedule.postmarket_delay_minutes * MIN) return
    const written = await this.d.db.col.dailyStats.findOne({ _id: session.day, updated_at: { $gte: session.close } }, { projection: { _id: 1 } })
    if (!written) await recordDailyStats(this.ctx, session.day)
    this.statsDay = session.day
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

  /** Stock's own commands; the shared ones (pause, kill switch, settings, replay, the agent's) go to the control plane. */
  private async handleCommand(command: Command, doc: CommandDoc): Promise<string> {
    const { alpaca, db } = this.d
    const by = doc.created_by
    switch (command.type) {
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
    for (const stop of this.stops) stop()
    this.d.tradeStream.stop()
    this.d.marketStream.stop()
    this.d.wire.stop()
    if (this.accountRefresh) clearTimeout(this.accountRefresh)
    this.agent.agent.stop()
    // Abort in-flight AI calls; an order already sent to the broker still completes.
    this.abort.abort()
    if (this.agent.agent.current) await withTimeout(this.agent.agent.current, 20_000, "agent shutdown").catch(() => undefined)
    await this.reporter.write().catch(() => undefined)
  }
}
