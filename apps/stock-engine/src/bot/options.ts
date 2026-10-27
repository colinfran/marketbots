import { randomUUID } from "node:crypto"
import { errorMessage } from "@mb/engine-kit/log"
import type { AlpacaAccount, AlpacaOrder, AlpacaPosition, NewOrder } from "@mb/stock-core/alpaca"
import type { ChainContract } from "@mb/stock-core/context"
import type { DecisionDoc, DecisionOptionDetail, OptionLeg, OptionPositionDoc } from "@mb/stock-core/db"
import type { ProtectionKind, RiskCheck } from "@mb/stock-core/events"
import { roundTo } from "@mb/stock-core/math"
import { daysToExpiry, describeContract, isBullish, isOptionSymbol, isSpread, OPTION_MULTIPLIER, parseOcc, STRATEGY_LABEL, strategyRight } from "@mb/stock-core/options"
import type { Decision } from "@mb/stock-core/report"
import type { Phase, Settings } from "@mb/stock-core/settings"
import { marketClock, marketDay } from "@mb/stock-core/time"
import { AlpacaError } from "../alpaca/client"
import { structureQuote, type StructureQuote } from "../market/options-chain"
import type { TradingContext } from "./context"
import { clientId, saveOrders, waitForFill } from "./orders"
import type { RiskState } from "./risk"

/**
 * Options trading: long calls, long puts, and call/put debit spreads. Every structure is defined
 * risk (the most it can lose is what was paid), so there are no margin calls and no naked shorts.
 *
 * - Entries are limit orders (day) between the midpoint and the ask, canceled if not filled in time.
 *   Spreads go in as one two-leg (mleg) order, so both legs fill together or not at all.
 * - Alpaca has no bracket orders for options, so the engine watches every position itself every
 *   few seconds: value stop, take profit, the underlying's invalidation/target levels, and a time
 *   stop that closes positions before expiration (nothing is ever exercised or assigned).
 */

const round2 = (n: number) => Math.round(n * 100) / 100

export type OptionOutcome = Pick<DecisionDoc, "status" | "reason"> &
  Partial<Pick<DecisionDoc, "price" | "qty" | "notional" | "stop_loss" | "take_profit" | "order_ids" | "checks" | "option">>

// ─── Entry rules (pure) ──────────────────────────────────────────────────────

export type OptionEntryInput = {
  decision: Decision
  phase: Phase
  settings: Settings
  risk: RiskState
  entriesBlocked: string | null
  tradesLeft: number
  openPositions: number
  premiumOpenUsd: number
  optionsBuyingPower: number | null
  long: ChainContract | undefined
  short: ChainContract | undefined
  underlyingPrice: number | null
}

export type OptionEntryResult = {
  approved: boolean
  checks: RiskCheck[]
  reason: string | null
  contracts: number
  /** Net debit per share at the limit. */
  limit: number
  cost: number
  maxProfit: number | null
  underlyingStop: number | null
  underlyingTarget: number | null
  notes: string[]
}

