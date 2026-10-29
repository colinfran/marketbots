import { agentAnswerFields } from "@mb/core/agent"
import { z } from "zod"
import { decisionSchema, normalizeDecision, STOCK_ACTIONS, type Decision } from "./report"

/**
 * The stock agent's answer (docs/plans/LOCAL-AI.md §8.4): the cycle's decision schema for stocks
 * (options stay with the timed cycles for now: their menus and quotes aren't in the shadow book),
 * about what the wake-up concerns only, plus the watches, notes and reply both bots' answers have.
 * Normalized with the cycle's own rules (`normalizeDecision`).
 */

export const stockAgentDecisionSchema = decisionSchema.omit({ structure_id: true, option: true }).extend({
  action: z
    .enum(STOCK_ACTIONS)
    .describe("Stocks you don't hold: buy (opens a position; never adds). Stocks you hold (YOUR BOOK): sell some or all, adjust_exits (new stop and target), or hold."),
  rationale: z.string().describe("1-3 sentences: why this, why now. Cite numbers from the brief or your tool results."),
  evidence: z.array(z.string()).describe("2-5 concrete facts with numbers or times, from the brief or your tool results."),
})

export const stockAgentAnswerSchema = z.object({
  decisions: z
    .array(stockAgentDecisionSchema)
    .describe("0-3 decisions, only about what woke you and what you hold. An empty list is a normal answer: watch instead of acting early."),
  ...agentAnswerFields,
})

export type StockAgentAnswer = z.infer<typeof stockAgentAnswerSchema>
export type StockAgentDecision = Decision & { action: (typeof STOCK_ACTIONS)[number] }

/** Keeps decisions on known tickers (the first per ticker, at most three), bounded like the cycle's. */
export const normalizeStockAgentDecisions = (decisions: StockAgentAnswer["decisions"], { known }: { known: (symbol: string) => boolean }): { decisions: StockAgentDecision[]; dropped: string[] } => {
  const seen = new Set<string>()
  const out: StockAgentDecision[] = []
  const dropped: string[] = []
  for (const raw of decisions) {
    const d = normalizeDecision({ ...raw, structure_id: null, option: null }) as StockAgentDecision
    if (seen.has(d.symbol)) continue
    if (!known(d.symbol)) {
      dropped.push(`${d.symbol}: not a ticker the agent may trade`)
      continue
    }
    seen.add(d.symbol)
    out.push(d)
  }
  if (out.length > 3) dropped.push(...out.slice(3).map((d) => `${d.symbol}: more than three decisions`))
  return { decisions: out.slice(0, 3), dropped }
}
