import { describe, expect, it } from "vitest"
import { coreReviewSchema, normalizeCoreReview, type CoreHoldingDecision, type CoreReviewOutput } from "../src/core-book"

const holding = (o: Partial<CoreHoldingDecision>): CoreHoldingDecision => ({
  symbol: "NVDA",
  action: "buy",
  target_weight_pct: 10,
  conviction: 8,
  thesis: "Thesis.",
  invalidation: "Invalidation.",
  verdict: "Verdict.",
  theme: null,
  stop: null,
  evidence: [],
  ...o,
})

const output = (o: Partial<CoreReviewOutput> = {}): CoreReviewOutput => ({ summary: "Plan.", holdings: [], watch: [], sources: [], ...o })

describe("normalizeCoreReview", () => {
  it("cleans tickers, keeps the first entry per symbol and applies the bounds", () => {
    const out = normalizeCoreReview(
      output({
        holdings: [
          holding({ symbol: "$nvda", conviction: 11.4, target_weight_pct: 150.456, stop: 180.456, theme: "  AI buildout ", evidence: ["a", "b", "c", "d", "e", "f"] }),
          holding({ symbol: "NVDA", action: "sell" }),
          holding({ symbol: "SPY", action: "sell", target_weight_pct: 20, stop: -1, conviction: 0, theme: "  " }),
        ],
        watch: [
          { symbol: "nasdaq:avgo", reason: "Chips.", trigger: "Reclaims its 200-day." },
          { symbol: "AVGO", reason: "Again.", trigger: "x" },
        ],
        sources: [
          { title: "Reuters", url: "https://reuters.com/x" },
          { title: "bad", url: "javascript:alert(1)" },
        ],
      }),
    )
    expect(out.holdings).toEqual([
      holding({ symbol: "NVDA", conviction: 10, target_weight_pct: 100, stop: 180.46, theme: "AI buildout", evidence: ["a", "b", "c", "d", "e"] }),
      holding({ symbol: "SPY", action: "sell", target_weight_pct: null, stop: null, conviction: 1, theme: null }),
    ])
    expect(out.watch).toEqual([{ symbol: "AVGO", reason: "Chips.", trigger: "Reclaims its 200-day." }])
    expect(out.sources).toEqual([{ title: "Reuters", url: "https://reuters.com/x" }])
  })

  it("passes the strict schema", () => {
    expect(coreReviewSchema.safeParse(normalizeCoreReview(output({ holdings: [holding({})] }))).success).toBe(true)
  })
})
