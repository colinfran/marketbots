import type { AiCallDoc } from "@mb/core/db"
import type { Collection } from "mongodb"
import { describe, expect, it } from "vitest"
import { AiBudget, gatewayCost } from "../../src/ai/budget"

describe("AiBudget.estimate", () => {
  /** The last successful calls, as the budget reads them (every task alike here). */
  const calls = (costs: number[]) =>
    ({ find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => costs.map((cost_usd) => ({ cost_usd })) }) }) }) }) as unknown as Collection<AiCallDoc>
  const budget = (decisionModel: string) =>
    new AiBudget({ aiCalls: calls([0.05, 0.06, 0.07]) }, () => 5, { day: () => "2026-10-28", defaultEstimates: { research: 0.2, decision: 0.06, research_gap: 0.08 } }, undefined, () => decisionModel)

  it("expects a decision on the local model to cost nothing, whatever Grok decisions cost before", async () => {
    const local = budget("local/qwen3.6-35b-a3b-q2")
    expect(await local.estimate("decision")).toBe(0)
    // Research still runs on Grok, at its usual cost.
    expect(await local.estimate("research")).toBeCloseTo(0.06)
  })

  it("expects a gateway decision to cost what recent ones did", async () => {
    expect(await budget("spacexai/grok-4.7").estimate("decision")).toBeCloseTo(0.06)
  })
})

describe("gatewayCost", () => {
  it("reads string or number costs and ignores junk", () => {
    expect(gatewayCost({ gateway: { cost: "0.5" } })).toBe(0.5)
    expect(gatewayCost({ gateway: { totalCost: 0.25 } })).toBe(0.25)
    expect(gatewayCost({ gateway: { cost: "abc" } })).toBeNull()
    expect(gatewayCost(undefined)).toBeNull()
  })

  it("uses marketCost when the gateway bills nothing (own provider key)", () => {
    expect(gatewayCost({ gateway: { cost: "0", marketCost: "0.00030935" } })).toBe(0.00030935)
  })
})
