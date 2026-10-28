import { randomUUID } from "node:crypto"
import { errorMessage } from "@mb/engine-kit/log"
import type { AlpacaAsset, AlpacaOrder, AlpacaPosition, Snapshot } from "@mb/stock-core/alpaca"
import type { ChainContract } from "@mb/stock-core/context"
import type { CycleKind, DecisionDoc, ExecutionSummary, PositionPlanDoc } from "@mb/stock-core/db"
import type { RiskCheck } from "@mb/stock-core/events"
import { describeContract, STRATEGY_LABEL } from "@mb/stock-core/options"
import { isOptionAction, type BotReport, type Decision } from "@mb/stock-core/report"
import type { Phase, RiskSettings, Settings } from "@mb/stock-core/settings"
import { marketDay } from "@mb/stock-core/time"
import type { Alpaca } from "../alpaca/client"
import { snapshotPrice } from "../market/indicators"
import type { TradingContext } from "./context"
import { coreHeld, tradingExposure } from "./books"
import { executeOptionDecision, type OptionOutcome } from "./options"
import { clientId, saveOrders, waitForFill } from "./orders"
import { computeRiskState, type RiskState } from "./risk"

/**
 * Turns the AI's decisions into Alpaca orders, enforcing the risk rules in code. Every rule that's
 * evaluated is recorded on the decision (and streamed to the dashboard), pass or fail.
 *
 * Stock order mechanics:
 * - BUY: whole shares only, as a bracket order (market entry + take-profit limit + stop-loss stop,
 *   good-til-canceled). Alpaca enforces the exits even when the engine isn't running.
 * - SELL / ADJUST: cancel the symbol's open exit orders first (they reserve the shares), then sell
 *   or place a fresh OCO (take-profit + stop-loss) pair. A held position's stop only ever moves up.
 * Options decisions go to ./options (defined-risk structures only).
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const floor2 = (n: number) => Math.floor(n * 100) / 100
const ceil2 = (n: number) => Math.ceil(n * 100) / 100
const round2 = (n: number) => Math.round(n * 100) / 100

/** Cancels every open order for a symbol and waits until Alpaca confirms none remain. */
export const cancelSymbolOrders = async (alpaca: Pick<Alpaca, "listOrders" | "cancelOrder">, symbol: string) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const open = await alpaca.listOrders({ status: "open", symbols: symbol, limit: 100 })
    if (open.length === 0) return
    if (attempt % 4 === 0) await Promise.all(open.map((o) => alpaca.cancelOrder(o.id).catch(() => undefined)))
    await sleep(500)
  }
  throw new Error(`Timed out cancelling open orders for ${symbol}`)
}

/** Validates/repairs exit levels around a reference price. */
export const resolveExits = (
  price: number,
  stop: number | null,
  target: number | null,
  risk: Pick<RiskSettings, "min_stop_pct" | "max_stop_pct" | "default_stop_pct">,
  { minStopPct = risk.min_stop_pct, maxStopPct = risk.max_stop_pct }: { minStopPct?: number; maxStopPct?: number } = {},
) => {
  const notes: string[] = []
  let s = stop
  const stopPct = s !== null ? ((price - s) / price) * 100 : null
  if (s === null || stopPct === null || stopPct < minStopPct) {
    s = price * (1 - risk.default_stop_pct / 100)
    notes.push(stop === null ? `no stop given; default ${risk.default_stop_pct}% stop` : `stop ${stop} too close/above price; default ${risk.default_stop_pct}% stop`)
  } else if (stopPct > maxStopPct) {
    s = price * (1 - maxStopPct / 100)
    notes.push(`stop ${stop} too wide; capped at ${maxStopPct}%`)
  }
  let t = target
  if (t === null || t <= price * 1.001) {
    t = price + (price - s) * 2
    notes.push(target === null ? "no target given; default 2R target" : `target ${target} not above price; default 2R target`)
  }
  const stopPrice = floor2(s)
  const targetPrice = ceil2(t)
  return { stop: stopPrice, target: targetPrice, rewardRisk: (targetPrice - price) / (price - stopPrice), notes }
}

