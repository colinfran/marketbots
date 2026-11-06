import type { Level } from "../venues/kraken/book"

/**
 * Expected value, costs and position sizing, all in code. The AI supplies probabilities and
 * levels; these functions decide what they're worth after costs and how much to risk.
 */

export type BookWalk = { filledQty: number; avgPrice: number | null; worstPrice: number | null; notional: number }

/** Simulates taking liquidity: walks price levels (asks for buys, bids for sells) up to `limit`. */
export const walkBook = (levels: Level[], qty: number, limit: number | null, side: "buy" | "sell"): BookWalk => {
  let remaining = qty
  let notional = 0
  let worst: number | null = null
  for (const level of levels) {
    if (remaining <= 1e-12) break
    if (limit !== null && (side === "buy" ? level.price > limit : level.price < limit)) break
    const take = Math.min(remaining, level.qty)
    notional += take * level.price
    remaining -= take
    worst = level.price
  }
  const filled = qty - Math.max(0, remaining)
  return { filledQty: filled, avgPrice: filled > 0 ? notional / filled : null, worstPrice: worst, notional }
}

/** Slippage of a market-style fill vs the mid, in bps (positive = worse than mid). */
export const slippageBps = (avgPrice: number, mid: number, side: "buy" | "sell") =>
  mid > 0 ? ((side === "buy" ? avgPrice - mid : mid - avgPrice) / mid) * 10_000 : 0

export type CryptoEdge = {
  stopPct: number
  targetPct: number
  rewardRisk: number
  /** Zero-drift probability of hitting the target before the stop: S / (S + T). */
  pPrior: number
  pAdjusted: number
  grossEdgeBps: number
  netEdgeBps: number
}

/**
 * Expected return of a stop/target trade. With zero drift, p_prior = S/(S+T) makes the gross
 * expectation exactly zero, so any edge comes from the AI's deviation from that prior, shrunk by
 * `shrink` (0.5 = half of what the AI claims) because uncalibrated LLM probabilities are
 * overconfident. Costs (fees, spread, slippage on both legs) come off the top.
 */
export const cryptoEdge = ({
  price,
  stop,
  target,
  pAi,
  shrink,
  roundTripBps,
}: {
  price: number
  stop: number
  target: number
  pAi: number | null
  shrink: number
  roundTripBps: number
}): CryptoEdge | null => {
  if (!(price > 0) || !(stop > 0) || stop >= price || target <= price) return null
  const S = (price - stop) / price
  const T = (target - price) / price
  const pPrior = S / (S + T)
  const pAdjusted = pAi === null ? pPrior : Math.min(0.99, Math.max(0.01, pPrior + shrink * (pAi - pPrior)))
  const grossEdgeBps = (pAdjusted * T - (1 - pAdjusted) * S) * 10_000
  return { stopPct: S * 100, targetPct: T * 100, rewardRisk: T / S, pPrior, pAdjusted, grossEdgeBps, netEdgeBps: grossEdgeBps - roundTripBps }
}

/** Round-trip cost estimate for a spot trade: taker fee both ways, the spread, and slippage both ways. */
export const roundTripCostBps = ({ takerFeeBps, spreadBps, entrySlippageBps, exitSlippageBps }: { takerFeeBps: number; spreadBps: number; entrySlippageBps: number; exitSlippageBps: number }) =>
  2 * takerFeeBps + Math.max(0, spreadBps) + Math.max(0, entrySlippageBps) + Math.max(0, exitSlippageBps)

/**
 * Risk-based size: lose `riskPct` of equity if the stop is hit, capped at the max position. The
 * caller scales `riskPct` by conviction; nothing else cuts it.
 */
export const cryptoSize = ({ equity, price, stop, riskPct, maxPositionPct }: { equity: number; price: number; stop: number; riskPct: number; maxPositionPct: number }) => {
  const perUnitRisk = price - stop
  if (!(equity > 0) || !(perUnitRisk > 0)) return { notional: 0, qty: 0, riskUsd: 0 }
  const riskNotional = ((equity * riskPct) / 100 / perUnitRisk) * price
  const capNotional = (equity * maxPositionPct) / 100
  const notional = Math.min(riskNotional, capNotional)
  const qty = notional / price
  return { notional, qty, riskUsd: qty * perUnitRisk }
}
