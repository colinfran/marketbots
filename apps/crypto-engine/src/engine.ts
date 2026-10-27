import { randomUUID } from "node:crypto"
import type { Command } from "@mb/crypto-core/commands"
import type { CommandDoc, EngineStatusDoc, PaperWalletHealth, SeedRunDoc } from "@mb/crypto-core/db"
import type { CycleState, EngineRunStatus } from "@mb/crypto-core/events"
import { roundTo } from "@mb/crypto-core/math"
import type { SettingsPatch } from "@mb/crypto-core/settings"
import { ResourceSampler } from "@mb/engine-kit/heartbeat"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { cancelSeed, claimDueSeed, failInterruptedSeeds, failMissedSeeds, finishSeed, scheduleSeed } from "@mb/engine-kit/state/seed-runs"
import { every, withTimeout } from "@mb/engine-kit/util/async"
import type { AiBudget } from "./ai/budget"
import type { AiRunner } from "./ai/runner"
import type { Alerts } from "./alerts"
import { runBacktest } from "./backtest/run"
import type { EventBus } from "./bus/event-bus"
import { CommandProcessor } from "./commands/processor"
import type { Database } from "./db/mongo"
import type { Env } from "./env"
import type { Executor } from "./execution/executor"
import type { CandleCache } from "./market/candles"
import type { MarketHub } from "./market/hub"
import type { EngineContext } from "./orchestrator/context"
import { runCryptoCycle, type CycleRequest } from "./orchestrator/crypto-cycle"
import type { EventFocus } from "@mb/crypto-core/wire"
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
import { coverageGaps } from "./wire/calendar"
import type { Wire } from "./wire/wire"

export const ENGINE_VERSION = "0.1.0"

/** A seed that couldn't start within this long of its time (engine down or paused) is failed, not run late. */
const SEED_MAX_LATE_MINUTES = 120

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
  ai: AiRunner
  budget: AiBudget
  alerts: Alerts
  stream: StreamServer
  wire: Wire
}

/**
 * The always-on engine. Owns the run state and every periodic job:
 *
 *   every 3s   position protection (stops / targets), regardless of pause or AI state
 *   every 15s  mark-to-market and the drawdown halt
 *   every 30s  the cycle scheduler (scheduled scans + triggered reviews)
 *   every 5s   heartbeat to MongoDB (the dashboard's Admin page)
 *   every 5m   portfolio snapshot and paper-wallet reconciliation
 *   every 30m  scoring of decisions whose horizon has passed
 *   every 1s   dashboard commands
 *
 * It never depends on the dashboard being open, and on restart it reconciles with the paper
 * wallet before allowing new entries.
 */
export class Engine {
  status: EngineRunStatus = "starting"
  cycleState: CycleState = "idle"
  currentTask: string | null = null
  reconciliation: (ReconcileResult & { at: Date }) | null = null
  wallet: PaperWalletHealth
  readonly ctx: EngineContext

