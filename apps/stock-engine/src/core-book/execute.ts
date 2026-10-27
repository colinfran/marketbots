import { randomUUID } from "node:crypto"
import { errorMessage } from "@mb/engine-kit/log"
import type { AlpacaOrder } from "@mb/stock-core/alpaca"
import { CORE_PLAN_NOTES, type CoreDecisionRecord, type CorePlanNote, type DecisionDoc, type PositionPlanDoc } from "@mb/stock-core/db"
import type { Decision } from "@mb/stock-core/report"
import type { TradingContext } from "../bot/context"
import { cancelSymbolOrders } from "../bot/execute"
import { clientId, saveOrders, waitForFill } from "../bot/orders"
import type { CoreHolding, PlannedDecision } from "./rules"

/**
 * Carries out a planned review (./rules) at the broker, in the plan's order: sells and trims, then
 * buys, then keeps. A dry run places nothing and marks the trades "planned".
 *
 * - Core holdings are protected by a plain GTC stop resting at Alpaca, no take-profit, so a winner
 *   is never sold at a target. A trim re-places the stop for the shares left; a keep that raises
 *   the stop replaces it.
 * - Buys re-read the cash after the sells and never dip into the reserve.
 * - Every trade is also a `decisions` document (trigger_kind "core", report_id = the review), which
 *   its orders link to, so the journal, trades and analytics see it like any other.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const round2 = (n: number) => Math.round(n * 100) / 100

/** Places the resting GTC stop that protects a core holding. */
export const placeCoreStop = async (ctx: Pick<TradingContext, "alpaca" | "col" | "bus">, symbol: string, qty: number, stop: number, decisionId: string | null): Promise<AlpacaOrder> => {
  const order = await ctx.alpaca.submitOrder({ symbol, qty: String(qty), side: "sell", type: "stop", stop_price: stop.toFixed(2), time_in_force: "gtc", client_order_id: clientId("core-stop") })
  await saveOrders(ctx.col, [order], { decisionId })
  ctx.bus.emit(
    "order.submitted",
    { order_id: order.id, symbol, side: "sell", type: "stop", qty, limit_price: null, purpose: "core stop", asset_class: "us_equity" },
    { summary: `${symbol}: core stop set at ${stop.toFixed(2)}`, instrument: symbol },
  )
  return order
}

/** A review note for a holding's plan (the newest CORE_PLAN_NOTES are kept). */
export const pushNote = (note: CorePlanNote) => ({ notes: { $each: [note], $slice: -CORE_PLAN_NOTES } })

export type CoreExecuteInput = {
  reviewId: string
  cycleId: string
  day: string
  plan: PlannedDecision[]
  holdings: ReadonlyMap<string, CoreHolding>
  dryRun: boolean
  /** The cash reserve in dollars: buys never spend it. */
  reserveUsd: number
  now?: Date
}