/** Looser bounds for exits on positions already held (trailing a winner can put the stop near price). */
export const heldExitBounds = (risk: Pick<RiskSettings, "max_stop_pct">) => ({ minStopPct: 0.15, maxStopPct: risk.max_stop_pct * 1.5 })

/** The stop for a held position: the requested one, but never below the plan's current stop. */
export const ratchetStop = (requested: number | null, plan?: Pick<PositionPlanDoc, "stop_loss"> | null): number | null => {
  const current = plan?.stop_loss ?? null
  if (current === null) return requested
  return requested === null ? current : Math.max(requested, current)
}

/** Places a protective OCO (take-profit + stop-loss) sell for whole shares of a held position. */
export const placeExitOrders = async (ctx: Pick<TradingContext, "alpaca" | "col" | "bus">, symbol: string, qty: number, stop: number, target: number, decisionId: string | null): Promise<AlpacaOrder> => {
  const order = await ctx.alpaca.submitOrder({
    symbol,
    qty: String(qty),
    side: "sell",
    type: "limit",
    time_in_force: "gtc",
    order_class: "oco",
    take_profit: { limit_price: target.toFixed(2) },
    stop_loss: { stop_price: stop.toFixed(2) },
    client_order_id: clientId("oco"),
  })
  await saveOrders(ctx.col, [order], { decisionId })
  ctx.bus.emit("protection.placed", { symbol, stop, target }, { summary: `${symbol}: exits set (stop ${stop}, target ${target})`, instrument: symbol })
  return order
}

// ─── Stock buy rules (pure) ──────────────────────────────────────────────────

export type StockBuyInput = {
  decision: Decision
  phase: Phase
  risk: RiskState
  settings: Settings
  /** Engine-level gate: kill switch engaged or trading paused. */
  entriesBlocked: string | null
  held: boolean
  openCount: number
  newBuys: number
  tradesLeft: number
  recentlySold: boolean
  asset: AlpacaAsset | null
  price: number | null
  cash: number
}

export type StockBuyResult = {
  approved: boolean
  checks: RiskCheck[]
  reason: string | null
  qty: number
  budget: number
  exits: ReturnType<typeof resolveExits> | null
}

/** Every rule a new stock buy must pass, in order. The first failure is the rejection reason. */
export const evaluateStockBuy = (i: StockBuyInput): StockBuyResult => {
  const r = i.settings.risk
  const d = i.decision
  const checks: RiskCheck[] = []
  let failed = false
  const check = (name: string, ok: boolean, okDetail: string, failDetail: string) => {
    if (failed) return false
    checks.push({ name, ok, detail: ok ? okDetail : failDetail })
    if (!ok) failed = true
    return ok
  }
  const result = (qty = 0, budget = 0, exits: StockBuyResult["exits"] = null): StockBuyResult => {
    const first = checks.find((c) => !c.ok)
    return { approved: !first, checks, reason: first?.detail ?? null, qty, budget, exits }
  }

  check("engine", !i.entriesBlocked, "trading is running", i.entriesBlocked ?? "")
  check("loss limits", !i.risk.kill_switch && !i.risk.circuit_breaker, `day P&L ${i.risk.day_pnl_pct}%`, "daily loss circuit breaker is active")
  if (i.phase === "close") {
    check("closing window", d.horizon !== "intraday", "overnight/multi-day horizon", "no new intraday buys in the closing window")
    check("closing conviction", d.conviction >= 8, `conviction ${d.conviction}`, "closing-window buys need conviction >= 8")
  }
  check("not held", !i.held, "new position", "already held: the bot never adds to positions")
  check("open positions", i.openCount < r.max_open_positions, `${i.openCount}/${r.max_open_positions}`, `max open positions (${r.max_open_positions}) reached`)
  check("buys this cycle", i.newBuys < r.max_new_buys_per_cycle, `${i.newBuys}/${r.max_new_buys_per_cycle}`, `max ${r.max_new_buys_per_cycle} new buys per cycle`)
  check("trades today", i.tradesLeft > 0, `${i.tradesLeft} left`, "daily trade limit reached")
  check("conviction", d.conviction >= r.min_conviction, `${d.conviction} ≥ ${r.min_conviction}`, `conviction ${d.conviction} < ${r.min_conviction}`)
  check("cooldown", !i.recentlySold, "not recently sold", `sold within the last ${r.rebuy_cooldown_minutes} minutes`)
  const tradable = !!i.asset && i.asset.tradable && i.asset.status === "active" && i.asset.class === "us_equity"
  check("tradable", tradable, "active US equity", "asset not tradable on Alpaca")
  check("price", i.price !== null, `$${i.price}`, "no current price")
  if (failed || i.price === null) return result()
  check("min price", i.price >= r.min_price, `$${i.price} ≥ $${r.min_price}`, `price $${i.price} below $${r.min_price} minimum`)

  const allocationPct = Math.min(d.allocation_pct ?? 0, i.risk.max_position_pct)
  check("allocation", allocationPct > 0, `${allocationPct}% of equity (max ${i.risk.max_position_pct}%)`, "no allocation_pct given")
  const budget = Math.min((i.risk.equity * allocationPct) / 100, i.cash)
  const qty = Math.floor(budget / i.price)
  check("size", qty >= 1, `${qty} shares ($${round2(qty * i.price)})`, `budget $${round2(budget)} buys less than 1 share at $${i.price}`)
  if (failed) return result()

  const exits = resolveExits(i.price, d.stop_loss, d.take_profit, r)
  check(
    "reward:risk",
    exits.rewardRisk >= r.min_reward_risk,
    `${exits.rewardRisk.toFixed(2)} (stop ${exits.stop}, target ${exits.target})`,
    `reward:risk ${exits.rewardRisk.toFixed(2)} < ${r.min_reward_risk} (stop ${exits.stop}, target ${exits.target})`,
  )
  return result(qty, budget, exits)
}

