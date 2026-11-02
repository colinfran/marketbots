import type { EngineStateDoc } from "@mb/core/db"
import type { EngineEvent } from "@mb/core/events"
import type { WireStatus } from "@mb/core/wire"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StatusReporter, type StatusReporterDeps } from "../../src/control/status"
import { makeTestBus } from "../../src/testing/bus"
import { EPHEMERAL, useTestDb, type TestCycleState, type TestEvents, type TestRunStatus, type TestStatusDoc } from "../helpers/bot"

const db = useTestDb()

/** A round moment to start the fake clock at. */
const BEAT = 1_800_000_000_000 - (1_800_000_000_000 % 15_000)

const setup = async (overrides: Partial<StatusReporterDeps<TestStatusDoc>> = {}) => {
  const bus = await makeTestBus<TestEvents>(db.col, EPHEMERAL)
  const events: EngineEvent<TestEvents>[] = []
  bus.subscribe((e) => events.push(e))
  const run: { status: TestRunStatus; cycle_state: TestCycleState; current_task: string | null } = { status: "running", cycle_state: "deciding", current_task: "deciding AAA" }
  const state: { state: EngineStateDoc } = {
    state: { _id: "engine", status: "running", pause_reason: null, kill_switch: { engaged: true, reason: "test", at: null, by: "owner", liquidate: false }, updated_at: new Date() },
  }
  const healthCalls: { triggers_today: number }[] = []
  const triggers = { fail: false }
  const reporter = new StatusReporter<TestStatusDoc>({
    col: db.col,
    bus,
    calls: { today: async () => ({ calls: 7 }) },
    ai: { available: true },
    state,
    stream: { clientCount: 2 },
    wire: {
      health: (extra) => {
        healthCalls.push(extra)
        return { mode: "live", sources: [], items_last_hour: 5, triggers_today: extra.triggers_today } satisfies WireStatus
      },
    },
    policy: { triggersToday: async () => (triggers.fail ? Promise.reject(new Error("db down")) : 4) },
    instance: "kit-1",
    version: "9.9.9",
    run: () => run,
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
  it("builds the shared fields with the bot's section, in the bot's field order", async () => {
    const { bus, healthCalls, reporter } = await setup()
    await db.col.aiCalls.insertOne({ _id: "a1", at: new Date(Date.now() - 60_000), ok: true, error: null } as never)
    await db.col.aiCalls.insertOne({ _id: "a2", at: new Date(), ok: false, error: "gateway timeout" } as never)
    await db.col.events.insertMany([
      { _id: 1, ts: new Date().toISOString(), level: "error" } as never,
      { _id: 2, ts: new Date(Date.now() - 2 * 3_600_000).toISOString(), level: "error" } as never,
      { _id: 3, ts: new Date().toISOString(), level: "warn" } as never,
    ])
    await reporter.beat()
    const doc = reporter.latest!
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
      ai: { calls_today: 7, last_error: "gateway timeout", enabled: true },
      last_cycle: "cycle-1",
      errors_last_hour: 1,
      wire: { mode: "live", items_last_hour: 5, triggers_today: 4 },
    })
    expect(Object.keys(doc.ai)).toEqual(["calls_today", "last_call_at", "last_error", "enabled"])
    expect(doc.system).toEqual({ cpu_pct: expect.any(Number), rss_mb: expect.any(Number), heap_mb: expect.any(Number), load_avg: expect.any(Array), uptime_s: expect.any(Number) })
    expect(healthCalls).toEqual([{ triggers_today: 4 }])
    await bus.stop()
  })

  it("keeps the latest beat's status only, and none before the first", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: BEAT })
    const { bus, run, reporter } = await setup()
    expect(reporter.latest).toBeNull()
    await reporter.beat()
    expect(reporter.latest).toMatchObject({ at: new Date(BEAT), status: "running" })
    vi.setSystemTime(BEAT + 10_000)
    run.status = "paused"
    await reporter.beat()
    expect(reporter.latest).toMatchObject({ at: new Date(BEAT + 10_000), status: "paused", started_at: expect.any(Date) })
    await bus.stop()
  })

  it("streams a short heartbeat on every beat, with the state at that moment", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: BEAT })
    const { bus, events, run, reporter } = await setup()
    await reporter.beat()
    expect(events.filter((e) => e.type === "engine.heartbeat").map((e) => [e.summary, e.level, e.data])).toEqual([
      ["Engine running, deciding", "debug", { status: "running", cycle_state: "deciding", ws_clients: 2, uptime_s: expect.any(Number), ai_calls_today: 7 }],
    ])
    vi.setSystemTime(BEAT + 10_000)
    run.status = "paused"
    await reporter.beat()
    expect(events.filter((e) => e.type === "engine.heartbeat")).toHaveLength(2)
    expect(events.filter((e) => e.type === "engine.heartbeat").at(-1)).toMatchObject({ summary: "Engine paused, deciding", data: { status: "paused" } })
    await bus.stop()
  })

  it("reads its counts once a minute, not on every beat", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: BEAT })
    const { bus, healthCalls, reporter } = await setup()
    const beat = async () => {
      await reporter.beat()
      return reporter.latest!
    }
    expect(await beat()).toMatchObject({ errors_last_hour: 0, ai: { last_call_at: null } })
    await db.col.events.insertOne({ _id: 1, ts: new Date().toISOString(), level: "error" } as never)
    await db.col.aiCalls.insertOne({ _id: "a1", at: new Date(), ok: true, error: null } as never)
    vi.setSystemTime(BEAT + 55_000)
    expect(await beat()).toMatchObject({ errors_last_hour: 0, ai: { last_call_at: null } })
    vi.setSystemTime(BEAT + 60_000)
    expect(await beat()).toMatchObject({ errors_last_hour: 1, ai: { last_call_at: new Date(BEAT) } })
    expect(healthCalls).toEqual([{ triggers_today: 4 }, { triggers_today: 4 }, { triggers_today: 4 }])
    await bus.stop()
  })

  it("keeps the last trigger count when the policy can't be read, and reports no calls when the call log can't be read", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: BEAT })
    const { bus, healthCalls, triggers, reporter } = await setup({ calls: { today: async () => Promise.reject(new Error("db down")) } })
    await reporter.beat()
    triggers.fail = true
    vi.setSystemTime(BEAT + 60_000)
    await reporter.beat()
    expect(reporter.latest).toMatchObject({ ai: { calls_today: 0, last_call_at: null, last_error: null } })
    expect(healthCalls).toEqual([{ triggers_today: 4 }, { triggers_today: 4 }])
    await bus.stop()
  })
})
