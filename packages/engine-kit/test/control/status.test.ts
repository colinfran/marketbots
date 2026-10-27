import type { EngineStateDoc } from "@mb/core/db"
import type { EngineEvent } from "@mb/core/events"
import type { WireStatus } from "@mb/core/wire"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StatusReporter, type StatusReporterDeps } from "../../src/control/status"
import { makeTestBus } from "../../src/testing/bus"
import { EPHEMERAL, useTestDb, type TestCycleState, type TestEvents, type TestRunStatus, type TestStatusDoc } from "../helpers/bot"

const db = useTestDb()

/** A moment on a heartbeat-event beat (every third 5-second slot). */
const BEAT = 1_800_000_000_000 - (1_800_000_000_000 % 15_000)

const setup = async (overrides: Partial<StatusReporterDeps<TestStatusDoc>> = {}) => {
  const bus = await makeTestBus<TestEvents>(db.col, EPHEMERAL)
  const events: EngineEvent<TestEvents>[] = []
  bus.subscribe((e) => events.push(e))
  const run: { status: TestRunStatus; cycle_state: TestCycleState; current_task: string | null } = { status: "running", cycle_state: "deciding", current_task: "deciding AAA" }
  const state: { state: EngineStateDoc } = {
    state: { _id: "engine", status: "running", pause_reason: null, kill_switch: { engaged: true, reason: "test", at: null, by: "owner", liquidate: false }, updated_at: new Date() },
  }
  const healthCalls: { triggers_today: number; event_queue: string[] }[] = []
  const triggers = { fail: false }
  const reporter = new StatusReporter<TestStatusDoc>({
    col: db.col,
    bus,
    budget: { status: async () => ({ spent_usd: 1.234567, calls: 7 }) },
    settings: { current: { ai: { models: { research: "x/r-model", decision: "x/d-model", fallback: null }, daily_budget_usd: 3 } } },
    ai: { available: true },
    state,
    stream: { clientCount: 2 },
    wire: {
      health: (extra) => {
        healthCalls.push(extra)
        return { mode: "live", sources: [], items_last_hour: 5, triggers_today: extra.triggers_today, event_queue: extra.event_queue } satisfies WireStatus
      },
    },
    policy: { triggersToday: async () => (triggers.fail ? Promise.reject(new Error("db down")) : 4) },
    instance: "kit-1",
    version: "9.9.9",
    run: () => run,
    eventQueue: () => ["AAA", "MARKET"],
    // The bot's own fields go between the shared ones, in its order.
    doc: (p) => ({ ...p.run, ...p.live, venue: { ok: true }, ...p.usage, last_cycle: "cycle-1", ...p.health }),
    ...overrides,
  })
  return { bus, events, run, healthCalls, triggers, reporter }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("StatusReporter", () => {
  it("writes the shared fields with the bot's section, in the bot's field order", async () => {
    const { bus, healthCalls, reporter } = await setup()
    await db.col.aiCalls.insertOne({ _id: "a1", at: new Date(Date.now() - 60_000), ok: true, error: null } as never)
    await db.col.aiCalls.insertOne({ _id: "a2", at: new Date(), ok: false, error: "gateway timeout" } as never)
    await db.col.events.insertMany([
      { _id: 1, ts: new Date().toISOString(), level: "error" } as never,
      { _id: 2, ts: new Date(Date.now() - 2 * 3_600_000).toISOString(), level: "error" } as never,
      { _id: 3, ts: new Date().toISOString(), level: "warn" } as never,
    ])
    await reporter.write()
    const doc = (await db.col.engineStatus.findOne({ _id: "engine" }))!
    expect(Object.keys(doc)).toEqual([
      "_id",
      "at",
      "instance",
      "version",
      "started_at",
      "status",
      "cycle_state",
      "current_task",
      "kill_switch",
      "ws_clients",
      "event_seq",
      "venue",
      "ai",
      "system",
      "last_cycle",
      "errors_last_hour",
      "wire",
    ])
    expect(doc).toMatchObject({
      instance: "kit-1",
      version: "9.9.9",
      status: "running",
      cycle_state: "deciding",
      current_task: "deciding AAA",
      kill_switch: true,
      ws_clients: 2,
      event_seq: bus.lastSeq,
      venue: { ok: true },
      ai: { models: { research: "x/r-model", decision: "x/d-model", fallback: null }, spend_today_usd: 1.2346, budget_usd: 3, calls_today: 7, last_error: "gateway timeout", enabled: true },
      last_cycle: "cycle-1",
      errors_last_hour: 1,
      wire: { mode: "live", items_last_hour: 5, triggers_today: 4, event_queue: ["AAA", "MARKET"] },
    })
    expect(doc.system).toEqual({ cpu_pct: expect.any(Number), rss_mb: expect.any(Number), heap_mb: expect.any(Number), load_avg: expect.any(Array), uptime_s: expect.any(Number) })
    expect(healthCalls).toEqual([{ triggers_today: 4, event_queue: ["AAA", "MARKET"] }])
    // Replaced in place on every beat.
    await reporter.write()
    expect(await db.col.engineStatus.countDocuments()).toBe(1)
    await bus.stop()
  })

  it("streams a short heartbeat on every third beat, with the state at that moment", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: BEAT })
    const { bus, events, run, reporter } = await setup()
    await reporter.write()
    expect(events.filter((e) => e.type === "engine.heartbeat").map((e) => [e.summary, e.level, e.data])).toEqual([
      ["Engine running, deciding", "debug", { status: "running", cycle_state: "deciding", ws_clients: 2, uptime_s: expect.any(Number), ai_spend_today_usd: 1.2346, ai_budget_usd: 3 }],
    ])
    vi.setSystemTime(BEAT + 5_000)
    run.status = "paused"
    await reporter.write()
    expect(events.filter((e) => e.type === "engine.heartbeat")).toHaveLength(1)
    vi.setSystemTime(BEAT + 15_000)
    await reporter.write()
    expect(events.filter((e) => e.type === "engine.heartbeat").at(-1)).toMatchObject({ summary: "Engine paused, deciding", data: { status: "paused" } })
    await bus.stop()
  })

  it("keeps the last trigger count when the policy can't be read, and reports no spend without a budget", async () => {
    const { bus, triggers, reporter } = await setup({ budget: { status: async () => Promise.reject(new Error("db down")) } })
    await reporter.write()
    triggers.fail = true
    await reporter.write()
    expect(await db.col.engineStatus.findOne({ _id: "engine" })).toMatchObject({ ai: { spend_today_usd: 0, calls_today: 0, last_call_at: null, last_error: null }, wire: { triggers_today: 4 } })
    await bus.stop()
  })
})