// ─── Execution ───────────────────────────────────────────────────────────────

type Outcome = Pick<DecisionDoc, "status" | "reason"> & Partial<Pick<DecisionDoc, "price" | "qty" | "notional" | "stop_loss" | "take_profit" | "order_ids" | "checks" | "option">>

const reject = (reason: string, checks: RiskCheck[] = []): Outcome => ({ status: "rejected", reason, checks })

const ORDERING: Record<Decision["action"], number> = { sell: 0, close_option: 0, adjust_exits: 1, hold: 2, hold_option: 2, buy: 3, buy_option: 4 }

/** A one-line description of what the AI asked for, for the live feed. */
const describeRequest = (d: Decision): string | null => {
  if (d.action === "buy") return `${d.allocation_pct ?? "?"}% of equity · stop ${d.stop_loss ?? "default"} · target ${d.take_profit ?? "default"}`
  if (d.action === "sell") return `sell ${d.sell_pct ?? 100}%`
  if (d.action === "adjust_exits") return `stop ${d.stop_loss ?? "—"} · target ${d.take_profit ?? "—"}`
  if (d.action === "buy_option" && d.option) {
    const legs = [describeContract(d.option.long_leg), d.option.short_leg ? `/ ${describeContract(d.option.short_leg)}` : ""].join(" ")
    return `${STRATEGY_LABEL[d.option.strategy]} ${legs} · ${d.option.premium_pct ?? "?"}% premium`
  }
  return null
}

export type ExecuteInput = {
  cycleId: string
  reportId: string
  phase: Phase
  report: BotReport
  /** Contracts that were offered to the AI this cycle (options entries must come from here). */
  chains: Map<string, ChainContract>
  /** Why new entries are blocked right now (kill switch, pause), or null. */
  entriesBlocked: () => string | null
  /** The kind of cycle, recorded on every decision. */
  triggerKind?: CycleKind
  /** Event cycles: wire item ids per symbol ("*" = market-wide), recorded on the decisions. */
  wireItemIds?: Record<string, string[]>
}

