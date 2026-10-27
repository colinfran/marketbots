import type { OrderDoc } from "@mb/crypto-core/db"
import { UncertainRequestError } from "@mb/engine-kit/util/http"
import type { MarketHub } from "../market/hub"
import { KrakenCliError, type KrakenCli } from "../venues/kraken/cli"
import { formatQty } from "../venues/kraken/pairs"
import type { SubmitResult, VenueExecution } from "./executor"

/**
 * Executes orders in the Kraken CLI paper wallet. The wallet only knows market and limit orders
 * and fills at the top of the live ticker, so the engine adds what a real desk would:
 *
 * - a pre-trade price guard: an order carrying a limit isn't sent if the live book (WebSocket)
 *   already shows a worse price, i.e. immediate-or-cancel semantics on top of a market order;
 * - stops and take-profits are watched by the engine (see orchestrator/protection), which sends
 *   market sells here when they trigger.
 */
export class PaperWalletExecution implements VenueExecution {
  constructor(
    private readonly cli: KrakenCli,
    private readonly hub: MarketHub,
  ) {}

  async submit(order: OrderDoc): Promise<SubmitResult> {
    const pair = this.hub.pairs.get(order.symbol)
    if (!pair) return { status: "rejected", venueOrderId: null, fills: [], reason: `unknown pair ${order.symbol}` }
    if (order.limit_price !== null) {
      const quote = this.hub.quote(order.symbol)
      if (!quote) return { status: "canceled", venueOrderId: null, fills: [], reason: "no live quote for the pre-trade price check" }
      if (order.side === "buy" && quote.ask > order.limit_price) {
        return { status: "canceled", venueOrderId: null, fills: [], reason: `ask ${quote.ask} moved above the limit ${order.limit_price} before execution` }
      }
      if (order.side === "sell" && quote.bid < order.limit_price) {
        return { status: "canceled", venueOrderId: null, fills: [], reason: `bid ${quote.bid} moved below the limit ${order.limit_price} before execution` }
      }
    }
    try {
      const fill = await this.cli.marketOrder(order.side, order.symbol, formatQty(pair, order.qty))
      return {
        status: "filled",
        venueOrderId: fill.orderId || null,
        fills: [{ qty: fill.volume, price: fill.price, feeUsd: fill.fee, venueTradeId: fill.tradeId || null }],
        reason: null,
      }
    } catch (error) {
      if (error instanceof KrakenCliError) {
        // The wallet refused (e.g. insufficient balance): nothing happened.
        if (error.kind === "rejected") return { status: "rejected", venueOrderId: null, fills: [], reason: error.message }
        // Timed out or crashed mid-order: it may or may not have filled.
        if (error.kind === "timeout" || error.kind === "failed" || error.kind === "bad_output") throw new UncertainRequestError(error.message, error)
      }
      throw error
    }
  }
}
