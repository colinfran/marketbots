import type { Command } from "@mb/crypto-core/commands"
import type { CommandDoc, EngineStatusDoc, PaperWalletHealth } from "@mb/crypto-core/db"
import type { CycleState, EngineRunStatus } from "@mb/crypto-core/events"
import { roundTo } from "@mb/crypto-core/math"
import type { SettingsPatch } from "@mb/crypto-core/settings"
import type { WireCategory, WireItemDoc } from "@mb/crypto-core/wire"
import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { ModelCalls } from "@mb/engine-kit/ai/monitor"
import type { LocalResearch } from "@mb/wire/research/local"
import { ControlPlane, type ControlWording } from "@mb/engine-kit/control/plane"
import { StatusReporter } from "@mb/engine-kit/control/status"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { every, withTimeout } from "@mb/engine-kit/util/async"
import type { HistoryStore } from "@mb/history/store"
import { coverageGaps } from "@mb/wire/calendar"
import { createCryptoAgent, type CryptoAgent } from "./agent"
import type { Alerts } from "./alerts"
import type { EventBus } from "./bus/event-bus"
import { CommandProcessor } from "./commands/processor"
import type { Database } from "./db/mongo"
import type { Env } from "./env"
import type { Executor } from "./execution/executor"
import type { CandleCache } from "./market/candles"
import type { MarketHub } from "./market/hub"
import type { EngineContext } from "./orchestrator/context"
import { evaluateOutcomes } from "./orchestrator/outcomes"
import { checkProtection } from "./orchestrator/protection"
import { exitPosition, liquidateAll } from "./orchestrator/trading"
import type { Ledger } from "./portfolio/ledger"
import { reconcileWallet, type ReconcileResult } from "./portfolio/reconcile"
import { drawdownPct } from "./risk/engine"
import type { EngineStateStore, SettingsStore } from "./state/stores"
import type { StreamServer } from "./stream/server"
import type { KrakenCli } from "./venues/kraken/cli"
import type { KrakenRest } from "./venues/kraken/rest"
import { roundPrice } from "./venues/kraken/pairs"
import { cryptoRules, WirePolicy } from "./wire/policy"
import type { Wire } from "./wire/wire"

export const ENGINE_VERSION = "0.1.0"

/** Crypto's words in the shared control results (@mb/engine-kit/control/plane). */
const WORDING: ControlWording = {
  paused: "paused: no new decisions or entries; stops and targets stay active",
  halted: "halted: no new orders; stops and targets stay active",
}

export type EngineDeps = {
  env: Env
  log: Logger
  db: Database
  bus: EventBus
  settings: SettingsStore
  state: EngineStateStore
  hub: MarketHub
  rest: KrakenRest
  candles: CandleCache
  cli: KrakenCli
  ledger: Ledger
  executor: Executor
  calls: AiCallLog
  /** The live model feed. */
  models?: ModelCalls
  /** The agent's web research; null without the search service. */
  research?: LocalResearch | null
  alerts: Alerts
  stream: StreamServer
  wire: Wire
  /** The history store; absent or null while HISTORY_URL is unset. */
  history?: HistoryStore<WireCategory> | null
}

/**
 * The always-on engine. Owns the run state and every periodic job:
 *
 *   every 3s   position protection (stops / targets), regardless of pause or AI state
 *   every 15s  mark-to-market and the drawdown halt
 *   every 5s   heartbeat to MongoDB (the dashboard's Admin page)
 *   every 5m   portfolio snapshot and paper-wallet reconciliation
 *   every 30m  scoring of decisions whose horizon has passed
 *   every 1s   dashboard commands
 *   every 1s   the agent (./agent): its observations, watches and the next episode
 *
 * It never depends on the dashboard being open, and on restart it reconciles with the paper
 * wallet before allowing new entries.
 *
 * The parts both bots share come from @mb/engine-kit/control: the owner's controls and the run
 * status (`control`) and the heartbeat (`reporter`). The agent decides; the news engine's
 * triggers reach it through the wire policy's observe hook.
 */
export class Engine {
  cycleState: CycleState = "idle"
  currentTask: string | null = null
  reconciliation: (ReconcileResult & { at: Date }) | null = null
  wallet: PaperWalletHealth
  readonly ctx: EngineContext
  readonly control: ControlPlane<EngineRunStatus, WireItemDoc>
  readonly policy: WirePolicy
  /** The agent (docs/plans/LOCAL-AI.md §8): the only thing that decides. */
  readonly agent: CryptoAgent

