import { agentAnswerFields } from "@mb/core/agent"
import { z } from "zod"
import { cryptoDecisionSchema, evidenceSchema, normalizeCryptoDecision, type NormalizedCryptoDecision } from "./report"
import { STRATEGY_IDS, type StrategyId } from "./strategies"

/**
 * The crypto agent's answer (docs/plans/LOCAL-AI.md §8.4): the cycle's decision schema, about what
 * the wake-up concerns only, plus the strategy an entry follows, and the watches, notes and reply
 * both bots' answers have. Normalized with the cycle's own rules (`normalizeCryptoDecision`); the
 * symbols it may name are the universe's and the shadow book's.
 */

const agentEvidenceSchema = evidenceSchema.extend({
  source_url: z.string().nullable().describe("A URL that appears in the brief or a tool result and supports the claim, or null. Never invent URLs."),
})

export const cryptoAgentDecisionSchema = cryptoDecisionSchema.extend({
  action: cryptoDecisionSchema.shape.action.describe("Pairs you don't hold: buy or no_trade. Pairs you hold (YOUR BOOK): hold, reduce or close. no_trade is a normal, often correct answer."),
  thesis: z.string().describe("2-3 sentences: why this action, why now. Cite numbers from the brief or your tool results."),
  bull_evidence: z.array(agentEvidenceSchema).describe("1-5 items for upside."),
  bear_evidence: z.array(agentEvidenceSchema).describe("1-5 counterarguments and downside risks. Always include at least one."),
  size_pct_of_max: z
    .number()
    .nullable()
    .describe("BUY only: a whole number from 10 to 100, the percent of the largest position the risk checks allow (100 = the largest, 50 = half of it). Size down when uncertain. null otherwise."),
  strategy: z.enum(STRATEGY_IDS).nullable().describe("BUY only: the strategy the entry follows (discretionary when none fits). null otherwise."),
})

export const cryptoAgentAnswerSchema = z.object({
  decisions: z
    .array(cryptoAgentDecisionSchema)
    .describe("0-3 decisions, only about what woke you and what you hold. An empty list is a normal answer: watch instead of acting early."),
  ...agentAnswerFields,
})

export type CryptoAgentAnswer = z.infer<typeof cryptoAgentAnswerSchema>

export type NormalizedCryptoAgentDecision = NormalizedCryptoDecision & { strategy: StrategyId | null }

/**
 * Keeps decisions on known pairs (the first per pair, at most three), bounded like the cycle's. A
 * size of 1 or less is read as a fraction (the local model sometimes writes 0.5 for 50%), so it
 * isn't clamped up to the 10% floor.
 */
export const normalizeCryptoAgentDecisions = (
  decisions: CryptoAgentAnswer["decisions"],
  { universe, held, sourceUrls }: { universe: ReadonlySet<string>; held: ReadonlySet<string>; sourceUrls: ReadonlySet<string> },
): { decisions: NormalizedCryptoAgentDecision[]; dropped: string[] } => {
  const seen = new Set<string>()
  const out: NormalizedCryptoAgentDecision[] = []
  const dropped: string[] = []
  for (const d of decisions) {
    const symbol = d.symbol.trim().toUpperCase()
    if (seen.has(symbol)) continue
    if (!held.has(symbol) && !universe.has(symbol)) {
      dropped.push(`${symbol}: not in the universe or the shadow book`)
      continue
    }
    seen.add(symbol)
    const fraction = d.size_pct_of_max !== null && d.size_pct_of_max > 0 && d.size_pct_of_max <= 1
    const n = normalizeCryptoDecision(fraction ? { ...d, size_pct_of_max: d.size_pct_of_max! * 100 } : d, symbol, held.has(symbol), sourceUrls)
    if (fraction) n.notes.push(`size_pct_of_max ${d.size_pct_of_max} read as ${d.size_pct_of_max! * 100}%`)
    out.push({ ...n, strategy: n.action === "buy" ? (d.strategy ?? "discretionary") : null })
  }
  if (out.length > 3) dropped.push(...out.slice(3).map((d) => `${d.symbol}: more than three decisions`))
  return { decisions: out.slice(0, 3), dropped }
}
