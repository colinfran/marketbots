import { randomUUID } from "node:crypto"
import type { OrderDoc, OrderPurpose, OrderStatus } from "@mb/crypto-core/db"
import { ACCOUNT_ID, MODE, VENUE } from "@mb/crypto-core/venues"
import type { EventBus } from "../bus/event-bus"
import type { Collections } from "../db/mongo"
import { errorMessage, type Logger } from "../log"
import type { FillOutcome, Ledger, PositionMeta } from "../portfolio/ledger"
import { UncertainRequestError } from "../util/http"

/**
 * Order lifecycle:
 *   1. The order is written to MongoDB as `pending_submit` before anything is sent, so a crash
 *      mid-submit leaves a record that reconciliation can match against the wallet's history.
 *   2. The venue adapter executes it (the Kraken CLI paper wallet) and reports the fill.
 *   3. The fill goes through the ledger, then the order gets its final status.
 *
 * Only reported fills move positions. An uncertain outcome (the CLI timed out mid-order) leaves
 * the order `unknown` for reconciliation; it is never retried blindly.
 */

export type OrderIntent = {
  instrument: string
  side: "buy" | "sell"
  qty: number
  /** Pre-trade price guard: don't execute if the market is already worse than this. null = protective exit, any price. */
  limitPrice: number | null
  referencePrice: number | null
  purpose: OrderPurpose
  decisionId: string | null
  positionId: string | null
  meta: PositionMeta
}

export type VenueFill = { qty: number; price: number; feeUsd: number; venueTradeId: string | null; at?: Date }

export type SubmitResult = { status: OrderStatus; venueOrderId: string | null; fills: VenueFill[]; reason: string | null }

export interface VenueExecution {
  submit(order: OrderDoc): Promise<SubmitResult>
}

export type ExecutionReport = { order: OrderDoc; outcomes: FillOutcome[] }

