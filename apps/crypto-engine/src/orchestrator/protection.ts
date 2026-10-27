import { errorMessage } from "@mb/engine-kit/log"
import type { EngineContext } from "./context"
import { exitPosition } from "./trading"

/**
 * Deterministic position protection. The paper wallet has no stop orders, so the engine watches
 * every open position against the live order book and exits when a level is crossed:
 *
 * - stop-loss: bid ≤ stop → market sell (getting out matters more than the price);
 * - take-profit: bid ≥ target → sell with the slippage guard (no reason to give it back).
 *
 * It runs every few seconds regardless of pause, halt or AI state, and never triggers on stale
 * quotes (a stale bid could be anywhere).
 */

const MAX_QUOTE_AGE_S = 30

export const checkProtection = async (ctx: EngineContext, inFlight: Set<string>) => {
  for (const p of await ctx.ledger.openPositions()) {
    if (inFlight.has(p._id)) continue
    const q = ctx.hub.quote(p.symbol)
    if (!q || q.ageS > MAX_QUOTE_AGE_S) continue
    const kind = p.stop_price !== null && q.bid <= p.stop_price ? "stop_loss" : p.take_profit_price !== null && q.bid >= p.take_profit_price ? "take_profit" : null
    if (!kind) continue
    inFlight.add(p._id)
    try {
      ctx.bus.emit(
        "protection.triggered",
        { position_id: p._id, instrument: p.symbol, kind, price: q.bid },
        { summary: `${kind === "stop_loss" ? "Stop-loss" : "Take-profit"} triggered on ${p.symbol} at ${q.bid}`, level: kind === "stop_loss" ? "warn" : "info", instrument: p.symbol },
      )
      ctx.setCycleState("position_monitoring", `${kind} ${p.symbol}`)
      const report = await exitPosition(ctx, p, { purpose: kind, market: kind === "stop_loss" })
      if (!report || report.order.filled_qty <= 0) {
        await ctx.alerts.send("warning", `${kind === "stop_loss" ? "Stop-loss" : "Take-profit"} exit on ${p.symbol} did not fill`, report?.order.reason ?? "no order placed", { key: `protect|${p._id}` })
      }
    } catch (error) {
      await ctx.alerts.send("error", `Protective exit on ${p.symbol} failed`, errorMessage(error), { key: `protect|${p._id}` })
    } finally {
      inFlight.delete(p._id)
    }
  }
}
