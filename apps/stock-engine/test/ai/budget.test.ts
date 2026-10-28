import { describe, expect, it } from "vitest"
import { AiBudget } from "../../src/ai/budget"
import { useTestDb } from "../helpers/db"

describe("AiBudget", () => {
  const db = useTestDb()
  const local = { research: "local/qwen3.6-35b-a3b-q2", decision: "local/qwen3.6-35b-a3b-q2" }

  it("expects calls on the local model to cost nothing, whatever was recorded before", async () => {
    await db.col.aiCalls.insertOne({ _id: crypto.randomUUID(), at: new Date(), day: "2026-10-26", task: "decision", model: "spacexai/grok-4.7", cycle_id: null, input_tokens: 1, output_tokens: 1, cost_usd: 0.2, cost_source: "gateway", duration_ms: 1, ok: true, error: null })
    const budget = new AiBudget(db.col, () => 5, { models: () => local })
    expect([await budget.estimate("decision"), await budget.estimate("research"), await budget.estimate("research_gap")]).toEqual([0, 0, 0])
  })

  it("counts the day's calls on the New York trading day, so a $0 day always has room", async () => {
    // 03:30 UTC on Oct 27 is still Oct 26 in New York.
    const budget = new AiBudget(db.col, () => 5, { now: () => new Date("2026-10-27T03:30:00Z"), models: () => local })
    for (const task of ["research", "decision"] as const) {
      await budget.record({ task, model: local.decision, cycle_id: "c", input_tokens: 9_000, output_tokens: 6_000, cost_usd: 0, cost_source: "local", duration_ms: 150_000, ok: true, error: null })
    }
    expect(await budget.status()).toMatchObject({ day: "2026-10-26", calls: 2, spent_usd: 0, remaining_usd: 5 })
    expect((await budget.canAfford(0, { reservePct: 30 })).ok).toBe(true)
  })
})
