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
}

type Item = { _id: string; title: string; severity: number }
type SettingsResult = { ok: true; changes: number } | { ok: false; error: string }

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
    col: { wireItems: { findOne: async ({ _id }) => items.get(_id) ?? null } },
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
    agent: {
      ask: (question) => `asked: ${question}`,
      review: (symbols) => `reviewing ${symbols.join(", ") || "the book and the market"}`,
      resumeEntries: async () => "resumed",
    },
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
    expect(await two.control.handle({ type: "settings.update", patch: { agent: { sweep_minutes: 240 } }, expected_version: 3 }, "owner")).toBe("2 settings updated (v3)")
    expect(two.patches).toEqual([{ patch: { agent: { sweep_minutes: 240 } }, by: "owner", expected: 3 }])
    const one = await setup({ settingsResult: { ok: true, changes: 1 } })
    expect(await one.control.handle({ type: "settings.update", patch: {}, expected_version: 3 }, "owner")).toBe("1 setting updated (v3)")
    const none = await setup({ settingsResult: { ok: true, changes: 0 } })
    expect(await none.control.handle({ type: "settings.update", patch: {}, expected_version: 3 }, "owner")).toBe("no changes")
    const bad = await setup({ settingsResult: { ok: false, error: "risk.max_position_pct: too big" } })
    await expect(bad.control.handle({ type: "settings.update", patch: {}, expected_version: 3 }, "owner")).rejects.toThrow("risk.max_position_pct: too big")
    for (const s of [two, one, none, bad]) await s.bus.stop()
  })

  it("hands the agent its commands, and wakes it only while trading runs", async () => {
    const { bus, control } = await setup()
    control.emitStatus("startup complete")
    expect(await control.handle({ type: "agent.ask", question: "What do you hold?" }, "owner")).toBe("asked: What do you hold?")
    expect(await control.handle({ type: "agent.review", symbols: ["AAA"] }, "owner")).toBe("reviewing AAA")
    expect(await control.handle({ type: "agent.review" }, "owner")).toBe("reviewing the book and the market")
    expect(await control.handle({ type: "agent.resume_entries" }, "owner")).toBe("resumed")
    await control.handle({ type: "pause" }, "owner")
    await expect(control.handle({ type: "agent.review" }, "owner")).rejects.toThrow("engine is paused")
    await bus.stop()
  })

  it("replays a stored news item through the policy", async () => {
    const { bus, replayed, control } = await setup()
    await expect(control.handle({ type: "wire.replay", item_id: "missing-1" }, "owner")).rejects.toThrow("no wire item with that id")
    expect(await control.handle({ type: "wire.replay", item_id: "item-1" }, "owner")).toBe(`${"x".repeat(120)} (severity 72): would review`)
    expect(replayed.map((i) => i._id)).toEqual(["item-1"])
    await bus.stop()
  })
})
