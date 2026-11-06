import { randomUUID } from "node:crypto"
import { errorMessage } from "@mb/engine-kit/log"
import { sleep } from "@mb/engine-kit/util/async"
import type { AlpacaPosition, Bar } from "@mb/stock-core/alpaca"
import type { DecisionDoc, PositionPlanDoc } from "@mb/stock-core/db"
import type { RiskCheck } from "@mb/stock-core/events"
import type { Decision } from "@mb/stock-core/report"
import { marketTime, minutesBetween } from "@mb/stock-core/time"
import { snapshotPrice } from "../market/indicators"
import { SCAN_UNIVERSE_KEY, type ScanUniverse } from "../market/scan-universe"
import type { EngineContext } from "./context"
import { coreCandidates, coreRegime, coreStats, coreTrendBroken, GEARED_NAME, type CorePick } from "./core-rules"
import { cancelSymbolOrders, placeStopOrder } from "./execute"
import { clientId, saveOrders, waitForFill } from "./orders"
import { computeRiskState } from "./risk"
import { isSessionOpen, type Session } from "./session"

/**
 * The trend core's runner (its rules: ./core-rules). Once a trading day:
 *
 *   before it acts   the day's plan from completed daily bars of the scan universe's most traded
 *                    stocks (core.universe_size) and SPY: the regime, the ranked picks, and the
 *                    core positions whose trend broke. Kept in `cache` (core:plan), so a restart
 *                    reuses it.
 *   30 min in        it sells core positions whose trend broke, then fills the free core slots
 *                    (core.max_positions) with the strongest picks it doesn't hold, skipping a stock
 *                    sold within core.reentry_hours or with negative news at review severity within
 *                    core.news_veto_hours. A buy risks core.risk_per_trade_pct of equity at its
 *                    stop (a market order, then a plain GTC stop: no target), within the position
 *                    cap and deployable cash.
 *
 * Its positions are plans with book "core": maintenance trails their stops and protects them,
 * and the overnight rules keep them. It waits while an agent episode runs, and opens nothing while
 * the drawdown breaker pauses entries, the engine is paused or the day's loss limit blocks buys.
 * core.enabled turns it off. Every attempt is a `decisions` document (trigger_kind "core").
 */

const MIN = 60_000
const HOUR = 60 * MIN
/** It acts this long after the open, once the opening swings settle… */
const ENTRY_DELAY_MIN = 30
/** …and not later than this before the close (a late restart waits for the next day). */
const LATE_MIN = 30
const BATCH = 200
/** Where the day's plan is kept in `cache`. */
export const CORE_PLAN_KEY = "core:plan"
const RETRY_MS = 30 * MIN
const INVALIDATION = "The trailing stop, or a close below the 50-day average."

export type CorePlan = { day: string; built_at: Date; regime: { on: boolean; detail: string }; picks: CorePick[]; broken: string[] }

type Outcome = Pick<DecisionDoc, "status" | "reason"> & Partial<Pick<DecisionDoc, "price" | "qty" | "notional" | "stop_loss" | "order_ids" | "checks">>

const isStock = (p: AlpacaPosition) => (p.asset_class ?? "us_equity") === "us_equity"
const floor2 = (n: number) => Math.floor(n * 100) / 100
const round2 = (n: number) => Math.round(n * 100) / 100

const request = (symbol: string, action: "buy" | "sell", rationale: string, fields: Partial<Decision> = {}): Decision => ({
  symbol,
  action,
  allocation_pct: null,
  sell_pct: null,
  stop_loss: null,
  take_profit: null,
  horizon: "multi_day",
  setup: "momentum",
  conviction: 10,
  rationale,
  evidence: [],
  invalidation: INVALIDATION,
  structure_id: null,
  option: null,
  ...fields,
})

export class StockCore {
  private plan: CorePlan | null = null
  private building = false
  private retryAt = 0
  private actedDay = ""
  /** While it is placing orders: maintenance waits, so it never protects shares the core is protecting. */
  acting = false

  constructor(
    private readonly ctx: EngineContext,
    private readonly d: {
      session: () => Session | null
      /** Why new entries are paused (the agent's drawdown breaker), or null. */
      entriesPaused: () => string | null
      /** An agent episode is deciding: the core waits for it. */
      busy: () => boolean
      /** Between bar requests (tests: 0). */
      pauseMs?: number
    },
  ) {}

  /** The day's plan, once built (the engine's status, tests). */
  get today(): CorePlan | null {
    return this.plan
  }

