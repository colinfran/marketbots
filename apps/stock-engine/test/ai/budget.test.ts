import { describe, expect, it } from "vitest"
import { AiBudget } from "../../src/ai/budget"
import { useTestDb } from "../helpers/db"

describe("AiBudget.estimateByDuration", () => {
  const db = useTestDb()
  const call = (model: string, cost_usd: number, duration_ms: number, ok = true) =>
    db.col.aiCalls.insertOne({
      _id: crypto.randomUUID(),
      at: new Date(),
      day: "2026-10-26",
      task: "decision",
      model,
      cycle_id: null,
      input_tokens: 1,
      output_tokens: 1,
      cost_usd,
      cost_source: "gateway",
      duration_ms,
      ok,
      error: null,
    })

  it("prices a call by its run time at the model's recent cost per second", async () => {
    await call("spacexai/grok-4.7", 0.1, 100_000)
    await call("spacexai/grok-4.7", 0.2, 200_000)
    await call("spacexai/grok-4.7", 0.15, 150_000)
    await call("spacexai/grok-4.7", 0, 240_000, false) // an earlier timeout: not a sample
    await call("spacexai/grok-4.3", 5, 1_000) // another model: not a sample
    const budget = new AiBudget(db.col, () => 5)
    expect(await budget.estimateByDuration("decision", "spacexai/grok-4.7", 240_000)).toBeCloseTo(0.24)
  })

  it("falls back to the default estimate without enough history", async () => {
    await call("spacexai/grok-4.7", 0.1, 100_000)
    expect(await new AiBudget(db.col, () => 5).estimateByDuration("decision", "spacexai/grok-4.7", 240_000)).toBe(0.1)
  })
})
