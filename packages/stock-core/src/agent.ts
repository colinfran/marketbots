import { agentAnswerFields } from "@mb/core/agent"
import { z } from "zod"
import { ACTIONS, decisionSchema, normalizeDecision, optionOrderSchema, type Decision } from "./report"

/**
 * The stock agent's answer (docs/plans/LOCAL-AI.md §8.4): the cycle's decision schema, stocks and
 * options, about what the wake-up concerns only, plus the watches, notes and reply both bots'
 * answers have. Option entries must use contracts from an option_menu the agent looked up in the
 * same episode (the cycle's OPTION CHAINS); options trade only at level auto, since the shadow
 * book has no options. Normalized with the cycle's own rules (`normalizeDecision`).
 */

const agentOptionOrderSchema = optionOrderSchema.extend({
  long_leg: z.string().describe("The contract to BUY, copied exactly from an option_menu result in this episode, e.g. NVDA261120C00140000."),
  short_leg: z.string().nullable().describe("Spreads only: the contract to SELL, copied exactly from the same option_menu result, same expiration as long_leg. null for long_call / long_put."),
  premium_pct: z.number().nullable().describe("% of account equity to spend on premium (at most the per-position cap in YOUR BOOK's options limits)."),
})

export const stockAgentDecisionSchema = decisionSchema.extend({
  action: z
    .enum(ACTIONS)
    .describe(
      "Stocks you don't hold: buy (opens a position; never adds). Stocks you hold (YOUR BOOK): sell (the whole position), adjust_exits (a higher stop, a new target), or hold. Options: buy_option opens one from an option_menu result (symbol = the underlying); close_option or hold_option manage an open options position by its structure_id.",
    ),
  allocation_pct: z.number().nullable().describe("null: code sizes every buy to risk a set share of equity at its stop, by your conviction."),
  sell_pct: z.number().nullable().describe("null: a sell closes the whole position. Code trails every stop once a position is up, so sell only when the thesis is broken."),
  rationale: z.string().describe("1-3 sentences: why this, why now. Cite numbers from the brief or your tool results."),
  evidence: z.array(z.string()).describe("2-5 concrete facts with numbers or times, from the brief or your tool results."),
  structure_id: z.string().nullable().describe("close_option / hold_option: the id of an options position in YOUR BOOK. null otherwise."),
  option: agentOptionOrderSchema.nullable().describe("buy_option only: what to buy, from an option_menu result in this episode. null for every other action."),
})

/** At most this many new entries (buys and option buys) per answer; anything held may get a decision too. */
export const MAX_NEW_ENTRIES = 3

export const stockAgentAnswerSchema = z.object({
  decisions: z
    .array(stockAgentDecisionSchema)
    .describe(
      `Only about what woke you and what you hold: at most ${MAX_NEW_ENTRIES} new entries (buy, buy_option), plus one for each position in YOUR BOOK that needs a decision. An empty list is right when nothing has an edge.`,
    ),
  ...agentAnswerFields,
})

export type StockAgentAnswer = z.infer<typeof stockAgentAnswerSchema>
export type StockAgentDecision = Decision

/**
 * Keeps decisions on known tickers (the first per ticker and instrument), bounded like the cycle's:
 * every decision on what is held, since the agent manages the whole book, and at most
 * MAX_NEW_ENTRIES new entries.
 */
export const normalizeStockAgentDecisions = (decisions: StockAgentAnswer["decisions"], { known }: { known: (symbol: string) => boolean }): { decisions: StockAgentDecision[]; dropped: string[] } => {
  const seen = new Set<string>()
  const out: StockAgentDecision[] = []
  const dropped: string[] = []
  let entries = 0
  for (const raw of decisions) {
    const d = normalizeDecision(raw)
    const key = `${d.symbol}:${d.action.endsWith("_option") ? (d.structure_id ?? d.option?.long_leg ?? "option") : "stock"}`
    if (seen.has(key)) continue
    if (!known(d.symbol)) {
      dropped.push(`${d.symbol}: not a ticker the agent may trade`)
      continue
    }
    seen.add(key)
    if ((d.action === "buy" || d.action === "buy_option") && ++entries > MAX_NEW_ENTRIES) {
      dropped.push(`${d.symbol}: more than ${MAX_NEW_ENTRIES} new entries`)
      continue
    }
    out.push(d)
  }
  return { decisions: out, dropped }
}
