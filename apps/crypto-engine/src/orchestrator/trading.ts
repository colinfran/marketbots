import type { OrderPurpose, PositionDoc } from "@mb/crypto-core/db"
import { errorMessage } from "@mb/engine-kit/log"
import type { ExecutionReport } from "../execution/executor"
import { roundPrice, roundQty } from "../venues/kraken/pairs"
import type { EngineContext } from "./context"

/**
 * Exit helpers shared by every caller: AI decisions, stops and targets, the kill switch, manual
 * closes and drawdown halts. Exits are always sized from the position the ledger holds, never
 * from what the AI says it holds.
 */

/** Sells all or part of a position. `market` exits (protective) accept any price; others cap slippage. */
export const exitPosition = async (
  ctx: EngineContext,
  position: PositionDoc,
  { purpose, fraction = 1, decisionId = null, market = false }: { purpose: OrderPurpose; fraction?: number; decisionId?: string | null; market?: boolean },
): Promise<ExecutionReport | null> => {
  const pair = ctx.hub.pairs.get(position.symbol)
  const quote = ctx.hub.quote(position.symbol)
  if (!pair) {
    ctx.log.warn("cannot exit: unknown pair", { symbol: position.symbol, purpose })
    return null
  }
  const qty = fraction >= 0.999 ? position.qty : roundQty(pair, position.qty * fraction)
  if (qty <= 0) return null
  const slip = ctx.settings.current.kraken.max_slippage_bps / 10_000
  return ctx.executor.execute({
    instrument: position.instrument,
    side: "sell",
    qty,
    limitPrice: market || !quote ? null : roundPrice(pair, quote.bid * (1 - slip)),
    referencePrice: quote?.mid ?? position.mark_price,
    purpose,
    decisionId,
    positionId: position._id,
    meta: {},
  })
}

/** Closes every open position at market (kill switch with liquidation, drawdown halt). */
export const liquidateAll = async (ctx: EngineContext, purpose: OrderPurpose): Promise<string[]> => {
  const notes: string[] = []
  for (const p of await ctx.ledger.openPositions()) {
    try {
      const report = await exitPosition(ctx, p, { purpose, market: true })
      notes.push(`${p.instrument}: ${report ? report.order.status : "not exited"}`)
    } catch (error) {
      notes.push(`${p.instrument}: failed (${errorMessage(error)})`)
    }
  }
  return notes
}