  private readonly abort = new AbortController()
  private readonly protectionInFlight = new Set<string>()
  private stops: (() => void)[] = []
  private commands: CommandProcessor
  private readonly reporter: StatusReporter<EngineStatusDoc>
  private lastSummaryAt = 0
  private heldSymbols: string[] = []

  constructor(private readonly d: EngineDeps) {
    this.wallet = { ok: false, cli_version: null, workspace: d.cli.workspace, fee_bps: null, slippage_bps: null, last_error: "not initialized", last_checked_at: null }
    this.ctx = {
      col: d.db.col,
      log: d.log,
      bus: d.bus,
      settings: d.settings,
      state: d.state,
      hub: d.hub,
      candles: d.candles,
      ledger: d.ledger,
      executor: d.executor,
      alerts: d.alerts,
      gate: () => ({
        runStatus: d.state.state.status,
        killSwitch: d.state.state.kill_switch.engaged,
        venueOnline: d.hub.tradingOnline && this.wallet.ok,
        reconciled: this.reconciliation?.ok ?? false,
      }),
      feeBps: () => this.wallet.fee_bps ?? d.settings.current.kraken.taker_fee_bps,
      setCycleState: (state, detail) => this.setCycleState(state, detail),
      signal: this.abort.signal,
      wire: d.wire,
    }
    this.agent = createCryptoAgent({
      ctx: this.ctx,
      history: d.history ?? null,
      calls: d.calls,
      models: d.models,
      research: d.research ?? null,
      llmUrl: d.env.LLM_URL ?? null,
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
    d.hub.heldSymbols = () => this.heldSymbols
    this.policy = new WirePolicy({
      col: d.db.col,
      bus: d.bus,
      log: d.log.child({ component: "wire-policy" }),
      settings: () => d.settings.current,
      rules: cryptoRules,
      engine: () => ({ running: d.state.state.status === "running", killSwitch: d.state.state.kill_switch.engaged }),
      held: () => this.heldSymbols,
      universe: () => d.hub.universe,
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
      liquidate: () => liquidateAll(this.ctx, "liquidation"),
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
      doc: (p) => ({
        ...p.run,
        ...p.live,
        kraken: d.hub.health(),
        paper_wallet: this.wallet,
        symbols: d.hub.symbolHealth(),
        ...p.usage,
        reconciliation: this.reconciliation ? { ok: this.reconciliation.ok, at: this.reconciliation.at, issues: this.reconciliation.issues.slice(0, 20) } : null,
        ...p.health,
        ...(d.history ? { history: d.history.status() } : {}),
        agent: this.agent.agent.status(),
      }),
      detail: ["wire", "symbols"],
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

  /** The owner's emergency action for a held position hit by a critical, confirmed, negative event. */
  private async emergencyAction(symbol: string): Promise<string> {
    const { ledger, settings, hub } = this.d
    const position = (await ledger.openPositions()).find((p) => p.symbol === symbol)
    if (!position) return "no open position"
    const action = settings.current.wire.emergency_action
    if (action === "exit") {
      const report = await exitPosition(this.ctx, position, { purpose: "exit", market: true })
      return report ? `sold ${report.order.filled_qty} ${symbol} at market` : "exit could not be placed"
    }
    if (action === "tighten_stop") {
      const q = hub.quote(symbol)
      const pair = hub.pairs.get(symbol)
      if (!q || !pair) return "no quote; stop unchanged"
      const stop = roundPrice(pair, q.bid * (1 - settings.current.kraken.min_stop_pct / 100))
      if (position.stop_price && stop <= position.stop_price) return `stop already at ${position.stop_price}`
      await ledger.updatePosition(position._id, { stop_price: stop })
      return `stop raised ${position.stop_price ?? "none"} → ${stop}`
    }
    return "review only"
  }

  /** Symbol sets the news engine tags and ranks items against: the agent's watches are its focus. */
  wireSymbols() {
    return { universe: this.d.hub.universe, held: this.heldSymbols, focus: this.agent.agent.watchedSymbols() }
  }

  /** The macro calendar file needs regenerating before any kind runs out of dates. */
  private async checkCalendar() {
    const gaps = coverageGaps(new Date())
    if (gaps.length) await this.d.alerts.send("info", "Macro calendar running out", `Regenerate packages/wire/src/macro-calendar.json: ${gaps.join("; ")}.`, { key: `calendar|${gaps.join(",")}` })
  }

  private setCycleState(state: CycleState, detail?: string) {
    this.cycleState = state
    this.currentTask = detail ?? null
  }

  async start() {
    const { bus, log, env } = this.d
    bus.emit("engine.started", { version: ENGINE_VERSION, instance: env.ENGINE_INSTANCE }, { summary: `Engine ${ENGINE_VERSION} started on ${env.ENGINE_INSTANCE}` })
    await this.initWallet()
    this.control.status = "reconciling"
    await this.reconcile()
    await this.upgradeDemotion().catch((e) => log.error("upgrading the agent's demotion failed", { error: errorMessage(e) }))
    this.control.emitStatus("startup complete")
    if (!env.LLM_URL) await this.d.alerts.send("warning", "AI disabled", "LLM_URL is not set: the engine will monitor and protect positions but make no new decisions.")

    const onError = (job: string) => (error: unknown) => log.warn(`${job} failed`, { error: errorMessage(error) })
    this.stops.push(every(3_000, () => checkProtection(this.ctx, this.protectionInFlight), onError("protection")))
    this.stops.push(every(15_000, () => this.markAndMonitor(), onError("mark-to-market"), { immediate: true }))
    this.stops.push(every(10_000, () => this.reporter.write(), onError("heartbeat"), { immediate: true }))
    this.stops.push(every(5 * 60_000, () => this.periodic(), onError("snapshot")))
    this.stops.push(every(5 * 60_000, () => this.reconcile(), onError("reconciliation")))
    this.stops.push(every(30 * 60_000, async () => void (await evaluateOutcomes(this.ctx)), onError("outcomes"), { immediate: true }))
    this.stops.push(every(60_000, () => (this.wallet.ok ? undefined : this.initWallet()), onError("paper wallet init")))
    this.commands.start()
    this.d.settings.onChange((s) => this.d.hub.setUniverse(s.universe.kraken_symbols))
    this.d.settings.onChange(() => this.d.wire.reconcile())
    // The news engine fails open: if it can't start, trading carries on exactly as before.
    void this.d.wire.start().catch((e) => log.warn("news engine failed to start", { error: errorMessage(e) }))
    this.stops.push(every(86_400_000, () => this.checkCalendar(), onError("calendar check"), { immediate: true }))
    await this.agent.agent.start().catch((e) => log.warn("agent failed to start", { error: errorMessage(e) }))
  }

  /** Makes sure the Kraken CLI works and the paper workspace exists and matches the books. */
  private async initWallet() {
    const { cli, ledger, settings, log } = this.d
    const s = settings.current
    try {
      const version = await cli.version()
      const { account, created } = await ledger.ensureAccount(s.paper.starting_usd)
      let ws = await cli.showWorkspace()
      const config = { capital: account.starting_usd, feeRate: s.kraken.taker_fee_bps / 10_000, slippageRate: s.kraken.paper_slippage_bps / 10_000 }
      if (!ws) {
        await cli.createWorkspace(config)
        log.info("created Kraken CLI paper workspace", { workspace: cli.workspace, capital: config.capital })
        if (!created && (account.cash_usd !== account.starting_usd || (await ledger.openPositions()).length)) {
          await this.d.alerts.send("error", "Paper wallet was recreated", "The workspace was missing (lost volume?) while the books have history. Reset the paper wallet from the dashboard to start clean.")
        }
      } else if (created) {
        // Fresh books (new database) but an existing wallet: start both from the same point.
        await cli.reset(config)
        log.warn("paper workspace reset to match a fresh database", { workspace: cli.workspace })
      }
      ws = await cli.showWorkspace()
      this.wallet = {
        ok: true,
        cli_version: version,
        workspace: cli.workspace,
        fee_bps: ws ? roundTo(ws.feeRate * 10_000, 2) : null,
        slippage_bps: ws ? roundTo(ws.slippageRate * 10_000, 2) : null,
        last_error: null,
        last_checked_at: new Date(),
      }
    } catch (error) {
      this.wallet = { ...this.wallet, ok: false, last_error: errorMessage(error), last_checked_at: new Date() }
      await this.d.alerts.send("critical", "Kraken CLI paper wallet unavailable", `${errorMessage(error)}. No orders can be placed until it works.`, { key: "wallet-init" })
    }
  }

  private async reconcile() {
    if (!this.wallet.ok) return
    const before = this.reconciliation?.ok
    const result = await reconcileWallet({ col: this.d.db.col, ledger: this.d.ledger, executor: this.d.executor, cli: this.d.cli, log: this.d.log })
    this.reconciliation = { ...result, at: new Date() }
    if (result.issues.length || before !== result.ok) {
      this.d.bus.emit(
        "engine.reconciled",
        { ok: result.ok, issues: result.issues.slice(0, 20), imported: result.imported },
        { summary: result.ok ? `Books match the paper wallet${result.issues.length ? ` (${result.issues.length} items repaired)` : ""}` : "Books do not match the paper wallet; new entries blocked", level: result.ok ? "info" : "warn", visibility: "owner" },
      )
    }
    if (!result.ok && before !== false) await this.d.alerts.send("error", "Paper wallet reconciliation failed", result.issues.join("\n"), { key: "reconcile" })
  }

  private async markAndMonitor() {
    const { ledger, hub, settings, state } = this.d
    const account = await ledger.markToMarket((p) => hub.quote(p.symbol)?.mid ?? null)
    this.heldSymbols = (await ledger.openPositions()).map((p) => p.symbol)
    if (!account) return
    const dd = drawdownPct({ equityUsd: account.equity_usd, peakEquityUsd: account.peak_equity_usd, cashUsd: 0, dayStartEquityUsd: 0, positions: [], tradesToday: 0, lastExitAt: new Map() })
    const p = settings.current.portfolio
    if (dd <= -p.max_drawdown_pct && !state.state.kill_switch.engaged) {
      const liquidate = p.drawdown_action === "halt_and_liquidate"
      await this.control.engageKillSwitch(`drawdown ${dd.toFixed(2)}% reached the ${p.max_drawdown_pct}% limit`, "engine", liquidate)
    }
  }

  private async periodic() {
    await this.d.ledger.snapshot()
    if (Date.now() - this.lastSummaryAt < 3_600_000) return
    this.lastSummaryAt = Date.now()
    const a = await this.d.ledger.account()
    if (!a) return
    const positions = (await this.d.ledger.openPositions()).length
    this.d.bus.emit(
      "summary.periodic",
      {
        equity_usd: roundTo(a.equity_usd, 2),
        day_pnl_pct: a.day_start_equity_usd > 0 ? roundTo((a.equity_usd / a.day_start_equity_usd - 1) * 100, 2) : null,
        total_return_pct: a.starting_usd > 0 ? roundTo((a.equity_usd / a.starting_usd - 1) * 100, 2) : null,
        positions,
      },
      { summary: `[paper] Equity $${a.equity_usd.toFixed(2)} · ${positions} positions` },
    )
  }

  /** Crypto's own commands; the shared ones (pause, kill switch, settings, replay, the agent's) go to the control plane. */
  private async handleCommand(command: Command, doc: CommandDoc): Promise<string> {
    const { settings, ledger, cli } = this.d
    const by = doc.created_by
    switch (command.type) {
      case "strategy.set_enabled": {
        const res = await settings.apply({ strategies: { [command.strategy]: { enabled: command.enabled } } } as SettingsPatch, by, null)
        if (!res.ok) throw new Error(res.error)
        return `${command.strategy} ${command.enabled ? "enabled" : "disabled"}`
      }
      case "position.close": {
        const position = await this.d.db.col.positions.findOne({ _id: command.position_id, status: "open" })
        if (!position) throw new Error("no open position with that id")
        const report = await exitPosition(this.ctx, position, { purpose: "manual_close", market: true })
        if (!report) throw new Error("exit could not be placed")
        return `${report.order.status}: sold ${report.order.filled_qty} ${position.symbol}`
      }
      case "paper.reset": {
        if (this.agent.agent.current) throw new Error("the agent is deciding; try again in a minute")
        const s = settings.current
        const config = { capital: s.paper.starting_usd, feeRate: s.kraken.taker_fee_bps / 10_000, slippageRate: s.kraken.paper_slippage_bps / 10_000 }
        await cli.reset(config)
        await ledger.resetPaper(s.paper.starting_usd)
        await this.initWallet()
        await this.reconcile()
        return `paper wallet reset to $${s.paper.starting_usd.toLocaleString("en-US")} (fee ${s.kraken.taker_fee_bps} bps, slippage ${s.kraken.paper_slippage_bps} bps)`
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
    this.d.wire.stop()
    for (const stop of this.stops) stop()
    this.agent.agent.stop()
    // Abort in-flight AI calls; an order already handed to the wallet still completes.
    this.abort.abort()
    if (this.agent.agent.current) await withTimeout(this.agent.agent.current, 20_000, "agent shutdown").catch(() => undefined)
    await this.reporter.write().catch(() => undefined)
  }
}
