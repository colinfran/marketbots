import { afterEach, describe, expect, it, vi } from "vitest"
import { AiCallLog } from "../../src/ai/call-log"
import { useTestDb } from "../helpers/bot"

const db = useTestDb()

/** A bot whose day ends at 04:00 UTC, as the New York trading day does in summer. */
const nyDay = (date: Date) => new Date(date.getTime() - 4 * 3_600_000).toISOString().slice(0, 10)

const call = { task: "decision" as const, model: "local/qwen3.6-35b-a3b-q2", cycle_id: "c1", input_tokens: 1_000, output_tokens: 100, cost_usd: 0, cost_source: "local" as const, duration_ms: 90_000, ok: true, error: null }

describe("AiCallLog", () => {
  afterEach(() => vi.useRealTimers())

  it("records each call on the bot's day", async () => {
    const log = new AiCallLog(db.col, nyDay, () => new Date("2026-10-28T02:30:00Z"))
    await log.record(call)
    expect(await db.col.aiCalls.findOne({})).toMatchObject({ ...call, day: "2026-10-27", at: new Date("2026-10-28T02:30:00Z") })
  })

  it("counts only today's calls", async () => {
    const at = new Date("2026-10-28T15:00:00Z")
    await db.col.aiCalls.insertMany([
      { _id: "a", at, day: "2026-10-28", ...call },
      { _id: "b", at, day: "2026-10-28", ...call, ok: false, error: "timeout" },
      { _id: "c", at, day: "2026-10-27", ...call },
    ])
    expect(await new AiCallLog(db.col, nyDay, () => at).today()).toEqual({ day: "2026-10-28", calls: 2 })
  })

  it("keeps the count current as it records calls", async () => {
    const log = new AiCallLog(db.col, nyDay, () => new Date("2026-10-28T15:00:00Z"))
    expect((await log.today()).calls).toBe(0)
    await log.record(call)
    await log.record({ ...call, task: "research" })
    expect((await log.today()).calls).toBe(2)
  })

  it("recounts at most once a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-28T15:00:00Z") })
    const log = new AiCallLog(db.col, nyDay)
    expect((await log.today()).calls).toBe(0)
    // Recorded by another writer: the cached count doesn't see it until it recounts.
    await db.col.aiCalls.insertOne({ _id: "x", at: new Date(), day: "2026-10-28", ...call })
    expect((await log.today()).calls).toBe(0)
    vi.setSystemTime(new Date("2026-10-28T15:01:01Z"))
    expect((await log.today()).calls).toBe(1)
  })

  it("starts a new count when the bot's day rolls over", async () => {
    let now = new Date("2026-10-29T03:59:00Z")
    const log = new AiCallLog(db.col, nyDay, () => now)
    await log.record(call)
    expect(await log.today()).toEqual({ day: "2026-10-28", calls: 1 })
    now = new Date("2026-10-29T04:01:00Z")
    expect(await log.today()).toEqual({ day: "2026-10-29", calls: 0 })
    await log.record(call)
    expect(await log.today()).toEqual({ day: "2026-10-29", calls: 1 })
  })

  it("doesn't count a call into a day it has stopped tracking", async () => {
    let now = new Date("2026-10-29T03:59:00Z")
    const log = new AiCallLog(db.col, nyDay, () => now)
    expect((await log.today()).calls).toBe(0)
    // The clock moves on between the count and the record: the record lands on the new day.
    now = new Date("2026-10-29T04:01:00Z")
    await log.record(call)
    expect(await log.today()).toEqual({ day: "2026-10-29", calls: 1 })
    expect(await db.col.aiCalls.countDocuments({ day: "2026-10-28" })).toBe(0)
  })
})
