import type { EvidenceItem } from "@mb/crypto-core/db"
import { clamp, roundTo } from "@mb/crypto-core/math"
import { z } from "zod"

/**
 * Structured output for the AI decision task. As in stockmarketbot, the schemas sent to the
 * model avoid numeric/array bound keywords (providers differ in which JSON-schema keywords they
 * accept); bounds are stated in descriptions and enforced afterwards by the normalize functions.
 *
 * Normalization is also where AI output is constrained to what's allowed: only listed symbols,
 * only actions that make sense for the position state, only source URLs that research actually
 * retrieved. Anything else is dropped or downgraded, never trusted.
 */

export const EVIDENCE_KINDS = ["fact", "sourced_claim", "estimate", "speculation"] as const
export const UNCERTAINTY = ["low", "medium", "high"] as const
export const PRICED_IN = ["not_priced", "partially", "fully", "unknown"] as const
export const REGIMES = ["risk_on_trend", "risk_off_trend", "range", "high_volatility", "unknown"] as const
export const CRYPTO_ACTIONS = ["buy", "hold", "reduce", "close", "no_trade"] as const
/** Longest expected holding period (90 days): long-term trend holds can run for months. */
export const MAX_HORIZON_HOURS = 2_160

export const evidenceSchema = z.object({
  claim: z.string().describe("One concrete statement, with numbers and dates where possible."),
  kind: z
    .enum(EVIDENCE_KINDS)
    .describe(
      "fact = verifiable data (exchange numbers from CONTEXT, official announcements). sourced_claim = reported by a source in RESEARCH. estimate = your own quantitative estimate. speculation = plausible but unverified.",
    ),
  source_url: z.string().nullable().describe("A URL that appears in RESEARCH and supports the claim, or null. Never invent URLs."),
  as_of: z.string().nullable().describe("When the information was published or observed (ISO date/time), or null."),
})

export const cryptoDecisionSchema = z.object({
  symbol: z.string().describe("Pair exactly as listed, e.g. BTC/USD."),
  action: z
    .enum(CRYPTO_ACTIONS)
    .describe("CANDIDATES (not held): buy or no_trade. HELD positions: hold, reduce or close. no_trade is a normal, often correct answer."),
  conviction: z.number().describe("0-100: how strongly the evidence supports the action. It is NOT a probability."),
  uncertainty: z.enum(UNCERTAINTY),
  p_target_first: z
    .number()
    .nullable()
    .describe(
      "BUY only: probability 0-1 that take_profit is hit before stop_loss. A random walk gives stop_distance / (stop_distance + target_distance); deviate from that only as far as the evidence justifies. null otherwise.",
    ),
  stop_loss: z.number().nullable().describe("BUY: stop price below the current price. HELD: a new stop price, or null to keep the current one."),
  take_profit: z.number().nullable().describe("BUY: target price above the current price. HELD: a new target, or null to keep it."),
  horizon_hours: z.number().describe(`Expected holding period in hours (1-${MAX_HORIZON_HOURS}). When it elapses the position is reviewed, not sold.`),
  size_pct_of_max: z
    .number()
    .nullable()
    .describe("BUY only: 10-100, the share of the maximum position size the risk engine allows. Size down when uncertain. null otherwise."),
  reduce_pct: z.number().nullable().describe("REDUCE only: % of the position to sell (10-90); the rest stays open with its stop and target. null otherwise."),
  priced_in: z.enum(PRICED_IN).describe("How much of the thesis or catalyst the price already reflects."),
  thesis: z.string().describe("2-3 sentences: why this action, why now. Cite numbers from CONTEXT or RESEARCH."),
  bull_evidence: z.array(evidenceSchema).describe("1-5 items for upside."),
  bear_evidence: z.array(evidenceSchema).describe("1-5 counterarguments and downside risks. Always include at least one."),
  risks: z.array(z.string()).describe("1-4 key risk factors: event risk, liquidity, correlation with other holdings."),
  invalidation: z.string().describe("The specific price level or event that proves the thesis wrong."),
})

export const cryptoReportSchema = z.object({
  market_read: z.object({
    regime: z.enum(REGIMES),
    summary: z.string().describe("2-3 sentences on the crypto market right now."),
    confidence: z.number().describe("0-100 confidence in this read."),
  }),
  decisions: z.array(cryptoDecisionSchema).describe("Exactly one decision per CANDIDATE and per HELD position listed. Nothing else."),
  data_gaps: z.array(z.string()).describe("Missing, stale or contradictory information that lowered confidence."),
  notification: z.string().describe("One-line summary for the activity feed, max 160 characters."),
})

