import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { marketDay } from "@mb/stock-core/time"
import { describe, expect, it } from "vitest"
import { useTestDb } from "../helpers/db"

describe("AiCallLog on stock's day", () => {
  const db = useTestDb()
  const call = { model: "local/qwen3.6-35b-a3b-q2", cycle_id: "c", input_tokens: 9_000, output_tokens: 6_000, cost_usd: 0, cost_source: "local" as const, duration_ms: 150_000, ok: true, error: null }

  it("counts the day's calls on the New York trading day", async () => {
    // 03:30 UTC on Oct 27 is still Oct 26 in New York.
    const log = new AiCallLog(db.col, marketDay, () => new Date("2026-10-27T03:30:00Z"))
    for (const task of ["research", "decision"] as const) await log.record({ task, ...call })
    expect(await log.today()).toEqual({ day: "2026-10-26", calls: 2 })
    expect(await db.col.aiCalls.distinct("day")).toEqual(["2026-10-26"])
  })

  it("starts a new day at midnight New York time, not UTC", async () => {
    let now = new Date("2026-10-27T03:59:00Z")
    const log = new AiCallLog(db.col, marketDay, () => now)
    await log.record({ task: "decision", ...call })
    // Midnight UTC has passed, midnight in New York (04:00 UTC in daylight time) hasn't.
    expect(await log.today()).toEqual({ day: "2026-10-26", calls: 1 })
    now = new Date("2026-10-27T04:00:00Z")
    expect(await log.today()).toEqual({ day: "2026-10-27", calls: 0 })
  })
})