  /** Called every minute: the day's plan, then once in the session its exits and entries. */
  async tick(now = new Date()) {
    if (!this.ctx.settings.current.core.enabled) return
    const session = this.d.session()
    if (!session?.is_trading_day || !session.open || !session.close) return
    await this.ensurePlan(session.day, now)
    const plan = this.plan
    if (!plan || plan.day !== session.day || this.actedDay === session.day) return
    if (!isSessionOpen(session, now) || -minutesBetween(now, session.open) < ENTRY_DELAY_MIN || minutesBetween(now, session.close) < LATE_MIN) return
    if (this.d.busy()) return
    this.actedDay = session.day
    this.acting = true
    try {
      const notes = [...(await this.exits(plan, session)), ...(await this.entries(plan, session, now))]
      if (notes.length) this.ctx.log.info("trend core", { day: session.day, notes })
    } finally {
      this.acting = false
    }
  }

  private async ensurePlan(day: string, now: Date) {
    if (this.plan?.day === day || this.building || now.getTime() < this.retryAt) return
    this.building = true
    try {
      const cached = await this.ctx.col.cache.findOne({ _id: CORE_PLAN_KEY })
      const stored = (cached?.data ?? null) as CorePlan | null
      if (stored?.day === day) {
        this.plan = stored
        return
      }
      const plan = await this.build(day)
      this.plan = plan
      await this.ctx.col.cache.updateOne({ _id: CORE_PLAN_KEY }, { $set: { data: plan, fetched_at: now, expires_at: new Date(now.getTime() + 7 * 24 * HOUR) } }, { upsert: true })
      this.ctx.log.info("trend core plan", { day, regime: plan.regime.detail, picks: plan.picks.slice(0, 10).map((p) => p.symbol), broken: plan.broken })
    } catch (error) {
      this.retryAt = now.getTime() + RETRY_MS
      this.ctx.log.warn("trend core plan failed", { error: errorMessage(error) })
    } finally {
      this.building = false
    }
  }

  /** The day's plan from completed daily bars (up to midnight New York time on `day`). */
  private async build(day: string): Promise<CorePlan> {
    const s = this.ctx.settings.current
    const universe = (await this.ctx.col.cache.findOne({ _id: SCAN_UNIVERSE_KEY }))?.data as ScanUniverse | undefined
    const ranked = universe?.symbols ?? []
    if (!ranked.length) throw new Error("no scan universe yet")
    const held = (await this.ctx.col.plans.find({ book: "core" }, { projection: { _id: 1 } }).toArray()).map((p) => p._id)
    const names = new Map((await this.ctx.alpaca.listAssets()).map((a) => [a.symbol, a.name]))
    const pool = ranked.slice(0, s.core.universe_size).filter((symbol) => !GEARED_NAME.test(names.get(symbol) ?? ""))
    const symbols = [...new Set(["SPY", ...pool, ...held])]
    const end = marketTime(day, "00:00")
    const start = new Date(end.getTime() - 400 * 24 * HOUR)
    const bars: Record<string, Bar[]> = {}
    for (let i = 0; i < symbols.length; i += BATCH) {
      Object.assign(bars, await this.ctx.alpaca.getBars(symbols.slice(i, i + BATCH), "1Day", start, end, { feed: "sip" }))
      if (i + BATCH < symbols.length) await sleep(this.d.pauseMs ?? 1_500, this.ctx.signal)
    }
    const stats = new Map(symbols.flatMap((symbol) => {
      const st = coreStats(symbol, bars[symbol] ?? [])
      return st ? [[symbol, st] as const] : []
    }))
    return {
      day,
      built_at: new Date(),
      regime: coreRegime(stats.get("SPY") ?? null),
      picks: coreCandidates(pool.flatMap((symbol) => stats.get(symbol) ?? []), s).slice(0, Math.max(10, s.core.max_positions * 4)),
      broken: held.filter((symbol) => {
        const st = stats.get(symbol)
        return !!st && coreTrendBroken(st)
      }),
    }
  }

  /** Sells the core positions whose trend broke. */
  private async exits(plan: CorePlan, session: Session): Promise<string[]> {
    if (!plan.broken.length) return []
    const [positions, plans] = await Promise.all([this.ctx.alpaca.getPositions(), this.ctx.col.plans.find({ book: "core" }).toArray()])
    const core = new Set(plans.map((p) => p._id))
    const notes: string[] = []
    for (const symbol of plan.broken) {
      const position = positions.find((p) => p.symbol === symbol && isStock(p) && p.side === "long")
      if (position && core.has(symbol)) notes.push(await this.sell(symbol, position, session))
    }
    return notes
  }

