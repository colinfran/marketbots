// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import type { NotableReason, WireItemDoc } from "@mb/stock-core/wire"

/**
 * The one rule for what reaches the Live page. An item is notable when it is VALID:
 *   - first seen within the last 6 hours,
 *   - the first item of its cluster (not a duplicate),
 *   - tier 1, or confirmed, or an anomaly backed by market data,
 * and at least one reason APPLIES:
 *   held      severity ≥ review and it names a symbol the bot holds now
 *   focus     severity ≥ evaluate and it names a candidate, watchlist or owner-requested symbol
 *   market    it names no symbol (market-wide) and severity ≥ review
 *   triggered it fired or queued a trigger        (added later by the policy)
 *   cited     the AI cited it as evidence           (added later, after decision normalization)
 * Everything else stays on the Research page. The web app never decides this itself.
 */

export const NOTABLE_MAX_AGE_MS = 6 * 3_600_000

type Thresholds = { review: number; evaluate: number }
type Item = Pick<WireItemDoc, "_id" | "cluster_id" | "tier" | "kind" | "confirmations" | "severity_parts" | "first_seen_at" | "severity" | "symbols">

/** Entry confirmation (§2 rule 2): tier 1, two independent tier-2 domains, or tier 2 plus a matching price/volume move. */
export const isConfirmed = (item: Pick<WireItemDoc, "tier" | "confirmations" | "severity_parts" | "kind">) => {
  if (item.tier === 1 || item.kind === "anomaly") return true
  const domains = new Set(item.confirmations.map((c) => c.domain)).size
  if (item.tier === 2) return domains >= 1 || (item.severity_parts.anomaly ?? 0) > 0
  return domains >= 2
}

export const isValid = (item: Item, now: Date) =>
  now.getTime() - item.first_seen_at.getTime() <= NOTABLE_MAX_AGE_MS && item.cluster_id === item._id && isConfirmed(item)

export const notableReasons = (item: Item, ctx: { now: Date; held: ReadonlySet<string>; focus: ReadonlySet<string>; thresholds: Thresholds }, extra: NotableReason[] = []): NotableReason[] => {
  if (!isValid(item, ctx.now)) return []
  const reasons = new Set<NotableReason>(extra)
  if (item.severity >= ctx.thresholds.review && item.symbols.some((s) => ctx.held.has(s))) reasons.add("held")
  if (item.severity >= ctx.thresholds.evaluate && item.symbols.some((s) => ctx.focus.has(s))) reasons.add("focus")
  if (item.symbols.length === 0 && item.severity >= ctx.thresholds.review) reasons.add("market")
  return [...reasons]
}
