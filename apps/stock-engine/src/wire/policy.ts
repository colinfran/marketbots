import { recentMacro } from "./calendar"
import { isConfirmed } from "./notable"
import type { Candidate, Rules } from "./trigger"

export { WirePolicy, type Candidate } from "./trigger"

/**
 * The stock trigger rules (MASTER_PLAN §3.5). They only say what an item could justify; the
 * shared gates in wire/trigger.ts decide whether it fires now, waits, or is held back, and record
 * why. Event cycles run only in the regular session (the engine's session gate): outside it,
 * bad news about a holding still sends an alert at once, and everything lands in the next phase's
 * dossier anyway.
 */

/** Categories that are bad news for a holder whatever the wording. */
const NEGATIVE = new Set(["bankruptcy", "restatement", "delisting_notice", "late_filing", "short_report", "offering", "antitrust", "lawsuit", "cyber_incident", "exec_departure"])
/** Categories that can start an entry on good news. */
const ENTRY = new Set(["m_and_a", "fda", "earnings", "guidance", "index_change", "analyst_action", "insider_buy", "general"])
const POLICY = new Set(["policy_shock", "macro_release"])

/**
 * Context that only goes in the dossier (§3.5): odds swings (unless critical, below), attention
 * spikes, insider buying including `insider_cluster` (an idea for the next cycle, `meta.insider`),
 * congressional trades (disclosed weeks late, `meta.congress`), and our own readings
 * (`meta.metric`: VIX, yields, weak auctions, EIA, COT, short volume). None of these starts a
 * cycle; `market_shock` (SPY/QQQ's own move) is what reacts to the market.
 */
const isContext = (item: { category: string; meta: Record<string, unknown> }) =>
  item.category === "sentiment_spike" || item.meta.insider === true || item.meta.congress === true || item.meta.metric !== undefined

export const stockRules: Rules = async (item, ctx) => {
  const t = ctx.settings.wire.thresholds
  const s = item.severity
  const heldSyms = item.symbols.filter((x) => ctx.held.has(x))
  const anyHeld = ctx.held.size > 0

  if (item.kind === "anomaly") {
    const a = item.meta.anomaly
    if (a === "market") {
      if (!anyHeld) return []
      return [{ rule: recentMacro(ctx.now, 10).length ? "macro_reaction" : "market_shock", action: "market_review", symbols: [], entry: false }]
    }
    if ((a === "price" || a === "mover") && item.symbols.length === 1) {
      const symbol = item.symbols[0]
      if (ctx.held.has(symbol)) return [{ rule: "held_shock", action: "review", symbols: [symbol], entry: false }]
      if (item.polarity <= 0 || (await ctx.hasRecentNews(symbol))) return []
      return [{ rule: "unexplained_move", action: "gap_fill", symbols: [symbol], entry: true }]
    }
    return []
  }

  if (item.category === "halt") {
    // A halted stock gets no orders; the review comes with the resumption.
    if (!heldSyms.length) return []
    const resumed = typeof item.meta.resumes_at === "string" && item.meta.resumes_at !== ""
    return resumed
      ? [{ rule: "halt", action: "review", symbols: heldSyms, entry: false, alert: true, alertWhenClosed: true }]
      : [{ rule: "halt", action: "alert_only", symbols: heldSyms, entry: false, alert: true }]
  }

  // Fed, CPI and recession odds are context, except a critical swing while we hold something.
  if (item.category === "odds_swing") {
    return s >= t.critical && anyHeld ? [{ rule: "odds_swing", action: "market_review", symbols: [], entry: false }] : []
  }
  if (isContext(item)) return []

  const out: Candidate[] = []
  const official = item.tier === 1 && (item.source.startsWith("gov:") || item.source === "truth_social")
  if (official && POLICY.has(item.category) && s >= t.review && anyHeld) {
    out.push({ rule: "policy_shock", action: "market_review", symbols: [], entry: false, alertWhenClosed: true })
  }
  const bad = item.polarity < 0 || NEGATIVE.has(item.category)
  if (heldSyms.length && bad && s >= t.review) {
    out.push({ rule: "held_negative", action: "review", symbols: heldSyms, entry: false, alertWhenClosed: true, emergency: s >= t.critical && isConfirmed(item) })
  }
  const entrySyms = item.symbols.filter((x) => !ctx.held.has(x))
  if (entrySyms.length && entrySyms.length <= 3 && item.polarity > 0 && s >= t.evaluate && ENTRY.has(item.category)) {
    out.push({ rule: "entry_event", action: "evaluate", symbols: entrySyms, entry: true })
  }
  return out
}