export const executeDecisions = async (ctx: TradingContext, { cycleId, reportId, phase, report, chains, entriesBlocked, triggerKind, wireItemIds }: ExecuteInput): Promise<ExecutionSummary> => {
  const { alpaca, col, bus } = ctx
  const settings = ctx.settings.current
  const r = settings.risk
  const now = new Date()
  const day = marketDay(now)
  const summary: ExecutionSummary = { executed: 0, rejected: 0, failed: 0, noop: 0, notes: [] }
  // Planning phases never trade (their decisions are already emptied by normalizeReport).
  if (phase !== "intraday" && phase !== "close") return summary

  // Refresh broker state: the model may have spent a couple of minutes thinking.
  const [account, allPositions, clock, tradesToday, planDocs, optionDocs] = await Promise.all([
    alpaca.getAccount(),
    alpaca.getPositions(),
    alpaca.getClock(),
    col.decisions.countDocuments({ trading_day: day, status: "executed", action: { $in: ["buy", "sell", "buy_option", "close_option"] } }),
    col.plans.find().toArray(),
    col.optionPositions.find({ status: { $in: ["opening", "open", "closing"] } }, { projection: { mark: 1, qty: 1, cost_usd: 1 } }).toArray(),
  ])
  // While the core book is on, its holdings are the weekly review's: the trading book never trades them.
  const core = coreHeld(planDocs, settings)
  const positions = allPositions.filter((p) => (p.asset_class ?? "us_equity") === "us_equity" && !core.has(p.symbol))
  const risk = computeRiskState(account, positions.length, tradesToday, settings, { tradingExposure: tradingExposure(positions, optionDocs) })
  const held = new Map<string, AlpacaPosition>(positions.map((p) => [p.symbol, p]))
  const plans = new Map(planDocs.map((p) => [p._id, p]))
  const stockSymbols = report.decisions.filter((d) => !isOptionAction(d.action)).map((d) => d.symbol)
  const snapshots = await alpaca.getSnapshots(stockSymbols).catch((): Record<string, Snapshot> => ({}))
  const priceOf = (symbol: string): number | null => {
    const price = snapshotPrice(snapshots[symbol]) ?? Number(held.get(symbol)?.current_price ?? NaN)
    return Number.isFinite(price) && price > 0 ? price : null
  }
  const cooldownStart = new Date(now.getTime() - r.rebuy_cooldown_minutes * 60_000)
  // Sell fills count too: stop-losses and targets fire at the broker without a decision, and a
  // stopped-out name is exactly the one not to jump straight back into.
  const [soldByDecision, soldFills] = await Promise.all([
    col.decisions.find({ action: "sell", status: "executed", created_at: { $gte: cooldownStart } }).toArray(),
    col.orders.find({ side: "sell", asset_class: "us_equity", filled_at: { $gte: cooldownStart } }, { projection: { symbol: 1 } }).toArray(),
  ])
  const recentlySold = new Set([...soldByDecision, ...soldFills].map((d) => d.symbol))

  let cash = risk.deployable_cash
  let openCount = positions.length
  let tradesLeft = risk.trades_remaining
  let newBuys = 0

  // Every held stock gets a recorded decision. If the AI skipped one, log a default hold (its
  // broker-side stop/target orders stay active) so the audit trail is complete.
  const decided = new Set(report.decisions.filter((d) => !isOptionAction(d.action)).map((d) => d.symbol))
  const defaultHolds: Decision[] = positions
    .filter((p) => !decided.has(p.symbol))
    .map((p) => ({
      symbol: p.symbol,
      action: "hold",
      allocation_pct: null,
      sell_pct: null,
      stop_loss: null,
      take_profit: null,
      horizon: plans.get(p.symbol)?.horizon ?? "intraday",
      setup: "other",
      conviction: 5,
      rationale: "The AI returned no decision for this position, so it is held by default. Its stop-loss and take-profit orders stay active.",
      evidence: [],
      invalidation: plans.get(p.symbol)?.invalidation ?? "Stop-loss hit.",
      structure_id: null,
      option: null,
    }))
  if (defaultHolds.length) summary.notes.push(`No decision returned for ${defaultHolds.map((d) => d.symbol).join(", ")}; held by default.`)

  const ordered = [...report.decisions, ...defaultHolds].sort((a, b) => ORDERING[a.action] - ORDERING[b.action] || b.conviction - a.conviction)

  for (const d of ordered) {
    const id = randomUUID()
    const instrument = isOptionAction(d.action) ? "option" : "stock"
    bus.emit(
      "ai.decision.proposed",
      { cycle_id: cycleId, symbol: d.symbol, instrument, action: d.action, conviction: d.conviction, rationale: d.rationale.slice(0, 400), detail: describeRequest(d) },
      { summary: `${d.symbol}: ${d.action.replace(/_/g, " ")} (conviction ${d.conviction}/10)`, cycle_id: cycleId, instrument: d.symbol },
    )
    let outcome: Outcome
    try {
      if (instrument === "stock" && core.has(d.symbol)) {
        const detail = `${d.symbol} is a core book holding: the weekly core review manages it`
        outcome = reject(detail, [{ name: "core book", ok: false, detail }])
      } else if (!clock.is_open && d.action !== "hold" && d.action !== "hold_option") outcome = { status: "noop", reason: "market closed; not executed" }
      else if (instrument === "option") {
        const result: OptionOutcome = await executeOptionDecision(ctx, {
          decision: d,
          decisionId: id,
          phase,
          risk,
          account,
          chains,
          entriesBlocked: entriesBlocked(),
          tradesLeft,
        })
        if (result.status === "executed" && (d.action === "buy_option" || d.action === "close_option")) tradesLeft -= 1
        outcome = result
      } else if (d.action === "hold") outcome = held.has(d.symbol) ? { status: "noop", reason: "holding" } : { status: "noop", reason: "hold on a symbol that is not held" }
      else if (d.action === "sell") outcome = await sell(d, id)
      else if (d.action === "adjust_exits") outcome = await adjust(d, id)
      else outcome = await buy(d, id)
    } catch (error) {
      outcome = { status: "failed", reason: errorMessage(error).slice(0, 400) }
    }
    summary[outcome.status] += 1
    if (outcome.status === "failed") summary.notes.push(`${d.action.toUpperCase()} ${d.symbol}: ${outcome.reason}`)
    const checks = outcome.checks ?? []
    const doc: DecisionDoc = {
      _id: id,
      cycle_id: cycleId,
      report_id: reportId,
      phase,
      trading_day: day,
      created_at: new Date(),
      symbol: d.symbol,
      instrument,
      action: d.action,
      ...(triggerKind ? { trigger_kind: triggerKind } : {}),
      ...(wireItemIds && (wireItemIds[d.symbol] ?? wireItemIds["*"])?.length ? { wire_item_ids: wireItemIds[d.symbol] ?? wireItemIds["*"] } : {}),
      request: d,
      status: outcome.status,
      reason: outcome.reason,
      checks,
      price: outcome.price ?? (instrument === "stock" ? priceOf(d.symbol) : null),
      qty: outcome.qty ?? null,
      notional: outcome.notional ?? null,
      stop_loss: outcome.stop_loss ?? null,
      take_profit: outcome.take_profit ?? null,
      order_ids: outcome.order_ids ?? [],
      option: outcome.option ?? null,
    }
    await col.decisions.insertOne(doc)
    if (checks.length) {
      const approved = checks.every((c) => c.ok)
      bus.emit(
        "risk.checked",
        { decision_id: id, symbol: d.symbol, action: d.action, approved, reasons: checks.filter((c) => !c.ok).map((c) => c.detail), checks: checks.slice(0, 20), qty: doc.qty, notional_usd: doc.notional },
        { summary: approved ? `Risk approved ${d.symbol} (${checks.length} checks)` : `Risk rejected ${d.symbol}: ${checks.find((c) => !c.ok)?.detail}`, level: approved ? "info" : "warn", cycle_id: cycleId, instrument: d.symbol },
      )
    }
    bus.emit(
      "decision.result",
      { decision_id: id, symbol: d.symbol, action: d.action, status: outcome.status, reason: outcome.reason },
      { summary: `${d.symbol} ${d.action.replace(/_/g, " ")}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`, level: outcome.status === "failed" ? "warn" : "info", cycle_id: cycleId, instrument: d.symbol },
    )
  }
  return summary

  async function submitStock(order: Parameters<Alpaca["submitOrder"]>[0], purpose: string, decisionId: string) {
    const placed = await alpaca.submitOrder(order)
    bus.emit(
      "order.submitted",
      { order_id: placed.id, symbol: order.symbol!, side: order.side!, type: order.type, qty: Number(order.qty), limit_price: order.limit_price ? Number(order.limit_price) : null, purpose, asset_class: "us_equity" },
      { summary: `Order sent: ${order.side} ${order.qty} ${order.symbol} (${purpose})`, cycle_id: cycleId, instrument: order.symbol },
    )
    const filled = await waitForFill(alpaca, placed)
    await saveOrders(col, [filled], { decisionId })
    return filled
  }

  async function sell(d: Decision, decisionId: string): Promise<Outcome> {
    const position = held.get(d.symbol)
    if (!position || position.side !== "long") return reject("not currently held", [{ name: "held", ok: false, detail: "not currently held" }])
    const heldQty = Number(position.qty)
    const pct = d.sell_pct ?? 100
    let qty = pct >= 99.5 ? heldQty : Math.floor((heldQty * pct) / 100)
    if (qty < 1 && heldQty <= 1) qty = heldQty
    if (qty <= 0) return reject(`sell_pct ${pct}% of ${heldQty} shares rounds to 0`)
    const full = qty >= heldQty

    await cancelSymbolOrders(alpaca, d.symbol)
    let order: AlpacaOrder
    // One client_order_id across attempts: if an attempt actually went through, a retry returns it instead of selling twice.
    const sellId = clientId("sell")
    for (let attempt = 0; ; attempt++) {
      try {
        order = await submitStock({ symbol: d.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day", client_order_id: sellId }, "exit", decisionId)
        break
      } catch (error) {
        // Shares can stay reserved for a moment after the exit orders are canceled.
        if (attempt >= 3) throw error
        await sleep(1_000)
      }
    }
    const filled = order
    const fillPrice = filled.filled_avg_price ? Number(filled.filled_avg_price) : priceOf(d.symbol)
    const orderIds = [filled.id]

    const remainingQty = Math.floor(heldQty - qty)
    const plan = plans.get(d.symbol)
    if (full) {
      await col.plans.deleteOne({ _id: d.symbol })
      held.delete(d.symbol)
      openCount -= 1
    } else if (remainingQty >= 1 && fillPrice) {
      // Re-protect the shares that are left.
      const exits = resolveExits(fillPrice, ratchetStop(d.stop_loss, plan), d.take_profit ?? plan?.take_profit ?? null, r, heldExitBounds(r))
      const oco = await placeExitOrders(ctx, d.symbol, remainingQty, exits.stop, exits.target, decisionId)
      orderIds.push(oco.id)
      await col.plans.updateOne({ _id: d.symbol }, { $set: { stop_loss: exits.stop, take_profit: exits.target, updated_at: new Date() } })
    }
    tradesLeft -= 1
    recentlySold.add(d.symbol)
    if (fillPrice) cash += qty * fillPrice
    return {
      status: "executed",
      reason: filled.status === "filled" ? `sold ${qty} of ${heldQty} shares` : `sell submitted (status ${filled.status})`,
      price: fillPrice,
      qty,
      notional: fillPrice ? round2(qty * fillPrice) : null,
      order_ids: orderIds,
    }
  }

  async function adjust(d: Decision, decisionId: string): Promise<Outcome> {
    const position = held.get(d.symbol)
    if (!position) return reject("not currently held", [{ name: "held", ok: false, detail: "not currently held" }])
    const qty = Math.floor(Number(position.qty))
    if (qty < 1) return reject("fractional position: exit orders need whole shares")
    const price = priceOf(d.symbol)
    if (!price) return reject("no current price")
    const plan = plans.get(d.symbol)
    const current = plan?.stop_loss ?? null
    const exits = resolveExits(price, ratchetStop(d.stop_loss, plan), d.take_profit ?? plan?.take_profit ?? null, r, heldExitBounds(r))
    // The kept stop can be unusable (price at or just above it); a repaired one would land lower,
    // so leave the resting exits alone instead.
    const checks: RiskCheck[] = [
      { name: "stop only moves up", ok: !(current !== null && exits.stop < current - 0.005), detail: current !== null && exits.stop < current - 0.005 ? `stop would move down from ${current} to ${exits.stop}; stops only move up` : `stop ${exits.stop}${current !== null ? ` (was ${current})` : ""}` },
    ]
    if (!checks[0].ok) return reject(checks[0].detail, checks)
    const notes = current !== null && d.stop_loss !== null && d.stop_loss < current ? [`stop ${d.stop_loss} is below the current stop; kept ${current}`] : []

    await cancelSymbolOrders(alpaca, d.symbol)
    const oco = await placeExitOrders(ctx, d.symbol, qty, exits.stop, exits.target, decisionId)
    await upsertPlan(d, decisionId, exits.stop, exits.target, plan)
    return {
      status: "executed",
      reason: ["exits replaced", ...notes, ...exits.notes].join("; "),
      checks,
      price,
      qty,
      stop_loss: exits.stop,
      take_profit: exits.target,
      order_ids: [oco.id],
    }
  }

  async function buy(d: Decision, decisionId: string): Promise<Outcome> {
    const asset = await alpaca.getAsset(d.symbol).catch(() => null)
    const evaluation = evaluateStockBuy({
      decision: d,
      phase,
      risk,
      settings,
      entriesBlocked: entriesBlocked(),
      held: held.has(d.symbol),
      openCount,
      newBuys,
      tradesLeft,
      recentlySold: recentlySold.has(d.symbol),
      asset,
      price: priceOf(d.symbol),
      cash,
    })
    if (!evaluation.approved || !evaluation.exits) return reject(evaluation.reason ?? "rejected", evaluation.checks)
    const { qty, exits } = evaluation
    const price = priceOf(d.symbol)!

    const filled = await submitStock(
      {
        symbol: d.symbol,
        qty: String(qty),
        side: "buy",
        type: "market",
        time_in_force: "gtc",
        order_class: "bracket",
        take_profit: { limit_price: exits.target.toFixed(2) },
        stop_loss: { stop_price: exits.stop.toFixed(2) },
        client_order_id: clientId("buy"),
      },
      "entry",
      decisionId,
    )
    if (filled.status === "rejected" || filled.status === "canceled" || filled.status === "expired") {
      return { status: "failed", reason: `order ${filled.status} by broker`, order_ids: [filled.id], checks: evaluation.checks }
    }
    await upsertPlan(d, decisionId, exits.stop, exits.target)

    const fillPrice = filled.filled_avg_price ? Number(filled.filled_avg_price) : price
    cash -= qty * fillPrice
    openCount += 1
    newBuys += 1
    tradesLeft -= 1
    held.set(d.symbol, { symbol: d.symbol, qty: String(qty), current_price: String(fillPrice), side: "long" } as AlpacaPosition)
    return {
      status: "executed",
      reason: [filled.status === "filled" ? `bought ${qty} shares` : `buy submitted (status ${filled.status})`, ...exits.notes].join("; "),
      checks: evaluation.checks,
      price: fillPrice,
      qty,
      notional: round2(qty * fillPrice),
      stop_loss: exits.stop,
      take_profit: exits.target,
      order_ids: [filled.id],
    }
  }

  /** Records the live plan for a position. Adjusting an existing plan keeps its original thesis. */
  async function upsertPlan(d: Decision, decisionId: string, stop: number, target: number, existing?: PositionPlanDoc) {
    const levels = { stop_loss: stop, take_profit: target, horizon: d.horizon, invalidation: d.invalidation, updated_at: new Date() }
    await col.plans.updateOne(
      { _id: d.symbol },
      existing
        ? { $set: levels }
        : {
            $set: { ...levels, decision_id: decisionId, setup: d.setup, thesis: d.rationale },
            $setOnInsert: { opened_at: new Date() },
          },
      { upsert: true },
    )
  }
}
