import type { AiCallDoc } from "@mb/core/db"
import type { Collection } from "mongodb"
import { describe, expect, it } from "vitest"
import { affordCycle, AiBudget, type BudgetStatus } from "../../src/ai/budget"

describe("affordCycle", () => {
  const status: BudgetStatus = { day: "2026-10-28", spent_usd: 5, budget_usd: 5, remaining_usd: 0, calls: 40 }
  /** A budget with `left` dollars to spend and these expected costs. */
  const budget = (left: number, costs: { research: number; research_gap: number; decision: number }) => ({
    estimate: async (task: keyof typeof costs) => costs[task],
    canAfford: async (usd: number) => ({ ok: usd <= left, status }),
  })
  const local = { research: 0.2, research_gap: 0.1, decision: 0 }
  const gap = { kind: "gap" as const, reason: "1 unexplained moves, 0 unconfirmed items" }

  it("keeps the plan when the budget pays for the research and the decision", async () => {
    expect(await affordCycle(budget(1, local), gap, { reservePct: 0, feedsUp: true })).toMatchObject({ plan: gap, afford: { ok: true } })
  })

  it("drops the research it can't pay for and decides from our feeds, when the decision fits", async () => {
    expect(await affordCycle(budget(0, local), gap, { reservePct: 30, feedsUp: true })).toMatchObject({
      plan: { kind: "none", reason: "no AI budget left for research (1 unexplained moves, 0 unconfirmed items): deciding from our feeds" },
      afford: { ok: true },
    })
  })

  it("still skips when our feeds are down, or the decision doesn't fit either", async () => {
    const full = { kind: "full" as const, reason: "news engine unhealthy" }
    expect(await affordCycle(budget(0, local), full, { reservePct: 0, feedsUp: false })).toMatchObject({ plan: full, afford: { ok: false } })
    expect(await affordCycle(budget(0.05, { ...local, decision: 0.06 }), gap, { reservePct: 0, feedsUp: true })).toMatchObject({ plan: gap, afford: { ok: false } })
  })
})

describe("AiBudget.estimate", () => {
  /** The last successful calls, as the budget reads them (every task alike here). */
  const calls = (costs: number[]) =>
    ({ find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => costs.map((cost_usd) => ({ cost_usd })) }) }) }) }) as unknown as Collection<AiCallDoc>
  const budget = (decision: string, research = "spacexai/grok-4.3") =>
    new AiBudget({ aiCalls: calls([0.05, 0.06, 0.07]) }, () => 5, { day: () => "2026-10-28", defaultEstimates: { research: 0.2, decision: 0.06, research_gap: 0.08 } }, undefined, () => ({ research, decision }))

  it("expects a decision on the local model to cost nothing, whatever Grok decisions cost before", async () => {
    const local = budget("local/qwen3.6-35b-a3b-q2")
    expect(await local.estimate("decision")).toBe(0)
    // Research still runs on Grok, at its usual cost.
    expect(await local.estimate("research")).toBeCloseTo(0.06)
  })

  it("expects research on the local model to cost nothing, gap-fills included", async () => {
    const local = budget("local/qwen3.6-35b-a3b-q2", "local/qwen3.6-35b-a3b-q2")
    expect([await local.estimate("research"), await local.estimate("research_gap"), await local.estimate("decision")]).toEqual([0, 0, 0])
  })

  it("expects a gateway decision to cost what recent ones did", async () => {
    expect(await budget("spacexai/grok-4.7").estimate("decision")).toBeCloseTo(0.06)
  })
})