/** Every rule a new options position must pass, in order. The first failure is the rejection reason. */
export const evaluateOptionEntry = (i: OptionEntryInput): OptionEntryResult => {
  const s = i.settings.options
  const d = i.decision
  const o = d.option
  const checks: RiskCheck[] = []
  const notes: string[] = []
  let failed = false
  const check = (name: string, ok: boolean, okDetail: string, failDetail: string) => {
    if (failed) return false
    checks.push({ name, ok, detail: ok ? okDetail : failDetail })
    if (!ok) failed = true
    return ok
  }
  const result = (extra: Partial<OptionEntryResult> = {}): OptionEntryResult => {
    const first = checks.find((c) => !c.ok)
    return { approved: !first, checks, reason: first?.detail ?? null, contracts: 0, limit: 0, cost: 0, maxProfit: null, underlyingStop: null, underlyingTarget: null, notes, ...extra }
  }

  check("engine", !i.entriesBlocked, "trading is running", i.entriesBlocked ?? "")
  check("options enabled", s.enabled, "enabled", "options trading is disabled in settings")
  check("loss limits", !i.risk.kill_switch && !i.risk.circuit_breaker, `day P&L ${i.risk.day_pnl_pct}%`, "daily loss circuit breaker is active")
  check("phase", i.phase === "intraday" || (i.phase === "close" && d.conviction >= 8), i.phase, "closing-window options entries need conviction >= 8")
  check("conviction", d.conviction >= s.min_conviction, `${d.conviction} ≥ ${s.min_conviction}`, `conviction ${d.conviction} < ${s.min_conviction}`)
  check("open options positions", i.openPositions < s.max_open_positions, `${i.openPositions}/${s.max_open_positions}`, `max ${s.max_open_positions} options positions reached`)
  check("trades today", i.tradesLeft > 0, `${i.tradesLeft} left`, "daily trade limit reached")
  check("order", !!o, "contract chosen", "buy_option needs an option order")
  if (failed || !o) return result()
  check("strategy", !isSpread(o.strategy) || s.allow_spreads, STRATEGY_LABEL[o.strategy], "spreads are disabled in settings")
  const long = i.long
  check("long leg offered", !!long, describeContract(o.long_leg), `${o.long_leg} wasn't in the option chains offered this cycle`)
  if (failed || !long) return result()
  const parsed = parseOcc(long.symbol)
  check("underlying", parsed?.root === d.symbol, d.symbol, `${long.symbol} is not an option on ${d.symbol}`)
  check("contract type", long.type === strategyRight(o.strategy), long.type, `${STRATEGY_LABEL[o.strategy]} needs a ${strategyRight(o.strategy)}, got a ${long.type}`)
  let short: ChainContract | undefined
  if (isSpread(o.strategy)) {
    short = i.short
    check("short leg offered", !!short, o.short_leg ? describeContract(o.short_leg) : "—", o.short_leg ? `${o.short_leg} wasn't in the option chains offered this cycle` : "a spread needs a short leg")
    if (failed || !short) return result()
    check("same expiration", short.expiration === long.expiration && short.type === long.type, short.expiration, "both legs must be the same type and expiration")
    const ordered = o.strategy === "call_debit_spread" ? short.strike > long.strike : short.strike < long.strike
    check(
      "strike order",
      ordered,
      `buy ${long.strike} / sell ${short.strike}`,
      o.strategy === "call_debit_spread" ? "a call debit spread sells a HIGHER strike than it buys" : "a put debit spread sells a LOWER strike than it buys",
    )
  } else if (o.short_leg) notes.push(`${STRATEGY_LABEL[o.strategy]} takes no short leg; ${o.short_leg} ignored`)
  check("days to expiration", long.dte >= s.min_dte && long.dte <= s.max_dte, `${long.dte} days`, `${long.dte} days to expiration is outside ${s.min_dte}-${s.max_dte}`)
  const delta = long.delta === null ? null : Math.abs(long.delta)
  check("delta", delta !== null && delta >= s.min_delta && delta <= s.max_delta, `|Δ| ${delta}`, delta === null ? "no greeks for the long leg" : `|delta| ${delta} is outside ${s.min_delta}-${s.max_delta}`)
  for (const leg of [long, short].filter((c): c is ChainContract => !!c)) {
    check(`liquidity ${leg.strike}${leg.type === "call" ? "C" : "P"}`, leg.spread_pct <= s.max_spread_pct && (s.min_open_interest === 0 || (leg.open_interest ?? 0) >= s.min_open_interest), `spread ${leg.spread_pct}%, OI ${leg.open_interest ?? "?"}`, `too illiquid: spread ${leg.spread_pct}% (max ${s.max_spread_pct}%), open interest ${leg.open_interest ?? "unknown"} (min ${s.min_open_interest})`)
  }
  check("underlying price", i.underlyingPrice === null || i.underlyingPrice >= i.settings.risk.min_price, `$${i.underlyingPrice ?? "?"}`, `underlying below the $${i.settings.risk.min_price} minimum`)
  if (failed) return result()

  // Price: from the midpoint toward the ask by `entry_aggression`.
  const mid = long.mid - (short?.mid ?? 0)
  const atAsk = long.ask - (short?.bid ?? 0)
  // Rounded up to the cent, like the buy order itself (a hair below the target price would just not fill).
  const limit = Math.max(0.01, Math.ceil(roundTo((mid + s.entry_aggression * Math.max(0, atAsk - mid)) * 100, 6)) / 100)
  const width = short ? Math.abs(short.strike - long.strike) : null
  check("net debit", mid > 0 && (width === null || limit < width), `$${limit.toFixed(2)} per share`, width !== null && limit >= width ? `debit ${limit} is not below the spread width ${width}` : "no positive midpoint")
  if (width !== null) {
    const rr = (width - limit) / limit
    check("reward:risk", rr >= s.min_spread_reward_risk, `${rr.toFixed(2)} (max profit $${((width - limit) * 100).toFixed(0)} vs $${(limit * 100).toFixed(0)} per spread)`, `spread reward:risk ${rr.toFixed(2)} < ${s.min_spread_reward_risk}`)
  }
  if (failed) return result()

  const equity = i.risk.equity
  const perTradePct = (i.risk.profit_lock ? s.max_premium_per_trade_pct / 2 : s.max_premium_per_trade_pct)
  const wantPct = Math.min(o.premium_pct ?? perTradePct, perTradePct)
  const totalRoom = Math.max(0, (equity * s.max_total_premium_pct) / 100 - i.premiumOpenUsd)
  const budget = Math.min((equity * wantPct) / 100, totalRoom, i.risk.deployable_cash, i.optionsBuyingPower ?? Number.POSITIVE_INFINITY)
  const perContract = limit * OPTION_MULTIPLIER
  const contracts = Math.min(s.max_contracts_per_trade, Math.floor(budget / perContract))
  check(
    "premium budget",
    contracts >= 1,
    `${contracts} × $${perContract.toFixed(0)} = $${(contracts * perContract).toFixed(0)} (${wantPct}% of equity, $${totalRoom.toFixed(0)} of room left)`,
    `budget $${round2(budget)} buys less than 1 contract at $${perContract.toFixed(0)}`,
  )
  if (failed) return result()

  // The AI's underlying levels must sit on the right side of the price; otherwise they're dropped.
  const bull = isBullish(o.strategy)
  const p = i.underlyingPrice
  let underlyingStop = d.stop_loss
  let underlyingTarget = d.take_profit
  if (p !== null && underlyingStop !== null && (bull ? underlyingStop >= p : underlyingStop <= p)) {
    notes.push(`underlying stop ${underlyingStop} is on the wrong side of ${p}; ignored`)
    underlyingStop = null
  }
  if (p !== null && underlyingTarget !== null && (bull ? underlyingTarget <= p : underlyingTarget >= p)) {
    notes.push(`underlying target ${underlyingTarget} is on the wrong side of ${p}; ignored`)
    underlyingTarget = null
  }
  const maxProfit = width !== null ? round2((width - limit) * OPTION_MULTIPLIER * contracts) : o.strategy === "long_put" ? round2((long.strike - limit) * OPTION_MULTIPLIER * contracts) : null
  return result({ contracts, limit, cost: round2(contracts * perContract), maxProfit, underlyingStop, underlyingTarget })
}