export class Executor {
  constructor(
    private readonly col: Pick<Collections, "orders">,
    private readonly ledger: Ledger,
    private readonly venue: VenueExecution,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  async execute(intent: OrderIntent): Promise<ExecutionReport> {
    const now = new Date()
    const order: OrderDoc = {
      _id: randomUUID(),
      account_id: ACCOUNT_ID,
      venue: VENUE,
      mode: MODE,
      instrument: intent.instrument,
      symbol: intent.instrument,
      side: intent.side,
      type: "market",
      qty: intent.qty,
      limit_price: intent.limitPrice,
      reference_price: intent.referencePrice,
      status: "pending_submit",
      venue_order_id: null,
      filled_qty: 0,
      avg_fill_price: null,
      fees_usd: 0,
      decision_id: intent.decisionId,
      position_id: intent.positionId,
      purpose: intent.purpose,
      created_at: now,
      submitted_at: null,
      updated_at: now,
      reason: null,
      history: [{ at: now, status: "pending_submit", note: null }],
    }
    await this.col.orders.insertOne(order)
    const label = `${intent.side.toUpperCase()} ${intent.qty} ${intent.instrument}`
    this.bus.emit(
      "order.submitted",
      { order_id: order._id, instrument: intent.instrument, side: intent.side, type: order.type, qty: intent.qty, limit_price: intent.limitPrice, purpose: intent.purpose },
      { summary: `[paper] ${label} (${intent.purpose.replace("_", " ")})`, instrument: intent.instrument },
    )

    let result: SubmitResult
    try {
      result = await this.venue.submit(order)
    } catch (error) {
      const uncertain = error instanceof UncertainRequestError
      result = { status: uncertain ? "unknown" : "rejected", venueOrderId: null, fills: [], reason: errorMessage(error).slice(0, 400) }
      this.log.warn("order submit failed", { order_id: order._id, uncertain, error: result.reason })
    }

    const outcomes = await this.recordFills(order, result.fills, intent.meta)
    const final = await this.finalize(order, result, outcomes)
    return { order: final, outcomes }
  }

  /** Records fills for an order (also used by reconciliation to apply fills it discovers). */
  async recordFills(order: OrderDoc, fills: VenueFill[], meta: PositionMeta): Promise<FillOutcome[]> {
    const outcomes: FillOutcome[] = []
    for (const f of fills) {
      try {
        const outcome = await this.ledger.recordFill({ order, qty: f.qty, price: f.price, feeUsd: f.feeUsd, venueTradeId: f.venueTradeId, at: f.at }, meta)
        outcomes.push(outcome)
        this.emitFill(order, outcome, f.qty < order.qty - 1e-12)
      } catch (error) {
        // The wallet says it filled; our books disagree. Reconciliation will flag it, loudly.
        this.log.error("recording fill failed", { order_id: order._id, error: errorMessage(error) })
        this.bus.emit("error", { scope: "ledger", message: `fill for ${order._id} not recorded: ${errorMessage(error)}` }, { summary: "A fill could not be recorded", level: "error", visibility: "owner" })
      }
    }
    return outcomes
  }

  async finalize(order: OrderDoc, result: SubmitResult, outcomes: FillOutcome[]): Promise<OrderDoc> {
    const filledQty = outcomes.reduce((s, o) => s + o.fill.qty, 0)
    const notional = outcomes.reduce((s, o) => s + o.fill.qty * o.fill.price, 0)
    const fees = outcomes.reduce((s, o) => s + o.fill.fee_usd, 0)
    const status: OrderStatus = result.status === "unknown" || result.status === "rejected" ? result.status : filledQty > 0 ? "filled" : "canceled"
    const done = new Date()
    const final: OrderDoc = {
      ...order,
      status,
      venue_order_id: result.venueOrderId ?? order.venue_order_id,
      filled_qty: filledQty,
      avg_fill_price: filledQty > 0 ? notional / filledQty : null,
      fees_usd: fees,
      submitted_at: order.submitted_at ?? done,
      updated_at: done,
      reason: result.reason,
      history: [...order.history, { at: done, status, note: result.reason }],
    }
    await this.col.orders.replaceOne({ _id: order._id }, final)
    const label = `${order.side.toUpperCase()} ${order.qty} ${order.instrument}`
    if (status === "rejected") {
      this.bus.emit("order.rejected", { order_id: order._id, reason: final.reason ?? "rejected" }, { summary: `[paper] ${label} rejected: ${final.reason}`, level: "warn", instrument: order.instrument })
    } else if (status === "canceled") {
      this.bus.emit("order.canceled", { order_id: order._id, reason: final.reason ?? "not executed" }, { summary: `[paper] ${label} not executed: ${final.reason ?? "no fill"}`, level: "warn", instrument: order.instrument })
    } else if (status === "unknown") {
      this.bus.emit("order.updated", { order_id: order._id, status, filled_qty: 0 }, { summary: `[paper] ${label}: outcome unknown, reconciling`, level: "warn", instrument: order.instrument })
    }
    return final
  }

  private emitFill(order: OrderDoc, outcome: FillOutcome, partial: boolean) {
    const { fill, position } = outcome
    this.bus.emit(
      "order.filled",
      { order_id: order._id, fill_id: fill._id, instrument: fill.instrument, side: fill.side, qty: fill.qty, price: fill.price, fee_usd: fill.fee_usd, partial, slippage_bps: fill.slippage_bps },
      { summary: `[paper] ${fill.side === "buy" ? "Bought" : "Sold"} ${fill.qty} ${fill.instrument} @ ${fill.price}`, instrument: fill.instrument },
    )
    if (outcome.opened) {
      this.bus.emit(
        "position.opened",
        { position_id: position._id, instrument: position.instrument, qty: position.qty, avg_price: position.avg_price, stop_price: position.stop_price, take_profit_price: position.take_profit_price, strategy: position.strategy_id },
        { summary: `[paper] Opened ${position.instrument}`, instrument: position.instrument },
      )
    } else if (outcome.closed) {
      this.bus.emit(
        "position.closed",
        { position_id: position._id, instrument: position.instrument, realized_pnl_usd: position.realized_pnl_usd, return_pct: outcome.returnPct, exit_reason: order.purpose },
        { summary: `[paper] Closed ${position.instrument} (${order.purpose.replace("_", " ")})`, instrument: position.instrument },
      )
    } else {
      this.bus.emit(
        "position.updated",
        { position_id: position._id, instrument: position.instrument, qty: position.qty, avg_price: position.avg_price },
        { summary: `[paper] ${position.instrument} position now ${position.qty}`, instrument: position.instrument },
      )
    }
  }
}