export type CryptoReport = z.infer<typeof cryptoReportSchema>
export type CryptoDecision = z.infer<typeof cryptoDecisionSchema>

const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
const finitePositive = (v: number | null) => (v !== null && Number.isFinite(v) && v > 0 ? v : null)

/** Keeps only source URLs research actually retrieved, so the dashboard never shows invented links. */
export const normalizeEvidence = (items: z.infer<typeof evidenceSchema>[], allowedUrls: ReadonlySet<string>): EvidenceItem[] =>
  items.slice(0, 5).map((e) => {
    const url = e.source_url?.trim() ?? null
    const verified = !!url && allowedUrls.has(url)
    return {
      claim: truncate(e.claim.trim(), 400),
      // A "sourced claim" without a retrieved source is really unverified.
      kind: e.kind === "sourced_claim" && !verified ? "speculation" : e.kind,
      source_url: verified ? url : null,
      as_of: e.as_of ? truncate(e.as_of, 40) : null,
      verified_source: verified,
    }
  })

export type NormalizedCryptoDecision = Omit<CryptoDecision, "bull_evidence" | "bear_evidence"> & {
  bull_evidence: EvidenceItem[]
  bear_evidence: EvidenceItem[]
  /** Set when normalization changed the AI's answer, e.g. an impossible action. */
  notes: string[]
  defaulted: boolean
}

export type NormalizedCryptoReport = Omit<CryptoReport, "decisions"> & { decisions: NormalizedCryptoDecision[] }

const emptyDecision = (symbol: string, held: boolean, reason: string): NormalizedCryptoDecision => ({
  symbol,
  action: held ? "hold" : "no_trade",
  conviction: 0,
  uncertainty: "high",
  p_target_first: null,
  stop_loss: null,
  take_profit: null,
  horizon_hours: 24,
  size_pct_of_max: null,
  reduce_pct: null,
  priced_in: "unknown",
  thesis: reason,
  bull_evidence: [],
  bear_evidence: [],
  risks: [],
  invalidation: "n/a",
  notes: [reason],
  defaulted: true,
})