// ─── Exit rules (pure) ───────────────────────────────────────────────────────

export type ExitTrigger = { kind: ProtectionKind; urgent: boolean; detail: string }

/**
 * Whether an open position should be closed now. Checked in this order: time stop (never hold into
 * expiration), the underlying's invalidation level, the value stop, the underlying's target, take profit.
 */
export const exitTrigger = (
  doc: Pick<OptionPositionDoc, "strategy" | "legs" | "entry_price" | "stop_loss_pct" | "take_profit_pct" | "underlying_stop" | "underlying_target" | "expiration">,
  quote: StructureQuote | null,
  underlyingPrice: number | null,
  { today, nowEt, closeAtDte }: { today: string; nowEt: string; closeAtDte: number },
): ExitTrigger | null => {
  const dte = daysToExpiry(doc.expiration, today)
  // After the first half hour, so the time stop doesn't sell into the opening spreads.
  if (dte <= closeAtDte && nowEt >= "10:00") return { kind: "time", urgent: true, detail: `${dte} day${dte === 1 ? "" : "s"} to expiration` }
  const bull = isBullish(doc.strategy)
  if (underlyingPrice !== null && doc.underlying_stop !== null && (bull ? underlyingPrice <= doc.underlying_stop : underlyingPrice >= doc.underlying_stop)) {
    return { kind: "underlying_stop", urgent: true, detail: `underlying ${underlyingPrice} crossed ${doc.underlying_stop}` }
  }
  if (!quote || doc.entry_price === null || doc.entry_price <= 0) return null
  const value = quote.mid
  if (value <= doc.entry_price * (1 - doc.stop_loss_pct / 100)) return { kind: "stop", urgent: true, detail: `worth ${value.toFixed(2)} vs ${doc.entry_price.toFixed(2)} paid (−${doc.stop_loss_pct}% stop)` }
  if (underlyingPrice !== null && doc.underlying_target !== null && (bull ? underlyingPrice >= doc.underlying_target : underlyingPrice <= doc.underlying_target)) {
    return { kind: "underlying_target", urgent: false, detail: `underlying ${underlyingPrice} reached ${doc.underlying_target}` }
  }
  // A spread can't be worth more than its width, so its target is capped just below that.
  const width = doc.legs.length === 2 ? Math.abs(doc.legs[0].strike - doc.legs[1].strike) : null
  const target = Math.min(doc.entry_price * (1 + doc.take_profit_pct / 100), width !== null ? width * 0.95 : Number.POSITIVE_INFINITY)
  if (value >= target) return { kind: "target", urgent: false, detail: `worth ${value.toFixed(2)} vs ${doc.entry_price.toFixed(2)} paid (target ${target.toFixed(2)})` }
  return null
}

// ─── Orders ──────────────────────────────────────────────────────────────────

/** Option price increments: $0.01 under $3 and $0.05 above for most liquid names; some need $0.05 / $0.10. */
const tickFor = (price: number, coarse: number) => (coarse === 0 ? (price < 3 ? 0.01 : 0.05) : coarse === 1 ? (price < 3 ? 0.05 : 0.1) : 0.1)
const roundTick = (price: number, tick: number, dir: "up" | "down") => {
  const steps = price / tick
  const n = dir === "up" ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9)
  return roundTo(n * tick, 2)
}
const isIncrementError = (error: unknown) => error instanceof AlpacaError && error.status === 422 && /increment|tick|sub-?penny|price.*invalid/i.test(error.message)

type OrderSpec = { legs: Pick<OptionLeg, "symbol" | "side">[]; qty: number; action: "open" | "close"; limit: number | null }

