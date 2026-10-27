import { recentMacro } from "./calendar"
import { isConfirmed } from "./notable"
import type { Candidate, Rules } from "./trigger"

export { WirePolicy, type Candidate } from "./trigger"

/**
 * The crypto trigger rules (MASTER_PLAN §3.5). They only say what an item could justify; the
 * shared gates in wire/trigger.ts decide whether it fires now, waits, or is held back, and record why.
 */

/** Categories that never justify a long: you don't buy into a hack, a depeg or an outage. */
const NO_ENTRY = new Set(["exploit", "depeg", "venue_outage", "venue_status", "price_shock", "volume_shock"])

/**
 * Readings that only go in the dossier (§3.5): crowded funding and open interest, the Coinbase
 * premium, attention spikes, liquidation cascades and network stress describe the market; they
 * never start a cycle on their own. (Anomaly items are handled above, before this applies.)
 */
const ANNOTATE_ONLY = new Set(["funding_extreme", "coinbase_premium", "sentiment_spike", "liquidation_cascade", "volume_shock"])

export const cryptoRules: Rules = async (item, ctx) => {
  const t = ctx.settings.wire.thresholds
  const s = item.severity
  const heldSyms = item.symbols.filter((x) => ctx.held.has(x))
  const anyHeld = ctx.held.size > 0
  const out: Candidate[] = []

  if (item.kind === "anomaly") {
    if (item.category === "depeg") return [{ rule: "depeg", action: anyHeld ? "market_review" : "alert_only", symbols: [], entry: false, alert: true }]
    if (item.meta.anomaly === "market") {
      if (!anyHeld) return []
      const rule = recentMacro(ctx.now, 10).length ? "macro_reaction" : "market_shock"
      return [{ rule, action: "market_review", symbols: [], entry: false }]
    }
    if (item.meta.anomaly === "price" && item.symbols.length === 1) {
      const symbol = item.symbols[0]
      if (await ctx.hasRecentNews(symbol)) return []
      const held = ctx.held.has(symbol)
      if (!held && (item.polarity <= 0 || !ctx.universe.has(symbol))) return []
      return [{ rule: "unexplained_move", action: "gap_fill", symbols: [symbol], entry: !held }]
    }
    return []
  }

  if (ANNOTATE_ONLY.has(item.category)) return []
  // A chain losing TVL fast is often the first sign of an exploit: review what we hold on it (no
  // emergency action: the figure comes from one data provider), and never buy it.
  if (item.category === "tvl_drop") {
    return heldSyms.length && s >= t.review ? [{ rule: "exploit_signal", action: "review", symbols: heldSyms, entry: false }] : []
  }
  // Fed and crypto-policy odds are context, except a critical swing while we hold something.
  if (item.category === "odds_swing") {
    return s >= t.critical && anyHeld ? [{ rule: "odds_swing", action: "market_review", symbols: [], entry: false }] : []
  }

  // Never a long into a hack: an exploit only ever triggers a review of what we hold.
  if (item.category === "exploit") {
    if (heldSyms.length && s >= t.review) out.push({ rule: "exploit_signal", action: "review", symbols: heldSyms, entry: false, emergency: s >= t.critical && item.polarity < 0 && isConfirmed(item) })
    return out
  }
  if (item.category === "venue_status" && heldSyms.length) {
    return [{ rule: "venue_status", action: "review", symbols: heldSyms, entry: false, alert: true }]
  }
  if (item.category === "venue_outage") {
    return s >= t.review ? [{ rule: "venue_outage", action: "alert_only", symbols: [], entry: false, alert: true }] : []
  }

  const regulator = item.tier === 1 && (item.source.startsWith("gov:") || item.source === "truth_social")
  if (regulator && s >= t.review && (item.category === "regulatory_action" || item.category === "etf_decision" || item.category === "macro_release")) {
    if (heldSyms.length) out.push({ rule: "regulatory_shock", action: "review", symbols: heldSyms, entry: false })
    else if (!item.symbols.length && anyHeld) out.push({ rule: "regulatory_shock", action: "market_review", symbols: [], entry: false })
  }
  if (!out.length && heldSyms.length && item.polarity <= 0 && s >= t.review) {
    out.push({ rule: "held_negative", action: "review", symbols: heldSyms, entry: false, emergency: s >= t.critical && item.polarity < 0 && isConfirmed(item) })
  }
  const entrySyms = item.symbols.filter((x) => ctx.universe.has(x) && !ctx.held.has(x))
  if (entrySyms.length && item.polarity > 0 && s >= t.evaluate && !NO_ENTRY.has(item.category)) {
    out.push({ rule: item.category === "listing_major" ? "listing_major" : "entry_event", action: "evaluate", symbols: entrySyms, entry: true })
  }
  return out
}
