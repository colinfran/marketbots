import { describe, expect, it } from "vitest"
import { repairCoreReview } from "../../src/core-book/repair"

describe("repairCoreReview", () => {
  it("salvages JSON in prose with numbers as strings and loose enum spellings", () => {
    const text = `Here you go:\n\`\`\`json\n${JSON.stringify({
      summary: "Trim DIA, buy NVDA.",
      holdings: [
        { symbol: "$nvda", action: "BUY", target_weight_pct: "10%", conviction: "8", thesis: "Demand.", invalidation: "Capex cut.", verdict: "New.", theme: "AI buildout", stop: "$180", evidence: "Q3 +60%" },
        { symbol: "DIA", action: "Trim", target_weight_pct: 15, conviction: 6, thesis: "Ballast.", invalidation: "Orders fall.", verdict: "Overlap." },
      ],
      watch: { symbol: "AVGO", reason: "Chips.", trigger: "200-day." },
    })}\n\`\`\``
    const repaired = repairCoreReview(text)!
    expect(repaired.dropped).toBe(0)
    expect(repaired.report.holdings[0]).toMatchObject({ symbol: "NVDA", action: "buy", target_weight_pct: 10, conviction: 8, stop: 180, evidence: ["Q3 +60%"] })
    expect(repaired.report.holdings[1]).toMatchObject({ symbol: "DIA", action: "trim", theme: null, stop: null, evidence: [] })
    expect(repaired.report.watch).toEqual([{ symbol: "AVGO", reason: "Chips.", trigger: "200-day." }])
    expect(repaired.report.sources).toEqual([])
  })

  it("drops entries it can't read and never invents one", () => {
    const repaired = repairCoreReview(JSON.stringify({ summary: "x", holdings: [{ symbol: "NVDA", action: "double down" }, { action: "sell" }, { symbol: "SPY", action: "keep" }] }))!
    expect(repaired.report.holdings.map((h) => h.symbol)).toEqual(["SPY"])
    expect(repaired.dropped).toBe(2)
  })

  it("gives up without a summary or any JSON", () => {
    expect(repairCoreReview(JSON.stringify({ holdings: [] }))).toBeNull()
    expect(repairCoreReview("no json here")).toBeNull()
    expect(repairCoreReview(undefined)).toBeNull()
  })
})