const buildOrder = ({ legs, qty, action, limit }: OrderSpec, coarse: number, cid: string): NewOrder => {
  const open = action === "open"
  if (legs.length === 1) {
    const side = open ? "buy" : "sell"
    return {
      symbol: legs[0].symbol,
      qty: String(qty),
      side,
      type: limit === null ? "market" : "limit",
      ...(limit === null ? {} : { limit_price: roundTick(limit, tickFor(limit, coarse), open ? "up" : "down").toFixed(2) }),
      time_in_force: "day",
      position_intent: open ? "buy_to_open" : "sell_to_close",
      client_order_id: cid,
    }
  }
  // Multi-leg: positive limit = net debit paid (opening), negative = net credit received (closing).
  const tick = coarse === 0 ? 0.01 : 0.05
  const signed = limit === null ? null : open ? roundTick(limit, tick, "up") : -roundTick(Math.max(0, limit), tick, "down")
  return {
    order_class: "mleg",
    qty: String(qty),
    type: limit === null ? "market" : "limit",
    ...(signed === null ? {} : { limit_price: signed.toFixed(2) }),
    time_in_force: "day",
    legs: legs.map((l) => ({
      symbol: l.symbol,
      ratio_qty: "1",
      side: (l.side === "long") === open ? "buy" : "sell",
      position_intent: l.side === "long" ? (open ? "buy_to_open" : "sell_to_close") : open ? "sell_to_open" : "buy_to_close",
    })),
    client_order_id: cid,
  }
}

/** Submits, retrying with coarser price increments if the broker rejects the tick size. */
const submitOption = async (ctx: TradingContext, spec: OrderSpec, kind: string) => {
  for (let coarse = 0; ; coarse++) {
    try {
      return await ctx.alpaca.submitOrder(buildOrder(spec, coarse, clientId(kind)))
    } catch (error) {
      if (spec.limit === null || coarse >= 2 || !isIncrementError(error)) throw error
    }
  }
}

const FINAL = new Set(["filled", "canceled", "expired", "rejected", "suspended", "stopped"])

/** Waits for a fill; if it doesn't come in time, cancels and returns the final state (which may be a late fill). */
const fillOrCancel = async (ctx: TradingContext, order: AlpacaOrder, timeoutMs: number): Promise<AlpacaOrder> => {
  let current = await waitForFill(ctx.alpaca, order, timeoutMs)
  if (FINAL.has(current.status)) return current
  await ctx.alpaca.cancelOrder(current.id).catch(() => undefined)
  current = await waitForFill(ctx.alpaca, current, 5_000)
  return current
}

/** Net fill price per share from the legs (long minus short), falling back to the order's average. */
const netFill = (order: AlpacaOrder, legs: Pick<OptionLeg, "symbol" | "side">[]): { net: number | null; perLeg: Map<string, number> } => {
  const perLeg = new Map<string, number>()
  if (legs.length === 1) {
    const p = order.filled_avg_price ? Number(order.filled_avg_price) : null
    if (p !== null) perLeg.set(legs[0].symbol, p)
    return { net: p, perLeg }
  }
  for (const leg of order.legs ?? []) if (leg.filled_avg_price) perLeg.set(leg.symbol, Number(leg.filled_avg_price))
  if (legs.every((l) => perLeg.has(l.symbol))) {
    return { net: roundTo(legs.reduce((sum, l) => sum + (l.side === "long" ? 1 : -1) * perLeg.get(l.symbol)!, 0), 4), perLeg }
  }
  return { net: order.filled_avg_price ? Math.abs(Number(order.filled_avg_price)) : null, perLeg }
}

const orderSymbol = (doc: Pick<OptionPositionDoc, "legs" | "underlying">) => (doc.legs.length === 1 ? doc.legs[0].symbol : `${doc.underlying} spread`)

const emitSubmitted = (ctx: TradingContext, order: AlpacaOrder, doc: Pick<OptionPositionDoc, "legs" | "underlying">, spec: OrderSpec, purpose: string) =>
  ctx.bus.emit(
    "order.submitted",
    {
      order_id: order.id,
      symbol: orderSymbol(doc),
      side: spec.action === "open" ? "buy" : "sell",
      type: spec.limit === null ? "market" : "limit",
      qty: spec.qty,
      limit_price: spec.limit,
      purpose,
      asset_class: "us_option",
    },
    {
      summary: `Order sent: ${spec.action === "open" ? "buy" : "sell"} ${spec.qty} ${doc.legs.map((l) => describeContract(l.symbol)).join(" / ")} (${spec.limit === null ? "market" : `limit ${spec.limit.toFixed(2)}`})`,
      instrument: doc.underlying,
    },
  )

// ─── Opening ─────────────────────────────────────────────────────────────────

const decisionDetail = (doc: Pick<OptionPositionDoc, "strategy" | "legs">, extra: Partial<DecisionOptionDetail>): DecisionOptionDetail => ({
  structure_id: null,
  strategy: doc.strategy,
  legs: doc.legs.map((l) => ({ symbol: l.symbol, side: l.side })),
  contracts: null,
  limit_price: null,
  cost_usd: null,
  max_loss_usd: null,
  max_profit_usd: null,
  ...extra,
})

