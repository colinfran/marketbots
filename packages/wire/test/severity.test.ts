import { describe, expect, it } from "vitest"
import { scoreSeverity } from "../src/severity"

/** Two of crypto's category bases. */
const BASE = { exploit: 85, general: 10 }

describe("severity", () => {
  it("adds base × tier, relevance, confirmations (capped) and anomaly points", () => {
    const s = scoreSeverity({ category: "exploit", tier: 2, held: true, candidate: true, marketWide: false, confirmations: 3, anomalyPoints: 15 }, BASE)
    expect(s.parts).toEqual({ base: 72.3, relevance: 20, confirmation: 16, anomaly: 15 })
    expect(s.severity).toBe(100)
    expect(scoreSeverity({ category: "general", tier: 3, held: false, candidate: false, marketWide: true, confirmations: 0, anomalyPoints: 0 }, BASE).severity).toBe(11)
  })
})