export const normalizeCryptoReport = (
  report: CryptoReport,
  { candidates, held, sourceUrls }: { candidates: ReadonlySet<string>; held: ReadonlySet<string>; sourceUrls: ReadonlySet<string> },
): NormalizedCryptoReport => {
  const seen = new Set<string>()
  const decisions: NormalizedCryptoDecision[] = []
  for (const d of report.decisions) {
    const symbol = d.symbol.trim().toUpperCase()
    const isHeld = held.has(symbol)
    if (seen.has(symbol) || (!isHeld && !candidates.has(symbol))) continue // unlisted or duplicate: ignored
    seen.add(symbol)
    const notes: string[] = []
    let action = d.action
    if (isHeld && (action === "buy" || action === "no_trade")) {
      notes.push(`"${action}" on a held position treated as hold (adding to positions is disabled)`)
      action = "hold"
    }
    if (!isHeld && action !== "buy" && action !== "no_trade") {
      notes.push(`"${action}" on a symbol that isn't held treated as no_trade`)
      action = "no_trade"
    }
    let reducePct = action === "reduce" ? clamp(d.reduce_pct ?? 50, 10, 90) : null
    if (action === "reduce" && (d.reduce_pct ?? 0) >= 95) {
      action = "close"
      reducePct = null
    }
    decisions.push({
      ...d,
      symbol,
      action,
      conviction: Math.round(clamp(Number.isFinite(d.conviction) ? d.conviction : 0, 0, 100)),
      p_target_first: action === "buy" && d.p_target_first !== null && Number.isFinite(d.p_target_first) ? clamp(d.p_target_first, 0.01, 0.99) : null,
      stop_loss: finitePositive(d.stop_loss),
      take_profit: finitePositive(d.take_profit),
      horizon_hours: clamp(Number.isFinite(d.horizon_hours) ? d.horizon_hours : 24, 1, MAX_HORIZON_HOURS),
      size_pct_of_max: action === "buy" ? clamp(d.size_pct_of_max ?? 50, 10, 100) : null,
      reduce_pct: reducePct,
      thesis: truncate(d.thesis.trim(), 800),
      bull_evidence: normalizeEvidence(d.bull_evidence, sourceUrls),
      bear_evidence: normalizeEvidence(d.bear_evidence, sourceUrls),
      risks: d.risks.slice(0, 4).map((r) => truncate(r, 300)),
      invalidation: truncate(d.invalidation.trim(), 300),
      notes,
      defaulted: false,
    })
  }
  // Every listed symbol gets a recorded decision, even if the model skipped it.
  for (const symbol of [...candidates, ...held]) {
    if (!seen.has(symbol)) decisions.push(emptyDecision(symbol, held.has(symbol), "The AI returned no decision for this symbol."))
  }
  return {
    ...report,
    market_read: { ...report.market_read, summary: truncate(report.market_read.summary, 600), confidence: clamp(Math.round(report.market_read.confidence), 0, 100) },
    decisions,
    data_gaps: report.data_gaps.slice(0, 6).map((g) => truncate(g, 300)),
    notification: truncate(report.notification.trim(), 160),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// One-time seed allocation
// ─────────────────────────────────────────────────────────────────────────────

export const SEED_MAX_ALLOCATIONS = 4
/** Seed holdings are long-term core positions: at least a week, at most the usual 90-day review horizon. */
export const SEED_MIN_HORIZON_HOURS = 168

export const seedAllocationSchema = z.object({
  allocations: z
    .array(
      z.object({
        symbol: z.string().describe("Pair exactly as listed in SEED CANDIDATES, e.g. BTC/USD."),
        weight_pct: z.number().describe("% of the seed amount for this pair (1-100). Weights across allocations sum to at most 100; anything left stays in cash."),
        conviction: z.number().describe("0-100: how strongly the evidence supports this pair as a long-term core holding. It is NOT a probability."),
        thesis: z.string().describe("2-3 sentences: why this is a good long-term core holding now. Cite numbers from CONTEXT or RESEARCH."),
        invalidation: z.string().describe("The specific price level or event that would prove the long-term thesis wrong."),
        stop_loss: z.number().nullable().describe("Stop price below the current price at a daily level (the hint is 2.5 daily ATR), or null to use the hint."),
        take_profit: z.number().nullable().describe("Target price above the current price, or null to use the hint (3R)."),
        horizon_hours: z.number().describe(`Expected holding period in hours (${SEED_MIN_HORIZON_HOURS}-${MAX_HORIZON_HOURS}). When it elapses the position is reviewed, not sold.`),
      }),
    )
    .describe(`1-${SEED_MAX_ALLOCATIONS} long-term core holdings.`),
  rationale: z.string().describe("3-5 sentences on the allocation as a whole: why these pairs, why these weights, and the macro backdrop."),
})

export type SeedAllocationReport = z.infer<typeof seedAllocationSchema>
export type SeedAllocationItem = SeedAllocationReport["allocations"][number]
export type NormalizedSeedAllocation = { allocations: SeedAllocationItem[]; rationale: string; notes: string[] }

/**
 * Keeps only listed pairs (first answer per pair, at most four), bounds every number, and scales
 * the weights down proportionally when they add up to more than 100%.
 */
export const normalizeSeedAllocation = (report: SeedAllocationReport, { candidates }: { candidates: ReadonlySet<string> }): NormalizedSeedAllocation => {
  const notes: string[] = []
  const seen = new Set<string>()
  const allocations: SeedAllocationItem[] = []
  for (const a of report.allocations) {
    const symbol = a.symbol.trim().toUpperCase()
    if (seen.has(symbol)) continue
    if (!candidates.has(symbol)) {
      notes.push(`${symbol} is not a seed candidate; ignored`)
      continue
    }
    const weight = Number.isFinite(a.weight_pct) ? clamp(a.weight_pct, 0, 100) : 0
    if (weight <= 0) continue
    seen.add(symbol)
    allocations.push({
      symbol,
      weight_pct: weight,
      conviction: Math.round(clamp(Number.isFinite(a.conviction) ? a.conviction : 0, 0, 100)),
      thesis: truncate(a.thesis.trim(), 800),
      invalidation: truncate(a.invalidation.trim(), 300),
      stop_loss: finitePositive(a.stop_loss),
      take_profit: finitePositive(a.take_profit),
      horizon_hours: clamp(Number.isFinite(a.horizon_hours) ? a.horizon_hours : MAX_HORIZON_HOURS, SEED_MIN_HORIZON_HOURS, MAX_HORIZON_HOURS),
    })
  }
  if (allocations.length > SEED_MAX_ALLOCATIONS) notes.push(`only the first ${SEED_MAX_ALLOCATIONS} allocations are used`)
  const kept = allocations.slice(0, SEED_MAX_ALLOCATIONS)
  const total = kept.reduce((s, a) => s + a.weight_pct, 0)
  if (total > 100) notes.push(`weights summed to ${total.toFixed(1)}%; scaled down to 100%`)
  const scale = total > 100 ? 100 / total : 1
  return {
    allocations: kept.map((a) => ({ ...a, weight_pct: roundTo(a.weight_pct * scale, 2) })),
    rationale: truncate(report.rationale.trim(), 1_000),
    notes,
  }
}