export type OptionDecisionInput = {
  decision: Decision
  decisionId: string
  phase: Phase
  risk: RiskState
  account: AlpacaAccount
  chains: Map<string, ChainContract>
  entriesBlocked: string | null
  tradesLeft: number
}

export const executeOptionDecision = async (ctx: TradingContext, i: OptionDecisionInput): Promise<OptionOutcome> => {
  const d = i.decision
  if (d.action === "buy_option") return openFromDecision(ctx, i)
  const doc = d.structure_id ? await ctx.col.optionPositions.findOne({ _id: d.structure_id, status: "open" }) : null
  if (!doc) return { status: "rejected", reason: `no open options position ${d.structure_id ?? "(missing structure_id)"}`, checks: [{ name: "position", ok: false, detail: "no such open options position" }] }
  if (d.action === "close_option") {
    const closed = await closeOptionPosition(ctx, doc, "ai", { urgent: false, decisionId: i.decisionId })
    return closed.ok
      ? { status: "executed", reason: closed.detail, price: closed.exitPrice, qty: doc.qty, order_ids: closed.orderIds, option: decisionDetail(doc, { structure_id: doc._id, contracts: doc.qty }) }
      : { status: "failed", reason: closed.detail, order_ids: closed.orderIds }
  }
  // hold_option: keep it, optionally tightening the underlying stop (it only moves in the trade's favor) or moving the target.
  const bull = isBullish(doc.strategy)
  const changes: Partial<OptionPositionDoc> = {}
  const notes: string[] = []
  if (d.stop_loss !== null && d.stop_loss !== doc.underlying_stop) {
    const tighter = doc.underlying_stop === null || (bull ? d.stop_loss > doc.underlying_stop : d.stop_loss < doc.underlying_stop)
    if (tighter) {
      changes.underlying_stop = d.stop_loss
      notes.push(`underlying stop ${doc.underlying_stop ?? "none"} → ${d.stop_loss}`)
    } else notes.push(`underlying stop ${d.stop_loss} would loosen ${doc.underlying_stop}; kept`)
  }
  if (d.take_profit !== null && d.take_profit !== doc.underlying_target) {
    changes.underlying_target = d.take_profit
    notes.push(`underlying target → ${d.take_profit}`)
  }
  if (Object.keys(changes).length) await ctx.col.optionPositions.updateOne({ _id: doc._id }, { $set: { ...changes, updated_at: new Date() } })
  return { status: "noop", reason: ["holding", ...notes].join("; "), option: decisionDetail(doc, { structure_id: doc._id, contracts: doc.qty }) }
}

