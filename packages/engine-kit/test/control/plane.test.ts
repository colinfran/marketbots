import type { SeedRunDoc } from "@mb/core/db"
import type { EngineEvent } from "@mb/core/events"
import { describe, expect, it } from "vitest"
import { ControlPlane, type ControlWording } from "../../src/control/plane"
import { EngineStateStore } from "../../src/state/stores"
import { makeTestBus } from "../../src/testing/bus"
import { EPHEMERAL, useTestDb, type TestEvents, type TestRunStatus } from "../helpers/bot"

const db = useTestDb()

const WORDING: ControlWording = {
  paused: "paused: no new test cycles",
  halted: "halted: no new test orders",
  usd: (amount) => `$${amount.toFixed(2)}`,
  seedScheduled: "; it runs at the test open",
  seedInterrupted: "check the test books",
  seedFailedPath: (cycleId) => (cycleId ? `/cycles/${cycleId}` : "/admin"),
}

type Item = { _id: string; title: string; severity: number }
type SettingsResult = { ok: true; changes: number } | { ok: false; error: string }

const seedRun = (overrides: Partial<SeedRunDoc>): SeedRunDoc => ({
  _id: "seed-1",
  status: "scheduled",
  amount_usd: 1_000,
  at: new Date(Date.now() - 3 * 3_600_000),
  created_at: new Date(),
  created_by: "owner",
  force: false,
  started_at: null,
  cycle_id: null,
  result: null,
  error: null,
  done_at: null,
  ...overrides,
})

const setup = async ({ liquidate = async () => ["sold A", "sold B"], settingsResult = { ok: true, changes: 2 } as SettingsResult } = {}) => {
  const bus = await makeTestBus<TestEvents>(db.col, EPHEMERAL)
  const events: EngineEvent<TestEvents>[] = []
  bus.subscribe((e) => events.push(e))
  const state = await EngineStateStore.load(db.col)
  const alerts: { level: string; title: string; message: string; path?: string }[] = []
  const patches: { patch: Record<string, unknown>; by: string; expected: number | null }[] = []
  const items = new Map<string, Item>([["item-1", { _id: "item-1", title: "x".repeat(130), severity: 72 }]])
  const replayed: Item[] = []
  const control = new ControlPlane<TestRunStatus, Item>({
    col: { seedRuns: db.col.seedRuns, wireItems: { findOne: async ({ _id }) => items.get(_id) ?? null } },
    bus,
    state,
    settings: {
      version: 3,
      apply: async (patch, by, expected) => {
        patches.push({ patch, by, expected })
        return settingsResult
      },
    },
    alerts: {
      send: async (level, title, message, opts) => {
        alerts.push({ level, title, message, path: opts?.path })
      },
    },
    policy: {
      replay: async (item) => {
        replayed.push(item)
        return "would review"
      },
    },
    liquidate,
    wording: WORDING,
  })
  return { bus, events, state, alerts, patches, replayed, control }
}

