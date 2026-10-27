import type { EngineStateDoc } from "@mb/core/db"
import type { EventFocus } from "@mb/core/wire"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EventCycleQueue, type EventCycleQueueOptions, type QueuedEvent } from "../../src/control/event-queue"
import { createLogger } from "../../src/log"
import { useTestDb } from "../helpers/bot"

const db = useTestDb()
const MIN = 60_000

const focus = (overrides: Partial<EventFocus> = {}): EventFocus => ({
  symbol: "AAA",
  rule: "held_negative",
  action: "review",
  severity: 70,
  polarity: -1,
  item_ids: ["i1"],
  trigger_id: "t1",
  headline: "AAA sued",
  ...overrides,
})

const setup = (options: Partial<EventCycleQueueOptions> = {}) => {
  const state: { state: EngineStateDoc } = {
    state: { _id: "engine", status: "running", pause_reason: null, kill_switch: { engaged: false, reason: null, at: null, by: null, liquidate: false }, updated_at: new Date() },
  }
  const settings = { current: { wire: { event_min_gap_seconds: 0 } } }
  const started: { events: QueuedEvent[]; trigger: string }[] = []
  const lines: Record<string, unknown>[] = []
  const flags = { busy: false }
  const queue = new EventCycleQueue({
    col: db.col,
    log: createLogger("debug", {}, (line) => lines.push(JSON.parse(line))),
    state,
    settings,
    busy: () => flags.busy,
    start: (events, trigger) => started.push({ events, trigger }),
    expireAfterMs: null,
    ...options,
  })
  return { queue, state, settings, started, lines, flags }
}

