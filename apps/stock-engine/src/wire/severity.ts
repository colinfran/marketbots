// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import { CATEGORY_BASE, TIER_FACTOR, type WireCategory, type WireTier } from "@mb/stock-core/wire"

/**
 * Severity, 0-100, with every part kept for the audit trail and tuning:
 *   base          category base (or an adapter's override, e.g. a price shock scaled by z) × tier factor
 *   relevance     +20 held, +8 candidate / watchlist / universe, +5 market-wide
 *   confirmation  +8 per additional independent domain, up to +16
 *   anomaly       points for a matching price or volume anomaly on the same symbol within ±15 min
 */

export type SeverityInput = {
  category: WireCategory
  tier: WireTier
  baseOverride?: number
  held: boolean
  candidate: boolean
  marketWide: boolean
  confirmations: number
  anomalyPoints: number
}

export const scoreSeverity = (i: SeverityInput): { severity: number; parts: Record<string, number> } => {
  const base = Math.round((i.baseOverride ?? CATEGORY_BASE[i.category]) * TIER_FACTOR[i.tier] * 10) / 10
  const relevance = i.held ? 20 : i.candidate ? 8 : i.marketWide ? 5 : 0
  const confirmation = Math.min(16, 8 * Math.max(0, i.confirmations))
  const parts = { base, relevance, confirmation, anomaly: i.anomalyPoints }
  const severity = Math.max(0, Math.min(100, Math.round(base + relevance + confirmation + i.anomalyPoints)))
  return { severity, parts }
}
