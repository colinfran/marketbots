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

/** The agent's actions: no reduce, since trimming a winner pays fees to cut it; code trails the stop instead. */
export const CRYPTO_AGENT_ACTIONS = ["buy", "no_trade", "hold", "close"] as const

/** No size field: code sizes every entry from its stop and its conviction. */
export const cryptoAgentDecisionSchema = cryptoDecisionSchema.omit({ size_pct_of_max: true }).extend({
  action: z
    .enum(CRYPTO_AGENT_ACTIONS)
    .describe("Pairs you don't hold: buy or no_trade. Pairs you hold (YOUR BOOK): hold (optionally raising the stop) or close. Code trails every stop once a position is up, so close only when the thesis is broken, not to bank a small gain."),
  thesis: z.string().describe("2-3 sentences: why this action, why now. Cite numbers from the brief or your tool results."),
  bull_evidence: z.array(agentEvidenceSchema).describe("1-5 items for upside."),
  bear_evidence: z.array(agentEvidenceSchema).describe("1-5 counterarguments and downside risks. Always include at least one."),
  strategy: z.enum(STRATEGY_IDS).nullable().describe("BUY only: the strategy the entry follows (discretionary when none fits). null otherwise."),
})

/** At most this many decisions about pairs not held (buys and no_trades) per answer; any held position may get one too. */
export const MAX_NEW_PAIRS = 3

export const cryptoAgentAnswerSchema = z.object({
  decisions: z
    .array(cryptoAgentDecisionSchema)
    .describe(
      `Only about what woke you and what you hold: at most ${MAX_NEW_PAIRS} about pairs you don't hold, plus one for each position in YOUR BOOK that needs a decision. An empty list is a normal answer: watch instead of acting early.`,
    ),
  ...agentAnswerFields,
})

export type CryptoAgentAnswer = z.infer<typeof cryptoAgentAnswerSchema>

export type NormalizedCryptoAgentDecision = NormalizedCryptoDecision & { strategy: StrategyId | null }

/**
 * Keeps decisions on known pairs (the first per pair), bounded like the cycle's: every held pair's,
 * since the agent manages the whole book, and at most MAX_NEW_PAIRS about pairs not held. They
 * carry no size preference: code sizes entries.
 */
export const normalizeCryptoAgentDecisions = (
  decisions: CryptoAgentAnswer["decisions"],
  { universe, held, sourceUrls }: { universe: ReadonlySet<string>; held: ReadonlySet<string>; sourceUrls: ReadonlySet<string> },
): { decisions: NormalizedCryptoAgentDecision[]; dropped: string[] } => {
  const seen = new Set<string>()
  const out: NormalizedCryptoAgentDecision[] = []
  const dropped: string[] = []
  let fresh = 0
  for (const d of decisions) {
    const symbol = d.symbol.trim().toUpperCase()
    if (seen.has(symbol)) continue
    if (!held.has(symbol) && !universe.has(symbol)) {
      dropped.push(`${symbol}: not in the universe or the book`)
      continue
    }
    seen.add(symbol)
    if (!held.has(symbol) && ++fresh > MAX_NEW_PAIRS) {
      dropped.push(`${symbol}: more than ${MAX_NEW_PAIRS} pairs not held`)
      continue
    }
    const n = normalizeCryptoDecision({ ...d, size_pct_of_max: null }, symbol, held.has(symbol), sourceUrls)
    out.push({ ...n, size_pct_of_max: null, strategy: n.action === "buy" ? (d.strategy ?? "discretionary") : null })
  }
  return { decisions: out, dropped }
}