describe("ControlPlane", () => {
  it("owns the run status: pause, resume and the kill switch, audited and announced", async () => {
    const { bus, events, state, alerts, control } = await setup()
    expect(control.status).toBe("starting")
    expect(control.ready).toBe(false)
    control.emitStatus("startup complete")
    expect(control.status).toBe("running")
    expect(control.ready).toBe(true)

    expect(await control.handle({ type: "pause", reason: "lunch" }, "owner")).toBe("paused: no new test cycles")
    expect(control.status).toBe("paused")
    expect(state.state).toMatchObject({ status: "paused", pause_reason: "lunch" })
    expect(await control.handle({ type: "pause" }, "owner")).toBe("paused: no new test cycles")
    expect(await control.handle({ type: "resume" }, "owner")).toBe("running")
    expect(state.state).toMatchObject({ status: "running", pause_reason: null })

    expect(await control.handle({ type: "kill_switch.engage", reason: "too fast", liquidate: false }, "owner")).toBe("halted: no new test orders")
    expect(control.status).toBe("halted")
    expect(control.ready).toBe(true)
    expect(state.state.kill_switch).toMatchObject({ engaged: true, reason: "too fast", by: "owner", liquidate: false })
    await expect(control.handle({ type: "resume" }, "owner")).rejects.toThrow("the kill switch is engaged; release it first")
    expect(await control.handle({ type: "kill_switch.release", confirm: "RELEASE" }, "owner")).toBe("kill switch released; engine paused until you resume")
    // Releasing never resumes by itself.
    expect(control.status).toBe("paused")
    expect(state.state).toMatchObject({ status: "paused", kill_switch: { engaged: false, reason: null, at: null, by: null, liquidate: false } })

    expect(events.filter((e) => e.type === "engine.status").map((e) => [e.summary, e.data])).toEqual([
      ["Engine running: startup complete", { status: "running", kill_switch: false, reason: "startup complete" }],
      ["Engine paused: lunch", { status: "paused", kill_switch: false, reason: "lunch" }],
      ["Engine paused: paused from the dashboard", { status: "paused", kill_switch: false, reason: "paused from the dashboard" }],
      ["Engine running: resumed from the dashboard", { status: "running", kill_switch: false, reason: "resumed from the dashboard" }],
      ["Engine halted: too fast", { status: "halted", kill_switch: true, reason: "too fast" }],
      ["Engine paused: kill switch released; paused until resumed", { status: "paused", kill_switch: false, reason: "kill switch released; paused until resumed" }],
    ])
    expect((await db.col.audit.find().toArray()).map((a) => [a.actor, a.action, a.details.reason])).toEqual([
      ["owner", "pause", undefined],
      ["owner", "pause", undefined],
      ["owner", "resume", undefined],
      ["owner", "kill_switch.engage", "too fast"],
      ["owner", "kill_switch.release", undefined],
    ])
    expect(alerts).toEqual([{ level: "critical", title: "Kill switch engaged", message: "too fast", path: undefined }])
    await bus.stop()
  })

  it("closes positions through the bot for a liquidating kill switch, and halts the engine's own way too", async () => {
    const { bus, alerts, state, control } = await setup()
    expect(await control.handle({ type: "kill_switch.engage", reason: "panic", liquidate: true }, "owner")).toBe("halted and liquidated: sold A; sold B")
    expect(alerts.at(-1)).toMatchObject({ level: "critical", title: "Kill switch engaged", message: "panic\nLiquidation: sold A; sold B" })
    await bus.stop()

    const quiet = await setup({ liquidate: async () => [] })
    expect(await quiet.control.handle({ type: "kill_switch.engage", reason: "panic", liquidate: true }, "owner")).toBe("halted and liquidated: no positions")
    expect(quiet.alerts.at(-1)).toMatchObject({ message: "panic" })
    // The drawdown halt engages it as the engine.
    expect(await quiet.control.engageKillSwitch("drawdown 9% reached the 8% limit", "engine", false)).toEqual([])
    expect(quiet.state.state.kill_switch).toMatchObject({ engaged: true, by: "engine", reason: "drawdown 9% reached the 8% limit" })
    expect(state.state.kill_switch.engaged).toBe(true)
    await quiet.bus.stop()
  })

  it("applies settings patches through the store and reports its version", async () => {
    const two = await setup()
    expect(await two.control.handle({ type: "settings.update", patch: { ai: { research_timeout_seconds: 240 } }, expected_version: 3 }, "owner")).toBe("2 settings updated (v3)")
    expect(two.patches).toEqual([{ patch: { ai: { research_timeout_seconds: 240 } }, by: "owner", expected: 3 }])
    const one = await setup({ settingsResult: { ok: true, changes: 1 } })
    expect(await one.control.handle({ type: "settings.update", patch: {}, expected_version: 3 }, "owner")).toBe("1 setting updated (v3)")
    const none = await setup({ settingsResult: { ok: true, changes: 0 } })
    expect(await none.control.handle({ type: "settings.update", patch: {}, expected_version: 3 }, "owner")).toBe("no changes")
    const bad = await setup({ settingsResult: { ok: false, error: "risk.max_position_pct: too big" } })
    await expect(bad.control.handle({ type: "settings.update", patch: {}, expected_version: 3 }, "owner")).rejects.toThrow("risk.max_position_pct: too big")
    for (const s of [two, one, none, bad]) await s.bus.stop()
  })

  it("schedules and cancels the one-time seed in the bot's words", async () => {
    const { bus, control } = await setup()
    const at = new Date(Date.now() + 3_600_000).toISOString()
    expect(await control.handle({ type: "seed.schedule", amount_usd: 1_500, at }, "owner")).toBe(`one-time seed of $1500.00 scheduled for ${at}; it runs at the test open`)
    await expect(control.handle({ type: "seed.schedule", amount_usd: 1_500, at }, "owner")).rejects.toThrow(/already scheduled/)
    expect(await control.handle({ type: "seed.cancel" }, "owner")).toBe(`seed scheduled for ${at} canceled`)
    await expect(control.handle({ type: "seed.cancel" }, "owner")).rejects.toThrow("no scheduled seed to cancel")
    expect(await control.handle({ type: "seed.schedule", amount_usd: 250.5, at, force: true }, "owner")).toBe(`one-time seed of $250.50 scheduled for ${at} (forced); it runs at the test open`)
    expect(await db.col.seedRuns.findOne({ status: "scheduled" })).toMatchObject({ amount_usd: 250.5, created_by: "owner", force: true })
    await bus.stop()
  })

  it("replays a stored news item through the policy", async () => {
    const { bus, replayed, control } = await setup()
    await expect(control.handle({ type: "wire.replay", item_id: "missing-1" }, "owner")).rejects.toThrow("no wire item with that id")
    expect(await control.handle({ type: "wire.replay", item_id: "item-1" }, "owner")).toBe(`${"x".repeat(120)} (severity 72): would review`)
    expect(replayed.map((i) => i._id)).toEqual(["item-1"])
    await bus.stop()
  })

  it("fails interrupted, missed and unsuccessful seed runs, alerting and announcing each", async () => {
    const { bus, events, alerts, control } = await setup()
    await control.failInterruptedSeed()
    expect(alerts).toEqual([])
    await db.col.seedRuns.insertOne(seedRun({ _id: "running", status: "running" }))
    await control.failInterruptedSeed()
    expect(alerts.at(-1)).toEqual({
      level: "error",
      title: "Seed buy interrupted",
      message: "The engine restarted while the one-time seed was running. It is not retried; check the test books, then schedule it again from Admin if needed.",
      path: "/admin",
    })
    expect(await db.col.seedRuns.findOne({ _id: "running" })).toMatchObject({ status: "failed", error: "the engine restarted during the seed run" })

    await db.col.seedRuns.insertOne(seedRun({ _id: "missed" }))
    await control.failMissedSeeds((run) => new Date(run.at.getTime() + 3_600_000))
    const missed = (await db.col.seedRuns.findOne({ _id: "missed" }))!
    expect(missed.status).toBe("failed")
    expect(alerts.at(-1)).toEqual({ level: "error", title: "Seed buy missed", message: `${missed.error}. Nothing was bought; schedule it again from Admin if you still want it.`, path: "/admin" })
    expect(events.filter((e) => e.type === "seed.completed").map((e) => [e.summary, e.level, e.data])).toEqual([
      ["One-time seed missed", "warn", { seed_id: "missed", cycle_id: null, status: "failed", allocations: [], executed: 0, error: missed.error }],
    ])

    const run = seedRun({ _id: "unlucky", status: "running" })
    await db.col.seedRuns.insertOne(run)
    const result = { allocations: [{ symbol: "AAA", weight_pct: 60, notional_usd: 600, thesis: "core" }], orders: [], notes: ["no fills"], rationale: null }
    await control.failSeed(run, "no buy went through (nothing allocated)", "cycle-9", result)
    expect(await db.col.seedRuns.findOne({ _id: "unlucky" })).toMatchObject({ status: "failed", cycle_id: "cycle-9", result, error: "no buy went through (nothing allocated)" })
    expect(events.at(-1)).toMatchObject({
      type: "seed.completed",
      summary: "One-time seed failed: no buy went through (nothing allocated)",
      level: "warn",
      data: { seed_id: "unlucky", cycle_id: "cycle-9", status: "failed", allocations: [{ symbol: "AAA", weight_pct: 60, notional_usd: 600 }], executed: 0, error: "no buy went through (nothing allocated)" },
    })
    expect(alerts.at(-1)).toEqual({ level: "error", title: "Seed buy failed", message: "no buy went through (nothing allocated). It is not retried; schedule it again from Admin if you still want it.", path: "/cycles/cycle-9" })
    await control.failSeed(run, "crashed: boom", null)
    expect(alerts.at(-1)).toMatchObject({ title: "Seed buy failed", path: "/admin" })
    await bus.stop()
  })
})