const openFromDecision = async (ctx: TradingContext, i: OptionDecisionInput): Promise<OptionOutcome> => {
  const { col, alpaca, settings, bus, prices } = ctx
  const s = settings.current.options
  const d = i.decision
  const o = d.option
  const open = await col.optionPositions.find({ status: { $in: ["opening", "open", "closing"] } }).toArray()
  const premiumOpen = open.reduce((sum, p) => sum + (p.mark ? p.mark.value * OPTION_MULTIPLIER * p.qty : (p.cost_usd ?? 0)), 0)
  const long = o ? i.chains.get(o.long_leg) : undefined
  const short = o?.short_leg ? i.chains.get(o.short_leg) : undefined
  const evaluation = evaluateOptionEntry({
    decision: d,
    phase: i.phase,
    settings: settings.current,
    risk: i.risk,
    entriesBlocked: i.entriesBlocked,
    tradesLeft: i.tradesLeft,
    openPositions: open.length,
    premiumOpenUsd: premiumOpen,
    optionsBuyingPower: i.account.options_buying_power ? Number(i.account.options_buying_power) : null,
    long,
    short,
    underlyingPrice: prices.fresh(d.symbol, 120_000),
  })
  if (!evaluation.approved || !o || !long) return { status: "rejected", reason: evaluation.reason, checks: evaluation.checks }

  const legs: OptionLeg[] = [
    { symbol: long.symbol, type: long.type, strike: long.strike, expiration: long.expiration, side: "long", fill_price: null },
    ...(isSpread(o.strategy) && short ? [{ symbol: short.symbol, type: short.type, strike: short.strike, expiration: short.expiration, side: "short" as const, fill_price: null }] : []),
  ]
  const now = new Date()
  const doc: OptionPositionDoc = {
    _id: randomUUID(),
    underlying: d.symbol,
    strategy: o.strategy,
    legs,
    qty: evaluation.contracts,
    status: "opening",
    entry_price: null,
    cost_usd: evaluation.cost,
    max_loss_usd: evaluation.cost,
    max_profit_usd: evaluation.maxProfit,
    stop_loss_pct: o.stop_loss_pct ?? s.default_stop_loss_pct,
    take_profit_pct: o.take_profit_pct ?? s.default_take_profit_pct,
    underlying_stop: evaluation.underlyingStop,
    underlying_target: evaluation.underlyingTarget,
    expiration: long.expiration,
    thesis: d.rationale,
    invalidation: d.invalidation,
    decision_id: i.decisionId,
    entry_order_id: null,
    exit_order_id: null,
    opened_at: now,
    updated_at: now,
    closed_at: null,
    exit_price: null,
    exit_reason: null,
    realized_pnl_usd: null,
    mark: null,
  }
  await col.optionPositions.insertOne(doc)
  const detail = (extra: Partial<DecisionOptionDetail> = {}) =>
    decisionDetail(doc, { structure_id: doc._id, contracts: evaluation.contracts, limit_price: evaluation.limit, cost_usd: evaluation.cost, max_loss_usd: evaluation.cost, max_profit_usd: evaluation.maxProfit, ...extra })

  const spec: OrderSpec = { legs, qty: evaluation.contracts, action: "open", limit: evaluation.limit }
  let order: AlpacaOrder
  try {
    order = await submitOption(ctx, spec, "opt-buy")
  } catch (error) {
    await col.optionPositions.deleteOne({ _id: doc._id })
    return { status: "failed", reason: `order rejected: ${errorMessage(error).slice(0, 300)}`, checks: evaluation.checks, option: detail() }
  }
  emitSubmitted(ctx, order, doc, spec, "entry")
  await col.optionPositions.updateOne({ _id: doc._id }, { $set: { entry_order_id: order.id } })
  const final = await fillOrCancel(ctx, order, s.fill_timeout_seconds * 1000)
  await saveOrders(col, [final], { decisionId: i.decisionId, structureId: doc._id })
  const filledQty = Math.floor(Number(final.filled_qty || 0))
  if (filledQty <= 0) {
    await col.optionPositions.deleteOne({ _id: doc._id })
    const reason = final.status === "rejected" ? "order rejected by the broker" : `not filled at $${evaluation.limit.toFixed(2)} within ${s.fill_timeout_seconds}s; canceled`
    return { status: final.status === "rejected" ? "failed" : "noop", reason, checks: evaluation.checks, order_ids: [final.id], option: detail() }
  }
  const { net, perLeg } = netFill(final, legs)
  const entry = net ?? evaluation.limit
  const cost = round2(entry * OPTION_MULTIPLIER * filledQty)
  const width = legs.length === 2 ? Math.abs(legs[0].strike - legs[1].strike) : null
  await col.optionPositions.updateOne(
    { _id: doc._id },
    {
      $set: {
        status: "open",
        qty: filledQty,
        entry_price: roundTo(entry, 4),
        cost_usd: cost,
        max_loss_usd: cost,
        max_profit_usd: width !== null ? round2((width - entry) * OPTION_MULTIPLIER * filledQty) : doc.strategy === "long_put" ? round2((legs[0].strike - entry) * OPTION_MULTIPLIER * filledQty) : null,
        legs: legs.map((l) => ({ ...l, fill_price: perLeg.get(l.symbol) ?? null })),
        opened_at: new Date(),
        updated_at: new Date(),
      },
    },
  )
  bus.emit(
    "position.opened",
    { symbol: d.symbol, asset_class: "us_option", qty: filledQty, price: roundTo(entry, 2), structure_id: doc._id },
    { summary: `Opened ${STRATEGY_LABEL[o.strategy].toLowerCase()} on ${d.symbol}: ${filledQty} × ${legs.map((l) => describeContract(l.symbol)).join(" / ")} at $${entry.toFixed(2)}`, instrument: d.symbol },
  )
  return {
    status: "executed",
    reason: [`bought ${filledQty} ${filledQty === 1 ? "contract" : "contracts"} at $${entry.toFixed(2)} ($${cost.toFixed(0)})`, ...evaluation.notes].join("; "),
    checks: evaluation.checks,
    price: roundTo(entry, 4),
    qty: filledQty,
    notional: cost,
    stop_loss: evaluation.underlyingStop,
    take_profit: evaluation.underlyingTarget,
    order_ids: [final.id],
    option: detail({ contracts: filledQty, cost_usd: cost, max_loss_usd: cost }),
  }
}

// ─── Closing ─────────────────────────────────────────────────────────────────

export type CloseResult = { ok: boolean; detail: string; exitPrice: number | null; orderIds: string[] }

/**
 * Closes an options position. Non-urgent exits (targets, AI decisions) first try a limit between the
 * midpoint and the bid; anything not filled in time, and every urgent exit (stops, time stop,
 * kill switch), goes at market.
 */