  private async sell(symbol: string, position: AlpacaPosition, session: Session): Promise<string> {
    const id = randomUUID()
    const why = `Trend broke: ${symbol} closed below its 50-day average.`
    let outcome: Outcome
    try {
      await cancelSymbolOrders(this.ctx.alpaca, symbol)
      const order = await this.ctx.alpaca.submitOrder({ symbol, qty: position.qty, side: "sell", type: "market", time_in_force: "day", client_order_id: clientId("core") })
      const filled = await waitForFill(this.ctx.alpaca, order)
      await saveOrders(this.ctx.col, [filled], { decisionId: id })
      await this.ctx.col.plans.deleteOne({ _id: symbol })
      const price = filled.filled_avg_price ? Number(filled.filled_avg_price) : Number(position.current_price)
      const qty = Number(position.qty)
      outcome = { status: "executed", reason: filled.status === "filled" ? `sold ${qty} shares` : `sell submitted (status ${filled.status})`, price, qty, notional: round2(qty * price), order_ids: [filled.id] }
      await this.ctx.alerts.success(`Trend core sold ${symbol}`, `[paper] ${why}`, { path: `/markets/${symbol}`, key: `core-exit|${id}` }).catch(() => undefined)
    } catch (error) {
      // The plan stays: maintenance re-protects the shares at its stop.
      outcome = { status: "failed", reason: errorMessage(error).slice(0, 400) }
    }
    await this.record(id, session, request(symbol, "sell", why), outcome)
    return `${symbol}: trend broke, sell ${outcome.status}`
  }

