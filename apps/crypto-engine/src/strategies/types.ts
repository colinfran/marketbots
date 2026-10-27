import type { CandidateRecord, RegimeSnapshot } from "@mb/crypto-core/db"
import type { Settings } from "@mb/crypto-core/settings"
import type { StrategyId } from "@mb/crypto-core/strategies"
import type { Features } from "../market/features"

/**
 * Strategy interface. A strategy screens deterministic features and proposes candidates, each
 * with a signal description and suggested exit levels. It never places an order: candidates go to
 * AI research and the AI decision, then to the risk engine.
 */

export type StrategyContext = {
  regime: RegimeSnapshot
  features: Features[]
  held: ReadonlySet<string>
  settings: Settings
}

export type CryptoCandidate = CandidateRecord & {
  symbol: string
  stop_hint: number
  target_hint: number
}

export type CryptoStrategy = {
  id: StrategyId
  screen: (ctx: StrategyContext) => CryptoCandidate[]
}

/** Summarizes features into the record stored with the cycle (no raw series). */
export const candidateFeatures = (f: Features): CandidateRecord["features"] => ({
  price: f.price,
  ret_24h_pct: f.ret_24h_pct,
  ret_7d_pct: f.ret_7d_pct,
  rsi14_1h: f.rsi14_1h,
  rsi14_4h: f.rsi14_4h,
  atr_pct_1h: f.atr_pct_1h,
  trend_4h: f.trend_4h,
  trend_1d: f.trend_1d,
  spread_bps: f.spread_bps,
  move_zscore_24h: f.move_zscore_24h,
  volume_ratio_24h: f.volume_ratio_24h,
})

export const clampScore = (score: number) => Math.round(Math.max(0, Math.min(100, score)))

/** Stop below price by `distance`, kept within the configured stop bounds. */
export const boundedStop = (price: number, distance: number, settings: Settings) => {
  const minDist = (price * settings.kraken.min_stop_pct) / 100
  const maxDist = (price * settings.kraken.max_stop_pct) / 100
  return price - Math.min(maxDist, Math.max(minDist, distance))
}