export const closeOptionPosition = async (
  ctx: TradingContext,
  doc: OptionPositionDoc,
  kind: ProtectionKind,
  { urgent, decisionId = null }: { urgent: boolean; decisionId?: string | null },
): Promise<CloseResult> => {
  const { col, alpaca, bus, settings } = ctx
  const s = settings.current.options
  const claimed = await col.optionPositions.findOneAndUpdate({ _id: doc._id, status: "open" }, { $set: { status: "closing", updated_at: new Date() } }, { returnDocument: "after" })
  if (!claimed) return { ok: false, detail: "already closing or closed", exitPrice: null, orderIds: [] }
  const orderIds: string[] = []
  const reopen = async (detail: string): Promise<CloseResult> => {
    await col.optionPositions.updateOne({ _id: doc._id }, { $set: { status: "open", updated_at: new Date() } })
    return { ok: false, detail, exitPrice: null, orderIds }
  }
  try {
    let final: AlpacaOrder | null = null
    if (!urgent) {
      const snaps = await alpaca.getOptionSnapshots(doc.legs.map((l) => l.symbol)).catch(() => ({}))
      const q = structureQuote(doc.legs, snaps)
      if (q && q.mid > 0) {
        const limit = Math.max(0.01, q.mid - s.entry_aggression * Math.max(0, q.mid - q.exitValue))
        const spec: OrderSpec = { legs: doc.legs, qty: doc.qty, action: "close", limit }
        const order = await submitOption(ctx, spec, "opt-sell")
        orderIds.push(order.id)
        emitSubmitted(ctx, order, doc, spec, kind)
        final = await fillOrCancel(ctx, order, 20_000)
        await saveOrders(col, [final], { decisionId, structureId: doc._id })
        if (Number(final.filled_qty || 0) < doc.qty) final = null
      }
    }
    if (!final) {
      const spec: OrderSpec = { legs: doc.legs, qty: doc.qty, action: "close", limit: null }
      const order = await submitOption(ctx, spec, "opt-sell")
      orderIds.push(order.id)
      emitSubmitted(ctx, order, doc, spec, kind)
      final = await waitForFill(alpaca, order, 30_000)
      await saveOrders(col, [final], { decisionId, structureId: doc._id })
      if (final.status !== "filled") {
        // Never leave a stray exit working: the next check places a fresh one.
        if (!FINAL.has(final.status)) await alpaca.cancelOrder(final.id).catch(() => undefined)
        return reopen(`exit order ${final.status} (not filled); will retry`)
      }
    }
    const { net } = netFill(final, doc.legs)
    const exit = net ?? 0
    const realized = doc.entry_price !== null ? round2((exit - doc.entry_price) * OPTION_MULTIPLIER * doc.qty) : null
    await col.optionPositions.updateOne(
      { _id: doc._id },
      { $set: { status: "closed", exit_order_id: final.id, exit_price: roundTo(exit, 4), exit_reason: kind, realized_pnl_usd: realized, closed_at: new Date(), updated_at: new Date() } },
    )
    const returnPct = realized !== null && doc.cost_usd ? round2((realized / doc.cost_usd) * 100) : null
    bus.emit(
      "position.closed",
      { symbol: doc.underlying, asset_class: "us_option", realized_pnl_usd: realized, return_pct: returnPct, reason: kind, structure_id: doc._id },
      { summary: `Closed ${STRATEGY_LABEL[doc.strategy].toLowerCase()} on ${doc.underlying} at $${exit.toFixed(2)}${realized !== null ? ` (${realized >= 0 ? "+" : "−"}$${Math.abs(realized).toFixed(2)})` : ""}`, instrument: doc.underlying },
    )
    return { ok: true, detail: `closed ${doc.qty} at $${exit.toFixed(2)}${realized !== null ? `, realized ${realized >= 0 ? "+" : "−"}$${Math.abs(realized).toFixed(2)}` : ""}`, exitPrice: roundTo(exit, 4), orderIds }
  } catch (error) {
    return reopen(`exit failed: ${errorMessage(error).slice(0, 300)}`)
  }
}

// ─── Monitoring ──────────────────────────────────────────────────────────────

/**
 * Marks every open options position to market and closes those whose exits have been hit. Runs
 * every `monitor_seconds` regardless of pause or AI state; exits only fire while the market is open.
 */