export const executeCorePlan = async (ctx: TradingContext, input: CoreExecuteInput): Promise<CoreDecisionRecord[]> => {
  const { alpaca, col, bus } = ctx
  const { reviewId, cycleId, day, dryRun } = input
  const now = input.now ?? new Date()
  const records: CoreDecisionRecord[] = []

  for (const p of input.plan) {
    const trade = p.action !== "keep"
    const decisionId = trade && !dryRun ? randomUUID() : null
    const record: CoreDecisionRecord = {
      symbol: p.symbol,
      action: p.action,
      request: p.request,
      status: !p.approved ? "rejected" : !trade ? "noop" : dryRun ? "planned" : "executed",
      reason: p.reason,
      checks: p.checks,
      weight_before_pct: p.weight_before_pct,
      weight_after_pct: p.weight_after_pct,
      price: p.price,
      qty: p.qty,
      notional: p.notional,
      stop: p.stop,
      decision_id: decisionId,
      order_ids: [],
    }
    if (!dryRun && p.approved) {
      try {
        if (p.action === "keep") await keep(p, record)
        else if (p.action === "buy") await buy(p, record, decisionId!)
        else await sell(p, record, decisionId!)
      } catch (error) {
        record.status = "failed"
        record.reason = errorMessage(error).slice(0, 400)
      }
    }
    if (decisionId) await col.decisions.insertOne(decisionDoc(p, record, decisionId))
    if (trade) {
      if (p.checks.length) {
        const approved = p.checks.every((c) => c.ok)
        bus.emit(
          "risk.checked",
          { decision_id: decisionId ?? `${reviewId}:${p.symbol}`, symbol: p.symbol, action: p.action, approved, reasons: p.checks.filter((c) => !c.ok).map((c) => c.detail), checks: p.checks.slice(0, 20), qty: record.qty, notional_usd: record.notional },
          { summary: approved ? `Core rules approved ${p.symbol} ${p.action} (${p.checks.length} checks)` : `Core rules rejected ${p.symbol} ${p.action}: ${p.reason}`, level: approved ? "info" : "warn", cycle_id: cycleId, instrument: p.symbol },
        )
      }
      if (decisionId && record.status !== "planned") {
        bus.emit(
          "decision.result",
          { decision_id: decisionId, symbol: p.symbol, action: p.action, status: record.status as DecisionDoc["status"], reason: record.reason },
          { summary: `${p.symbol} core ${p.action}: ${record.status}${record.reason ? ` (${record.reason})` : ""}`, level: record.status === "failed" ? "warn" : "info", cycle_id: cycleId, instrument: p.symbol },
        )
      }
    }
    records.push(record)
  }
  return records

  function note(p: PlannedDecision): CorePlanNote {
    return { at: now, review_id: reviewId, action: p.action, text: p.request?.verdict || p.reason || p.action }
  }

  async function submit(order: Parameters<TradingContext["alpaca"]["submitOrder"]>[0], purpose: string, decisionId: string) {
    const placed = await alpaca.submitOrder(order)
    bus.emit(
      "order.submitted",
      { order_id: placed.id, symbol: order.symbol!, side: order.side!, type: order.type, qty: Number(order.qty), limit_price: null, purpose, asset_class: "us_equity" },
      { summary: `Order sent: ${order.side} ${order.qty} ${order.symbol} (${purpose})`, cycle_id: cycleId, instrument: order.symbol },
    )
    const filled = await waitForFill(alpaca, placed)
    await saveOrders(col, [filled], { decisionId })
    return filled
  }

  async function sell(p: PlannedDecision, record: CoreDecisionRecord, decisionId: string) {
    const h = input.holdings.get(p.symbol)!
    const qty = p.qty!
    await cancelSymbolOrders(alpaca, p.symbol)
    let filled: AlpacaOrder
    // One client_order_id across attempts: a retry of an order that went through returns it instead of selling twice.
    const id = clientId("core-sell")
    for (let attempt = 0; ; attempt++) {
      try {
        filled = await submit({ symbol: p.symbol, qty: String(qty), side: "sell", type: "market", time_in_force: "day", client_order_id: id }, `core ${p.action}`, decisionId)
        break
      } catch (error) {
        // Shares can stay reserved for a moment after the stop is canceled.
        if (attempt >= 3) throw error
        await sleep(1_000)
      }
    }
    const price = filled.filled_avg_price ? Number(filled.filled_avg_price) : p.price
    record.price = price
    record.notional = price ? round2(qty * price) : null
    record.order_ids.push(filled.id)
    record.reason = [filled.status === "filled" ? `sold ${qty} of ${h.qty} shares` : `sell submitted (status ${filled.status})`, p.reason].filter(Boolean).join("; ")
    const left = h.qty - qty
    if (left < 1) {
      await col.plans.deleteOne({ _id: p.symbol })
      return
    }
    const stop = await placeCoreStop(ctx, p.symbol, left, p.stop!, decisionId)
    record.order_ids.push(stop.id)
    await col.plans.updateOne({ _id: p.symbol }, { $set: { last_reviewed_at: now, updated_at: now }, $push: pushNote(note(p)) })
  }

  async function buy(p: PlannedDecision, record: CoreDecisionRecord, decisionId: string) {
    // The sells have run: size against the cash there is now, never the reserve.
    const account = await alpaca.getAccount()
    const qty = Math.min(p.qty!, Math.floor((Number(account.cash) - input.reserveUsd) / p.price!))
    if (qty < 1) {
      record.status = "rejected"
      record.reason = "not enough cash above the reserve after the sells"
      record.qty = null
      record.notional = null
      return
    }
    const filled = await submit({ symbol: p.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day", client_order_id: clientId("core-buy") }, "core buy", decisionId)
    record.order_ids.push(filled.id)
    if (filled.status === "rejected" || filled.status === "canceled" || filled.status === "expired") {
      record.status = "failed"
      record.reason = `order ${filled.status} by the broker`
      return
    }
    const price = filled.filled_avg_price ? Number(filled.filled_avg_price) : p.price!
    const plan: Omit<PositionPlanDoc, "_id" | "opened_at" | "notes"> = {
      decision_id: decisionId,
      stop_loss: p.stop,
      take_profit: null,
      horizon: "multi_day",
      setup: "core",
      thesis: p.request!.thesis,
      invalidation: p.request!.invalidation,
      updated_at: now,
      book: "core",
      theme: p.theme,
      last_reviewed_at: now,
    }
    await col.plans.updateOne({ _id: p.symbol }, { $set: plan, $setOnInsert: { opened_at: now }, $push: pushNote(note(p)) }, { upsert: true })
    const filledQty = Math.floor(Number(filled.filled_qty))
    record.qty = qty
    record.price = price
    record.notional = round2(qty * price)
    record.reason = [filled.status === "filled" ? `bought ${qty} shares` : `buy submitted (status ${filled.status}); maintenance sets the stop once it fills`, qty < p.qty! ? `cut from ${p.qty} to fit the cash` : null, p.reason]
      .filter(Boolean)
      .join("; ")
    if (filledQty >= 1) record.order_ids.push((await placeCoreStop(ctx, p.symbol, filledQty, p.stop!, decisionId)).id)
  }

  async function keep(p: PlannedDecision, record: CoreDecisionRecord) {
    const h = input.holdings.get(p.symbol)!
    // The first review of a holding writes its thesis; later reviews add notes to it.
    const first = !h.plan.last_reviewed_at && p.request && p.request.action !== "buy"
    await col.plans.updateOne(
      { _id: p.symbol },
      {
        $set: {
          last_reviewed_at: now,
          updated_at: now,
          theme: p.theme,
          stop_loss: p.stop,
          ...(first ? { thesis: p.request!.thesis, invalidation: p.request!.invalidation } : {}),
        },
        $push: pushNote(note(p)),
      },
    )
    if (p.stop_changed && p.stop !== null) {
      await cancelSymbolOrders(alpaca, p.symbol)
      record.order_ids.push((await placeCoreStop(ctx, p.symbol, h.qty, p.stop, null)).id)
      record.reason = [p.reason, `stop ${h.plan.stop_loss ?? "none"} → ${p.stop}`].filter(Boolean).join("; ")
    }
  }

  function decisionDoc(p: PlannedDecision, record: CoreDecisionRecord, id: string): DecisionDoc {
    const h = input.holdings.get(p.symbol)
    const request: Decision = {
      symbol: p.symbol,
      action: p.action === "buy" ? "buy" : "sell",
      allocation_pct: p.action === "buy" ? (p.request?.target_weight_pct ?? null) : null,
      sell_pct: p.action === "buy" ? null : h && p.qty ? round2((p.qty / h.qty) * 100) : 100,
      stop_loss: p.stop,
      take_profit: null,
      horizon: "multi_day",
      setup: "other",
      conviction: p.request?.conviction ?? 5,
      rationale: (p.action === "buy" ? p.request?.thesis : p.request?.verdict) ?? p.reason ?? "",
      evidence: p.request?.evidence ?? [],
      invalidation: p.request?.invalidation ?? "",
      structure_id: null,
      option: null,
    }
    return {
      _id: id,
      cycle_id: cycleId,
      report_id: reviewId,
      phase: "intraday",
      trading_day: day,
      created_at: new Date(),
      symbol: p.symbol,
      instrument: "stock",
      action: request.action,
      trigger_kind: "core",
      request,
      status: record.status === "planned" ? "noop" : record.status,
      reason: record.reason,
      checks: record.checks,
      price: record.price,
      qty: record.qty,
      notional: record.notional,
      stop_loss: record.stop,
      take_profit: null,
      order_ids: record.order_ids,
      option: null,
    }
  }
}