const trigger = (id: string) =>
  db.col.wireTriggers.insertOne({ _id: id, at: new Date(), rule: "held_negative", action: "review", status: "queued", reason: "queued", item_ids: [], symbols: [], severity: 70, cycle_id: null, queue_wait_ms: null, expires_at: new Date(Date.now() + 86_400_000) })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("EventCycleQueue", () => {
  it("runs a trigger at once when trading runs and no cycle does", () => {
    const { queue, started } = setup()
    expect(queue.request(focus())).toBe("fired")
    expect(queue.request(focus({ symbol: null, rule: "macro_surprise", trigger_id: "t2" }))).toBe("fired")
    expect(started.map((s) => s.trigger)).toEqual(["event: held negative AAA", "event: macro surprise market"])
    expect(started[0].events).toEqual([{ ...focus(), queued_at: expect.any(Number) }])
    expect(queue.size).toBe(0)
  })

  it("merges waiting triggers by symbol, keeping the highest severity and every item", () => {
    const { queue, state, started } = setup()
    state.state = { ...state.state, status: "paused" }
    expect(queue.request(focus())).toBe("queued")
    const first = queue.get("AAA")!.queued_at
    expect(queue.request(focus({ severity: 80, item_ids: ["i2"], trigger_id: "t2" }))).toBe("queued")
    expect(queue.request(focus({ severity: 50, item_ids: ["i3", "i1"], trigger_id: "t3" }))).toBe("queued")
    expect(queue.request(focus({ symbol: null, trigger_id: "t4", item_ids: ["i9"] }))).toBe("queued")
    expect(queue.get("AAA")).toEqual({ ...focus({ severity: 80, item_ids: ["i1", "i2", "i3"], trigger_id: "t2" }), queued_at: first })
    expect(queue.keys()).toEqual(["AAA", "MARKET"])
    // The kill switch holds them too.
    state.state = { ...state.state, status: "running", kill_switch: { ...state.state.kill_switch, engaged: true } }
    expect(queue.drain()).toBe(false)
    state.state = { ...state.state, kill_switch: { ...state.state.kill_switch, engaged: false } }
    expect(queue.drain()).toBe(true)
    expect(started).toHaveLength(1)
    expect(started[0].trigger).toBe("event: held negative AAA, held negative market")
    expect(started[0].events.map((e) => e.trigger_id)).toEqual(["t2", "t4"])
    expect(queue.size).toBe(0)
  })

  it("waits for a running cycle, then for the minimum gap between event cycles", async () => {
    const { queue, settings, started, flags } = setup()
    flags.busy = true
    expect(queue.request(focus())).toBe("queued")
    flags.busy = false
    expect(queue.drain()).toBe(true)
    settings.current.wire.event_min_gap_seconds = 0.15
    expect(queue.request(focus({ symbol: "BBB", trigger_id: "t2" }))).toBe("queued")
    expect(queue.request(focus({ symbol: "CCC", trigger_id: "t3" }))).toBe("queued")
    expect(started).toHaveLength(1)
    // The gap timer runs them, merged into one cycle.
    await vi.waitFor(() => expect(started).toHaveLength(2), { timeout: 2_000, interval: 20 })
    expect(started[1].trigger).toBe("event: held negative BBB, held negative CCC")
  })

  it("stops its gap timer at shutdown", async () => {
    const { queue, settings, started } = setup()
    expect(queue.request(focus())).toBe("fired")
    settings.current.wire.event_min_gap_seconds = 0.1
    expect(queue.request(focus({ trigger_id: "t2" }))).toBe("queued")
    queue.stop()
    await new Promise((r) => setTimeout(r, 250))
    expect(started).toHaveLength(1)
    expect(queue.size).toBe(1)
  })

  it("with expiry and a gate (stock): waits outside the gate and drops stale triggers unrun", async () => {
    const window = { open: false }
    const { queue, started, lines } = setup({ expireAfterMs: 30 * MIN, gate: () => window.open })
    await trigger("t1")
    await trigger("t2")
    expect(queue.request(focus())).toBe("queued")
    expect(queue.request(focus({ symbol: "BBB", trigger_id: "t2" }))).toBe("queued")
    expect(queue.drain()).toBe(false)
    // Not stale yet.
    queue.expire(Date.now() + 29 * MIN)
    expect(queue.size).toBe(2)
    queue.expire(Date.now() + 31 * MIN)
    expect(queue.size).toBe(0)
    await vi.waitFor(async () => expect(await db.col.wireTriggers.countDocuments({ status: "suppressed" })).toBe(2), { timeout: 2_000, interval: 20 })
    expect(await db.col.wireTriggers.findOne({ _id: "t1" })).toMatchObject({ status: "suppressed", reason: "expired: waited 31 min in the queue" })
    expect(lines.map(({ level, msg, symbol, rule, reason }) => ({ level, msg, symbol, rule, reason }))).toEqual([
      { level: "info", msg: "event trigger expired", symbol: "AAA", rule: "held_negative", reason: "expired: waited 31 min in the queue" },
      { level: "info", msg: "event trigger expired", symbol: "BBB", rule: "held_negative", reason: "expired: waited 31 min in the queue" },
    ])
    // Every drain expires first, so a stale trigger never starts a cycle once the gate opens.
    expect(queue.request(focus({ trigger_id: "t3" }))).toBe("queued")
    window.open = true
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 45 * MIN)
    expect(queue.drain()).toBe(false)
    expect(queue.size).toBe(0)
    expect(started).toEqual([])
    vi.restoreAllMocks()
    expect(queue.request(focus({ trigger_id: "t4" }))).toBe("fired")
  })

  it("without expiry (crypto): keeps a trigger however long it waits, and runs it once trading does", () => {
    const { queue, state, started, lines } = setup()
    state.state = { ...state.state, status: "paused" }
    expect(queue.request(focus())).toBe("queued")
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * MIN)
    queue.expire()
    expect(queue.drain()).toBe(false)
    expect(queue.size).toBe(1)
    state.state = { ...state.state, status: "running" }
    expect(queue.drain()).toBe(true)
    expect(started.map((s) => s.events.map((e) => e.trigger_id))).toEqual([["t1"]])
    expect(lines).toEqual([])
  })

  it("records which cycle served each trigger and how long it waited", async () => {
    const { queue } = setup()
    await trigger("t1")
    await trigger("t2")
    const startedAt = Date.now()
    await queue.served(
      [
        { ...focus(), queued_at: startedAt - 4_000 },
        { ...focus({ trigger_id: "t2" }), queued_at: startedAt - 250 },
        { ...focus({ trigger_id: "gone" }), queued_at: startedAt },
      ],
      "cycle-1",
      startedAt,
    )
    expect(await db.col.wireTriggers.find().sort({ _id: 1 }).toArray()).toMatchObject([
      { _id: "t1", cycle_id: "cycle-1", queue_wait_ms: 4_000 },
      { _id: "t2", cycle_id: "cycle-1", queue_wait_ms: 250 },
    ])
  })
})