export const monitorOptions = async (ctx: TradingContext, { marketOpen, now = new Date() }: { marketOpen: boolean; now?: Date }) => {
  const { col, alpaca, prices, bus, alerts, settings } = ctx
  const open = await col.optionPositions.find({ status: { $in: ["open", "closing"] } }).toArray()
  if (!open.length) return []
  // A "closing" position whose close never finished (engine restart) goes back to open after 2 minutes.
  for (const doc of open.filter((d) => d.status === "closing" && now.getTime() - d.updated_at.getTime() > 120_000)) {
    await col.optionPositions.updateOne({ _id: doc._id, status: "closing" }, { $set: { status: "open", updated_at: now } })
    doc.status = "open"
  }
  const snaps = await alpaca.getOptionSnapshots([...new Set(open.flatMap((d) => d.legs.map((l) => l.symbol)))])
  const missing = [...new Set(open.map((d) => d.underlying))].filter((u) => prices.fresh(u, 60_000) === null)
  const stockSnaps = missing.length ? await alpaca.getSnapshots(missing).catch(() => ({}) as Record<string, never>) : {}
  const underlyingPrice = (u: string) => {
    const live = prices.fresh(u, 60_000)
    if (live !== null) return live
    const snap = (stockSnaps as Record<string, { latestTrade?: { p: number } }>)[u]
    return snap?.latestTrade?.p ?? null
  }
  const today = marketDay(now)
  const nowEt = marketClock(now)
  const notes: string[] = []
  for (const doc of open) {
    const q = structureQuote(doc.legs, snaps)
    const up = underlyingPrice(doc.underlying)
    if (q && doc.entry_price !== null) {
      const pnl = round2((q.mid - doc.entry_price) * OPTION_MULTIPLIER * doc.qty)
      await col.optionPositions.updateOne(
        { _id: doc._id },
        { $set: { mark: { value: q.mid, exit_value: q.exitValue, pnl_usd: pnl, pnl_pct: doc.entry_price > 0 ? round2((q.mid / doc.entry_price - 1) * 100) : 0, underlying_price: up, delta: q.delta, at: now } } },
      )
    }
    if (!marketOpen || doc.status !== "open") continue
    const trigger = exitTrigger(doc, q, up, { today, nowEt, closeAtDte: settings.current.options.close_at_dte })
    if (!trigger) continue
    bus.emit("protection.triggered", { symbol: doc.underlying, kind: trigger.kind, price: q?.mid ?? null, structure_id: doc._id }, { summary: `${doc.underlying} options exit: ${trigger.detail}`, instrument: doc.underlying, level: "warn" })
    const result = await closeOptionPosition(ctx, doc, trigger.kind, { urgent: trigger.urgent })
    notes.push(`${doc.underlying} ${trigger.kind}: ${result.detail}`)
    if (!result.ok) await alerts.send("error", `Couldn't close ${doc.underlying} options position`, `${trigger.detail}. ${result.detail}`, { path: "/trades?tab=options", key: `opt-close|${doc._id}` })
  }
  return notes
}

/** Closes every open options position at market (kill switch, daily loss limit). */
export const liquidateOptions = async (ctx: TradingContext, kind: ProtectionKind): Promise<string[]> => {
  const open = await ctx.col.optionPositions.find({ status: "open" }).toArray()
  const notes: string[] = []
  for (const doc of open) {
    const result = await closeOptionPosition(ctx, doc, kind, { urgent: true })
    notes.push(`${doc.underlying} ${STRATEGY_LABEL[doc.strategy].toLowerCase()}: ${result.detail}`)
  }
  return notes
}

/**
 * Compares the options books with the broker. A position the broker no longer has (closed by hand,
 * exercised, assigned) is closed in the books; an option position the books don't know is reported.
 */
export const reconcileOptions = async (ctx: TradingContext, brokerPositions: AlpacaPosition[], now = new Date()): Promise<string[]> => {
  const { col, alerts, bus } = ctx
  const options = brokerPositions.filter((p) => p.asset_class === "us_option" || isOptionSymbol(p.symbol))
  const qtyBySymbol = new Map(options.map((p) => [p.symbol, Number(p.qty)]))
  const docs = await col.optionPositions.find({ status: "open" }).toArray()
  const notes: string[] = []
  for (const doc of docs) {
    // Give the broker a couple of minutes to show a fresh fill.
    if (now.getTime() - doc.opened_at.getTime() < 120_000) continue
    const present = doc.legs.every((l) => (l.side === "long" ? (qtyBySymbol.get(l.symbol) ?? 0) > 0 : (qtyBySymbol.get(l.symbol) ?? 0) < 0))
    if (present) continue
    await col.optionPositions.updateOne({ _id: doc._id, status: "open" }, { $set: { status: "closed", exit_reason: "closed at the broker", closed_at: now, updated_at: now } })
    bus.emit("position.closed", { symbol: doc.underlying, asset_class: "us_option", realized_pnl_usd: null, return_pct: null, reason: "closed at the broker", structure_id: doc._id }, { summary: `${doc.underlying} options position is gone at the broker; closed in the books`, level: "warn", instrument: doc.underlying })
    notes.push(`${doc.underlying}: position missing at the broker; marked closed`)
    await alerts.send("warning", `${doc.underlying} options position closed outside the bot`, `The broker no longer holds ${doc.legs.map((l) => l.symbol).join(" / ")}. It was closed by hand, exercised or assigned.`, { path: "/trades?tab=options", key: `opt-missing|${doc._id}` })
  }
  const known = new Set((await col.optionPositions.find({ status: { $in: ["opening", "open", "closing"] } }, { projection: { legs: 1 } }).toArray()).flatMap((d) => d.legs.map((l) => l.symbol)))
  const unknown = options.filter((p) => !known.has(p.symbol))
  if (unknown.length) {
    await alerts.send("warning", "Untracked options positions", `The broker holds ${unknown.map((p) => `${p.qty} × ${p.symbol}`).join(", ")}, which the bot didn't open. They are not monitored; close them in the Alpaca dashboard.`, { path: "/trades?tab=options", key: `opt-unknown|${unknown.map((p) => p.symbol).join(",")}` })
  }
  return notes
}