  private readonly startedAt = new Date()
  private readonly abort = new AbortController()
  private readonly sampler = new ResourceSampler()
  private readonly protectionInFlight = new Set<string>()
  private readonly triggerCooldown = new Map<string, number>()
  private stops: (() => void)[] = []
  private commands: CommandProcessor
  private cycle: Promise<unknown> | null = null
  private lastCycleStartedAt = 0
  private lastAiCycleAt = 0
  private lastCycle: EngineStatusDoc["last_cycle"] = null
  private lastSummaryAt = 0
  private heldSymbols: string[] = []
  /** Candidates of the latest cycle and owner-requested pairs (the news engine's "focus"). */
  private focusSymbols: string[] = []
  /** News-engine event cycles waiting to run, merged by symbol ("MARKET" for market-wide), highest severity kept. */
  private readonly eventQueue = new Map<string, EventFocus & { queued_at: number }>()
  private lastEventCycleAt = 0
  private eventTimer: NodeJS.Timeout | null = null
  private triggersToday = 0
  readonly policy: WirePolicy

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
      ai: d.ai,
      budget: d.budget,
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
    this.commands = new CommandProcessor(d.db.col, d.bus, d.log.child({ component: "commands" }), (c, doc) => this.handleCommand(c, doc))
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
      budget: d.budget,
      request: (focus) => this.requestEventCycle(focus),
      markNotable: (ids, reason) => d.wire.markNotable(ids, reason),
      emergency: (symbol) => this.emergencyAction(symbol),
      alert: (title, message) => d.alerts.send("warning", title, message, { path: "/research" }),
    })
    d.wire.onItem((e) => this.policy.onItem(e))
  }

  /**
   * A news-engine trigger asks for a focused cycle. It starts at once when nothing is running and
   * the minimum gap since the last event cycle has passed; otherwise it waits, merged by symbol
   * (highest severity kept), and runs the moment the current cycle ends.
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
    if (this.cycle || !this.eventQueue.size) return false
    const { state, settings } = this.d
    if (state.state.status !== "running" || state.state.kill_switch.engaged) return false
    const wait = this.lastEventCycleAt + settings.current.wire.event_min_gap_seconds * 1000 - Date.now()
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
    this.runCycle({ kind: "event", trigger: `event: ${label}`, events: events.map(({ queued_at: _q, ...e }) => e) }, events)
    return true
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

  /** Symbol sets the news engine tags and ranks items against. */
  wireSymbols() {
    return { universe: this.d.hub.universe, held: this.heldSymbols, focus: this.focusSymbols }
  }

  /** The macro calendar file needs regenerating before any kind runs out of dates. */
  private async checkCalendar() {
    const gaps = coverageGaps(new Date())
    if (gaps.length) await this.d.alerts.send("info", "Macro calendar running out", `Regenerate apps/crypto-engine/src/wire/macro-calendar.json: ${gaps.join("; ")}.`, { key: `calendar|${gaps.join(",")}` })
  }

  get ready() {
    return this.status === "running" || this.status === "paused" || this.status === "halted"
  }

  private setCycleState(state: CycleState, detail?: string) {
    this.cycleState = state
    this.currentTask = detail ?? null
  }

  private emitStatus(reason?: string) {
    const s = this.d.state.state
    this.status = s.kill_switch.engaged ? "halted" : s.status
    this.d.bus.emit("engine.status", { status: this.status, kill_switch: s.kill_switch.engaged, reason }, { summary: `Engine ${this.status}${reason ? `: ${reason}` : ""}` })
  }

  async start() {
    const { bus, log, env } = this.d
    bus.emit("engine.started", { version: ENGINE_VERSION, instance: env.ENGINE_INSTANCE }, { summary: `Engine ${ENGINE_VERSION} started on ${env.ENGINE_INSTANCE}` })
    await this.initWallet()
    this.status = "reconciling"
    await this.reconcile()
    // A cycle left "running" belonged to a previous process that stopped mid-way.
    const stale = await this.d.db.col.cycles.updateMany({ status: "running" }, { $set: { status: "failed", state: "idle", finished_at: new Date(), error: "the engine restarted during this cycle" } })
    if (stale.modifiedCount) log.warn("marked interrupted cycles as failed", { count: stale.modifiedCount })
    if (await failInterruptedSeeds(this.d.db.col)) {
      await this.d.alerts.send("error", "Seed buy interrupted", "The engine restarted while the one-time seed was running. It is not retried; check Holdings, then schedule it again from Admin if needed.", { path: "/admin" })
    }
    this.emitStatus("startup complete")
    if (!this.d.ai.available) await this.d.alerts.send("warning", "AI disabled", "AI_GATEWAY_API_KEY is not set: the engine will monitor and protect positions but make no new decisions.")

    const onError = (job: string) => (error: unknown) => log.warn(`${job} failed`, { error: errorMessage(error) })
    this.stops.push(every(3_000, () => checkProtection(this.ctx, this.protectionInFlight), onError("protection")))
    this.stops.push(every(15_000, () => this.markAndMonitor(), onError("mark-to-market"), { immediate: true }))
    this.stops.push(every(30_000, () => this.schedule(), onError("scheduler")))
    this.stops.push(every(5_000, () => this.writeHeartbeat(), onError("heartbeat"), { immediate: true }))
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
      await this.engageKillSwitch(`drawdown ${dd.toFixed(2)}% reached the ${p.max_drawdown_pct}% limit`, "engine", liquidate)
    }
  }

  private async engageKillSwitch(reason: string, by: string, liquidate: boolean) {
    await this.d.state.update({ status: "halted", kill_switch: { engaged: true, reason, at: new Date(), by, liquidate } }, by, "kill_switch.engage", { reason })
    this.emitStatus(reason)
    const notes = liquidate ? await liquidateAll(this.ctx, "liquidation") : []
    await this.d.alerts.send("critical", "Kill switch engaged", `${reason}${notes.length ? `\nLiquidation: ${notes.join("; ")}` : ""}`)
    return notes
  }

  /**
   * Decides whether a cycle is due: the owner's one-time seed when its time comes, else on
   * schedule, or triggered by a held position moving sharply.
   */
  private async schedule() {
    if (this.cycle) return
    const { settings, state, db } = this.d
    for (const run of await failMissedSeeds(db.col, (r) => new Date(r.at.getTime() + SEED_MAX_LATE_MINUTES * 60_000))) {
      await this.d.alerts.send("error", "Seed buy missed", `${run.error}. Nothing was bought; schedule it again from Admin if you still want it.`, { path: "/admin" })
      this.d.bus.emit("seed.completed", { seed_id: run._id, cycle_id: null, status: "failed", allocations: [], executed: 0, error: run.error }, { summary: "One-time seed missed", level: "warn" })
    }
    if (state.state.status !== "running" || state.state.kill_switch.engaged) return
    const seed = await claimDueSeed(db.col)
    if (seed) return this.runSeed(seed)
    // News events go before scheduled scans.
    if (this.drainEvents()) return
    const s = settings.current.schedule
    const now = Date.now()
    if (now - this.lastAiCycleAt < s.min_ai_interval_minutes * 60_000) return
    const due = now - this.lastCycleStartedAt >= s.crypto_scan_minutes * 60_000
    const triggered = new Set<string>()
    for (const p of await this.d.ledger.openPositions()) {
      const q = this.d.hub.quote(p.symbol)
      const ref = p.last_review_price ?? p.avg_price
      if (!q || !ref) continue
      const cooled = now - (this.triggerCooldown.get(p.symbol) ?? 0) >= s.trigger_cooldown_minutes * 60_000
      // ATR isn't known between cycles; a 3% move since the last review is a conservative proxy trigger.
      if (cooled && Math.abs(q.mid / ref - 1) >= 0.03) triggered.add(p.symbol)
    }
    if (!due && !triggered.size) return
    for (const sym of triggered) this.triggerCooldown.set(sym, now)
    this.runCycle(due ? { kind: "scheduled", trigger: "scheduled" } : { kind: "price_move", trigger: `price move on ${[...triggered].join(", ")}`, forcedReviews: triggered })
  }

  /** The one-time seed: a single attempt, recorded on the run whatever happens. */
  private runSeed(run: SeedRunDoc) {
    const { db, alerts, bus, log } = this.d
    const fail = async (error: string, cycleId: string | null, result: SeedRunDoc["result"] = null) => {
      await finishSeed(db.col, run._id, { status: "failed", cycle_id: cycleId, result, error })
      bus.emit("seed.completed", { seed_id: run._id, cycle_id: cycleId, status: "failed", allocations: result?.allocations.map(({ thesis: _t, ...a }) => a) ?? [], executed: 0, error }, { summary: `One-time seed failed: ${error}`, level: "warn" })
      await alerts.send("error", "Seed buy failed", `${error}. It is not retried; schedule it again from Admin if you still want it.`, { path: cycleId ? `/research/${cycleId}` : "/admin" })
    }
    this.cycle = runCryptoCycle(this.ctx, { kind: "seed", trigger: "seed", seed: { id: run._id, amountUsd: run.amount_usd } })
      .then(async (r) => {
        this.lastCycle = { id: r.cycleId, at: new Date(), status: r.status, summary: r.summary }
        for (const [symbol, f] of r.features) this.d.hub.features.set(symbol, f)
        if (r.status !== "skipped") this.lastAiCycleAt = Date.now()
        const seed = r.seed ?? { allocations: [], orders: [], notes: [], rationale: null, executed: 0 }
        const result = { allocations: seed.allocations, orders: seed.orders, notes: seed.notes, rationale: seed.rationale }
        if (r.status !== "completed" || seed.executed === 0) {
          const reasons = seed.orders.map((o) => `${o.symbol}: ${o.reason ?? o.status}`)
          return fail(r.status === "completed" ? `no buy went through (${reasons.join("; ") || "nothing allocated"})` : r.summary, r.cycleId, result)
        }
        await finishSeed(db.col, run._id, { status: "done", cycle_id: r.cycleId, result, error: null })
        bus.emit(
          "seed.completed",
          { seed_id: run._id, cycle_id: r.cycleId, status: "done", allocations: seed.allocations.map(({ thesis: _t, ...a }) => a), executed: seed.executed, error: null },
          { summary: `One-time seed done: ${seed.allocations.map((a) => `${a.symbol} ${a.weight_pct}%`).join(", ")}` },
        )
        const fields = Object.fromEntries(seed.orders.map((o) => [o.symbol, `${o.status}${o.notional_usd ? ` · $${o.notional_usd.toFixed(2)}` : ""}${o.status === "filled" || !o.reason ? "" : ` (${o.reason})`}`]))
        await alerts.success("One-time seed done", `[paper] ${seed.rationale ?? ""}`.slice(0, 1_500), { path: `/research/${r.cycleId}`, key: `seed|${run._id}`, fields: { Amount: `$${run.amount_usd.toLocaleString("en-US")}`, ...fields } })
      })
      .catch(async (error) => {
        log.error("seed cycle crashed", { error: errorMessage(error) })
        await fail(`crashed: ${errorMessage(error)}`, null).catch(() => undefined)
      })
      .finally(() => {
        this.cycle = null
        this.setCycleState("idle")
        this.drainEvents()
      })
  }

  private runCycle(request: CycleRequest, queued: (EventFocus & { queued_at: number })[] = []) {
    const startedAt = Date.now()
    // Event cycles don't move the scheduled scan's clock.
    if (request.kind !== "event") this.lastCycleStartedAt = startedAt
    this.cycle = runCryptoCycle(this.ctx, request)
      .then(async (r) => {
        this.lastCycle = { id: r.cycleId, at: new Date(), status: r.status, summary: r.summary }
        for (const [symbol, f] of r.features) this.d.hub.features.set(symbol, f)
        if (r.candidates) this.focusSymbols = [...new Set([...r.candidates, ...(request.requested ?? [])])]
        // Only cycles that reached the AI count toward the minimum gap between AI cycles.
        if (r.status !== "skipped" && !r.summary.startsWith("idle")) this.lastAiCycleAt = Date.now()
        // Event-cycle latency: how long each trigger waited, and which cycle served it.
        for (const e of queued) {
          await this.d.db.col.wireTriggers.updateOne({ _id: e.trigger_id }, { $set: { cycle_id: r.cycleId, queue_wait_ms: startedAt - e.queued_at } }).catch(() => undefined)
        }
      })
      .catch(async (error) => {
        this.d.log.error("cycle crashed", { error: errorMessage(error) })
        await this.d.alerts.send("error", "Decision cycle crashed", errorMessage(error))
      })
      .finally(() => {
        this.cycle = null
        this.setCycleState("idle")
        // Triggers that arrived meanwhile run now.
        this.drainEvents()
      })
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

  private async writeHeartbeat() {
    const { db, bus, hub, budget, settings, env, stream } = this.d
    const status = await budget.status().catch(() => null)
    const lastAi = await db.col.aiCalls.findOne({}, { sort: { at: -1 } }).catch(() => null)
    const errors = await db.col.events.countDocuments({ level: "error", ts: { $gte: new Date(Date.now() - 3_600_000).toISOString() } }).catch(() => 0)
    this.triggersToday = await this.policy.triggersToday().catch(() => this.triggersToday)
    const s = settings.current
    const doc: EngineStatusDoc = {
      _id: "engine",
      at: new Date(),
      instance: env.ENGINE_INSTANCE,
      version: ENGINE_VERSION,
      started_at: this.startedAt,
      status: this.status,
      cycle_state: this.cycleState,
      current_task: this.currentTask,
      kill_switch: this.d.state.state.kill_switch.engaged,
      ws_clients: stream.clientCount,
      event_seq: bus.lastSeq,
      kraken: hub.health(),
      paper_wallet: this.wallet,
      symbols: hub.symbolHealth(),
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
      next_cycle_at: this.lastCycleStartedAt ? new Date(this.lastCycleStartedAt + s.schedule.crypto_scan_minutes * 60_000) : new Date(),
      reconciliation: this.reconciliation ? { ok: this.reconciliation.ok, at: this.reconciliation.at, issues: this.reconciliation.issues.slice(0, 20) } : null,
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

  private async handleCommand(command: Command, doc: CommandDoc): Promise<string> {
    const { state, settings, ledger, cli, bus } = this.d
    const by = doc.created_by
    switch (command.type) {
      case "pause":
        await state.update({ status: "paused", pause_reason: command.reason ?? null }, by, "pause")
        this.emitStatus(command.reason ?? "paused from the dashboard")
        return "paused: no new decisions or entries; stops and targets stay active"
      case "resume":
        if (state.state.kill_switch.engaged) throw new Error("the kill switch is engaged; release it first")
        await state.update({ status: "running", pause_reason: null }, by, "resume")
        this.emitStatus("resumed from the dashboard")
        return "running"
      case "kill_switch.engage": {
        const notes = await this.engageKillSwitch(command.reason, by, command.liquidate)
        return command.liquidate ? `halted and liquidated: ${notes.join("; ") || "no positions"}` : "halted: no new orders; stops and targets stay active"
      }
      case "kill_switch.release":
        // Releasing never resumes trading by itself: the owner resumes explicitly.
        await state.update({ status: "paused", kill_switch: { engaged: false, reason: null, at: null, by: null, liquidate: false } }, by, "kill_switch.release")
        this.emitStatus("kill switch released; paused until resumed")
        return "kill switch released; engine paused until you resume"
      case "strategy.set_enabled": {
        const res = await settings.apply({ strategies: { [command.strategy]: { enabled: command.enabled } } } as SettingsPatch, by, null)
        if (!res.ok) throw new Error(res.error)
        return `${command.strategy} ${command.enabled ? "enabled" : "disabled"}`
      }
      case "settings.update": {
        const res = await settings.apply(command.patch as SettingsPatch, by, command.expected_version)
        if (!res.ok) throw new Error(res.error)
        return res.changes ? `${res.changes} setting${res.changes > 1 ? "s" : ""} updated (v${settings.version})` : "no changes"
      }
      case "cycle.run_now":
        if (this.cycle) throw new Error("a cycle is already running")
        if (state.state.status !== "running" || state.state.kill_switch.engaged) throw new Error(`engine is ${this.status}`)
        this.runCycle({ kind: "manual", trigger: command.symbols?.length ? `manual: evaluate ${command.symbols.join(", ")}` : "manual", requested: command.symbols ?? [] })
        return command.symbols?.length ? `cycle started; the AI will evaluate ${command.symbols.join(", ")}` : "cycle started"
      case "position.close": {
        const position = await this.d.db.col.positions.findOne({ _id: command.position_id, status: "open" })
        if (!position) throw new Error("no open position with that id")
        const report = await exitPosition(this.ctx, position, { purpose: "manual_close", market: true })
        if (!report) throw new Error("exit could not be placed")
        return `${report.order.status}: sold ${report.order.filled_qty} ${position.symbol}`
      }
      case "paper.reset": {
        if (this.cycle) throw new Error("a cycle is running; try again in a minute")
        const s = settings.current
        const config = { capital: s.paper.starting_usd, feeRate: s.kraken.taker_fee_bps / 10_000, slippageRate: s.kraken.paper_slippage_bps / 10_000 }
        await cli.reset(config)
        await ledger.resetPaper(s.paper.starting_usd)
        await this.initWallet()
        await this.reconcile()
        return `paper wallet reset to $${s.paper.starting_usd.toLocaleString("en-US")} (fee ${s.kraken.taker_fee_bps} bps, slippage ${s.kraken.paper_slippage_bps} bps)`
      }
      case "backtest.run": {
        const id = randomUUID()
        void runBacktest({ col: this.d.db.col, rest: this.d.rest, pairs: this.d.hub.pairs, settings: settings.current, dataDir: this.d.env.BACKTEST_DATA_DIR, params: command.params, id }).then((r) =>
          bus.emit(
            "backtest.completed",
            { backtest_id: r._id, total_return_pct: r.metrics?.total_return_pct ?? null, sharpe: r.metrics?.sharpe ?? null, max_drawdown_pct: r.metrics?.max_drawdown_pct ?? null },
            { summary: r.status === "completed" ? `Backtest done: ${r.metrics?.total_return_pct ?? "n/a"}% return` : `Backtest failed: ${r.error}` },
          ),
        )
        return `backtest ${id.slice(0, 8)} started`
      }
      case "seed.schedule": {
        const run = await scheduleSeed(this.d.db.col, command, by)
        return `one-time seed of $${run.amount_usd.toLocaleString("en-US")} scheduled for ${run.at.toISOString()}${run.force ? " (forced)" : ""}`
      }
      case "wire.replay": {
        const item = await this.d.db.col.wireItems.findOne({ _id: command.item_id })
        if (!item) throw new Error("no wire item with that id")
        return `${item.title.slice(0, 120)} (severity ${item.severity}): ${await this.policy.replay(item)}`
      }
      case "seed.cancel": {
        const run = await cancelSeed(this.d.db.col)
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
    this.d.wire.stop()
    if (this.eventTimer) clearTimeout(this.eventTimer)
    for (const stop of this.stops) stop()
    // Abort in-flight AI calls; an order already handed to the wallet still completes.
    this.abort.abort()
    if (this.cycle) await withTimeout(this.cycle, 20_000, "cycle shutdown").catch(() => undefined)
    await this.writeHeartbeat().catch(() => undefined)
  }
}
