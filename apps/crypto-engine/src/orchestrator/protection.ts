import type { PositionDoc } from "@mb/crypto-core/db"
import { errorMessage } from "@mb/engine-kit/log"
import { roundPrice } from "../venues/kraken/pairs"
import type { EngineContext } from "./context"
import { exitPosition } from "./trading"

/**
 * Deterministic position protection. The paper wallet has no stop orders, so the engine watches
 * every open position against the live order book and exits when a level is crossed:
 *
 * - stop-loss: bid ≤ stop → market sell (getting out matters more than the price);
 * - take-profit: bid ≥ target → sell with the slippage guard (no reason to give it back);
 * - trailing: once the bid is a whole initial risk (1R) above the entry, the stop follows it at
 *   that distance, so a winner keeps running and gives back at most 1R of its gain.
 *
 * It runs every few seconds regardless of pause, halt or AI state, and never acts on stale quotes
 * (a stale bid could be anywhere).
 */

const MAX_QUOTE_AGE_S = 30
/** A trailing stop moves only in steps of at least this share of the price (each step is a database write). */
const TRAIL_STEP = 0.0025

/**
 * The trailed stop for a position at `bid`, or null while it doesn't move: its trail is the entry's
 * stop distance (`trail_usd`; for positions from before it, the distance from the entry to a stop
 * still below it), and it starts once the bid is that far above the entry. Stops only move up.
 */
export const trailedStop = (p: Pick<PositionDoc, "avg_price" | "stop_price" | "trail_usd">, bid: number): { stop: number; trail: number } | null => {
  const trail = p.trail_usd ?? (p.stop_price !== null && p.stop_price < p.avg_price ? p.avg_price - p.stop_price : null)
  if (trail === null || !(trail > 0) || bid < p.avg_price + trail) return null
  const stop = bid - trail
  if (p.stop_price !== null && stop < p.stop_price + bid * TRAIL_STEP) return null
  return { stop, trail }
}

export const checkProtection = async (ctx: EngineContext, inFlight: Set<string>) => {
  for (const p of await ctx.ledger.openPositions()) {
    if (inFlight.has(p._id)) continue
    const q = ctx.hub.quote(p.symbol)
    if (!q || q.ageS > MAX_QUOTE_AGE_S) continue
    const kind = p.stop_price !== null && q.bid <= p.stop_price ? "stop_loss" : p.take_profit_price !== null && q.bid >= p.take_profit_price ? "take_profit" : null
    if (!kind) {
      await trail(ctx, p, q.bid)
      continue
    }
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

/** Raises a winner's stop behind the bid (the trailing stop); never lowers one. */
const trail = async (ctx: EngineContext, p: PositionDoc, bid: number) => {
  const next = trailedStop(p, bid)
  const pair = ctx.hub.pairs.get(p.symbol)
  if (!next || !pair) return
  const stop = roundPrice(pair, next.stop)
  if (p.stop_price !== null && stop <= p.stop_price) return
  await ctx.ledger.updatePosition(p._id, { stop_price: stop, trail_usd: next.trail })
  ctx.log.info("trailing stop raised", { symbol: p.symbol, from: p.stop_price, to: stop, bid })
}