  /** Fills the free core slots with the strongest picks it may buy. */
  private async entries(plan: CorePlan, session: Session, now: Date): Promise<string[]> {
    const s = this.ctx.settings.current
    if (!plan.regime.on) return [`no entries: ${plan.regime.detail}`]
    const paused = this.d.entriesPaused()
    if (paused) return [`no entries: ${paused}`]
    const st = this.ctx.state.state
    if (st.kill_switch.engaged || st.status !== "running") return []
    const { alpaca, col } = this.ctx
    const [account, positions, plans, tradesToday] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      col.plans.find({ book: "core" }, { projection: { _id: 1 } }).toArray(),
      col.decisions.countDocuments({ trading_day: session.day, status: "executed", action: { $in: ["buy", "sell", "buy_option", "close_option"] } }),
    ])
    const stocks = positions.filter((p) => isStock(p) && p.side === "long")
    const held = new Set(stocks.map((p) => p.symbol))
    const risk = computeRiskState(account, stocks.length, tradesToday, s)
    if (!risk.new_buys_allowed) return [`no entries: ${risk.notes.join(" ") || "buys are blocked"}`]
    let slots = Math.min(s.core.max_positions - plans.filter((p) => held.has(p._id)).length, s.risk.max_open_positions - stocks.length)
    if (slots <= 0) return []
    const [sold, vetoed] = await Promise.all([this.recentlySold(now), this.vetoed(now)])
    const notes: string[] = []
    const candidates = plan.picks.filter((p) => {
      if (held.has(p.symbol)) return false
      if (sold.has(p.symbol)) notes.push(`${p.symbol}: sold within ${s.core.reentry_hours} h`)
      else if (vetoed.has(p.symbol)) notes.push(`${p.symbol}: vetoed by negative news`)
      return !sold.has(p.symbol) && !vetoed.has(p.symbol)
    })
    const tried = candidates.slice(0, slots * 3)
    if (!tried.length) return notes
    const snapshots = await alpaca.getSnapshots(tried.map((p) => p.symbol)).catch(() => ({}) as Awaited<ReturnType<typeof alpaca.getSnapshots>>)
    let cash = risk.deployable_cash
    for (const pick of tried) {
      if (slots <= 0) break
      const price = snapshotPrice(snapshots[pick.symbol])
      if (!price) {
        notes.push(`${pick.symbol}: no price`)
        continue
      }
      const stop = floor2(price * (1 - pick.stop_pct / 100))
      const riskUsd = (risk.equity * s.core.risk_per_trade_pct) / 100
      const qty = Math.floor(Math.min(riskUsd / (price - stop), (risk.equity * risk.max_position_pct) / 100 / price, cash / price))
      if (qty < 1) {
        notes.push(`${pick.symbol}: $${round2(cash)} of deployable cash buys less than 1 share at $${price}`)
        continue
      }
      const asset = await alpaca.getAsset(pick.symbol).catch(() => null)
      if (!asset?.tradable || asset.status !== "active") {
        notes.push(`${pick.symbol}: not tradable`)
        continue
      }
      const checks: RiskCheck[] = [
        { name: "regime", ok: true, detail: plan.regime.detail },
        { name: "rules_entry", ok: true, detail: pick.signal },
        { name: "size", ok: true, detail: `${qty} shares ($${round2(qty * price)}): risks ${s.core.risk_per_trade_pct}% of equity at a ${pick.stop_pct}% stop (max ${risk.max_position_pct}% per position, $${round2(cash)} deployable)` },
      ]
      const bought = await this.buy(pick, qty, price, session, checks)
      notes.push(`${pick.symbol}: buy ${bought.status}`)
      if (bought.cost > 0) {
        slots -= 1
        cash -= bought.cost
        held.add(pick.symbol)
      }
    }
    return notes
  }

  /** A market buy, then its plan and a plain GTC stop (no target). */
  private async buy(pick: CorePick, qty: number, price: number, session: Session, checks: RiskCheck[]): Promise<{ status: DecisionDoc["status"]; cost: number }> {
    const { alpaca, col } = this.ctx
    const id = randomUUID()
    let outcome: Outcome
    let cost = 0
    try {
      const order = await alpaca.submitOrder({ symbol: pick.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day", client_order_id: clientId("core") })
      const filled = await waitForFill(alpaca, order)
      await saveOrders(col, [filled], { decisionId: id })
      const got = Math.floor(Number(filled.filled_qty))
      if (got < 1) {
        await alpaca.cancelOrder(filled.id).catch(() => undefined)
        outcome = { status: "failed", reason: `buy ${filled.status}, nothing filled`, checks, order_ids: [filled.id] }
      } else {
        const fill = filled.filled_avg_price ? Number(filled.filled_avg_price) : price
        const stop = floor2(fill * (1 - pick.stop_pct / 100))
        // The plan first: if the stop order fails, maintenance protects the shares at the plan's stop.
        await col.plans.updateOne(
          { _id: pick.symbol },
          {
            $set: { decision_id: id, stop_loss: stop, take_profit: null, trail_usd: round2(fill - stop), horizon: "multi_day", setup: "momentum", thesis: pick.signal, invalidation: INVALIDATION, book: "core", updated_at: new Date() } satisfies Partial<PositionPlanDoc>,
            $setOnInsert: { opened_at: new Date() },
          },
          { upsert: true },
        )
        const stopOrder = await placeStopOrder(this.ctx, pick.symbol, got, stop, id)
        cost = got * fill
        outcome = { status: "executed", reason: `bought ${got} shares; stop ${stop}, no target`, checks, price: fill, qty: got, notional: round2(cost), stop_loss: stop, order_ids: [filled.id, stopOrder.id] }
      }
    } catch (error) {
      outcome = { status: "failed", reason: errorMessage(error).slice(0, 400), checks }
    }
    await this.record(id, session, request(pick.symbol, "buy", pick.signal, { stop_loss: outcome.stop_loss ?? null }), outcome)
    return { status: outcome.status, cost }
  }

  private async record(id: string, session: Session, req: Decision, o: Outcome) {
    const doc: DecisionDoc = {
      _id: id,
      cycle_id: `core:${session.day}`,
      report_id: `core:${session.day}`,
      phase: "intraday",
      trading_day: session.day,
      created_at: new Date(),
      symbol: req.symbol,
      instrument: "stock",
      action: req.action,
      trigger_kind: "core",
      request: req,
      status: o.status,
      reason: o.reason,
      checks: o.checks ?? [],
      price: o.price ?? null,
      qty: o.qty ?? null,
      notional: o.notional ?? null,
      stop_loss: o.stop_loss ?? null,
      take_profit: null,
      order_ids: o.order_ids ?? [],
      option: null,
    }
    await this.ctx.col.decisions.insertOne(doc)
    this.ctx.bus.emit(
      "decision.result",
      { decision_id: id, symbol: req.symbol, action: req.action, status: o.status, reason: o.reason },
      { summary: `Trend core ${req.action} ${req.symbol}: ${o.status}${o.reason ? ` (${o.reason})` : ""}`, level: o.status === "failed" ? "warn" : "info", instrument: req.symbol },
    )
  }

  /** Stocks sold (by anyone: a stop, the agent, the core) within core.reentry_hours. */
  private async recentlySold(now: Date): Promise<Set<string>> {
    const since = new Date(now.getTime() - this.ctx.settings.current.core.reentry_hours * HOUR)
    const sales = await this.ctx.col.orders.find({ side: "sell", asset_class: "us_equity", filled_at: { $gte: since } }, { projection: { symbol: 1 } }).toArray()
    return new Set(sales.map((o) => o.symbol))
  }

  /** Stocks with negative news at review severity or above within core.news_veto_hours. */
  private async vetoed(now: Date): Promise<Set<string>> {
    const s = this.ctx.settings.current
    if (s.core.news_veto_hours <= 0) return new Set()
    const since = new Date(now.getTime() - s.core.news_veto_hours * HOUR)
    const items = await this.ctx.col.wireItems
      .find({ first_seen_at: { $gte: since }, polarity: -1, severity: { $gte: s.wire.thresholds.review } }, { projection: { symbols: 1 } })
      .toArray()
      .catch((e) => {
        this.ctx.log.warn("trend core: news veto unavailable", { error: errorMessage(e) })
        return []
      })
    return new Set(items.flatMap((i) => i.symbols))
  }
}
