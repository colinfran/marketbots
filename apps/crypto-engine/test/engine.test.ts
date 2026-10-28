import { randomUUID } from "node:crypto"
import type { Command } from "@mb/crypto-core/commands"
import { utcDay, type CommandDoc } from "@mb/crypto-core/db"
import type { EngineEvent } from "@mb/crypto-core/events"
import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { createLogger, silentLogger } from "@mb/engine-kit/log"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AiRunner } from "../src/ai/runner"
import { Alerts } from "../src/alerts"
import type { EventBus } from "../src/bus/event-bus"
import type { Database } from "../src/db/mongo"
import { Engine } from "../src/engine"
import { loadEnv } from "../src/env"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import type { CandleCache } from "../src/market/candles"
import type { MarketHub } from "../src/market/hub"
import { Ledger } from "../src/portfolio/ledger"
import { EngineStateStore, loadSettings } from "../src/state/stores"
import type { StreamServer } from "../src/stream/server"
import type { KrakenRest } from "../src/venues/kraken/rest"
import type { Wire } from "../src/wire/wire"
import { useTestDb } from "./helpers/db"
import { fakeHub, FakeWallet, makeBus } from "./helpers/fakes"

const db = useTestDb()
let bus: EventBus
let engine: Engine
let events: EngineEvent[]
let queues: (string[] | undefined)[]
let lines: Record<string, unknown>[]

// Generous: the engine polls commands every second, and on the busy trading server (backfills,
// the GPU) a pass can take several. A real failure still times out.
const until = async (check: () => Promise<boolean> | boolean, ms = 15_000) => {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Queues a command like the dashboard does and waits for the engine to answer it. */
const command = async (c: Command): Promise<CommandDoc> => {
  const id = randomUUID()
  await db.col.commands.insertOne({ _id: id, type: c.type, command: c, status: "pending", created_at: new Date(), created_by: "owner", processed_at: null, result: null, error: null })
  await until(async () => ["done", "failed", "rejected"].includes((await db.col.commands.findOne({ _id: id }))!.status))
  return (await db.col.commands.findOne({ _id: id }))!
}

const focus = { symbol: "BTC/USD", rule: "held_negative", action: "review" as const, severity: 70, polarity: -1 as const, item_ids: ["i1"], trigger_id: "t1", headline: "BTC exchange hack" }

/** The trigger record the wire policy writes when it queues a focus. */
const queuedTrigger = (id: string) =>
  db.col.wireTriggers.insertOne({ _id: id, at: new Date(), rule: "held_negative", action: "review", status: "queued", reason: "queued behind a running cycle or the minimum gap", item_ids: ["i1"], symbols: ["BTC/USD"], severity: 70, cycle_id: null, queue_wait_ms: null, expires_at: new Date(Date.now() + 86_400_000) })

type Internals = {
  eventQueue: Map<string, { severity: number; item_ids: string[]; trigger_id: string }>
  /** The 30-second scheduler tick: after a resume, the first one drains the event queue. */
  schedule: () => Promise<void>
}
const internals = () => engine as unknown as Internals

beforeEach(async () => {
  bus = await makeBus(db.col)
  events = []
  queues = []
  lines = []
  bus.subscribe((e) => events.push(e))
  await db.col.cycles.insertOne({ _id: "interrupted", status: "running" } as never)
  const env = loadEnv({ MONGODB_URI: "mongodb://test", STREAM_TOKEN_SECRET: "x".repeat(40), ENGINE_INSTANCE: "test" })
  const settings = await loadSettings(db.col, env, silentLogger)
  const state = await EngineStateStore.load(db.col)
  const calls = new AiCallLog(db.col, utcDay)
  const hub = fakeHub() as unknown as MarketHub
  const cli = new FakeWallet().cli()
  const ledger = new Ledger(db.col, bus)
  engine = new Engine({
    env,
    log: createLogger("info", {}, (line) => lines.push(JSON.parse(line))),
    db: { col: db.col } as Database,
    bus,
    settings,
    state,
    hub,
    rest: {} as KrakenRest,
    candles: {} as CandleCache,
    cli,
    ledger,
    executor: new Executor(db.col, ledger, new PaperWalletExecution(cli, hub), bus, silentLogger),
    ai: new AiRunner(calls, silentLogger),
    calls,
    alerts: new Alerts(db.col, bus, silentLogger, null, null),
    stream: { clientCount: 0 } as unknown as StreamServer,
    // The news engine is covered by its own tests; here it only has to be present and inert.
    wire: {
      start: async () => undefined,
      stop: () => undefined,
      reconcile: () => undefined,
      onItem: () => undefined,
      markNotable: async () => [],
      healthy: () => false,
      health: (extra: { event_queue?: string[] } = {}) => {
        queues.push(extra.event_queue)
        return { mode: "live", sources: [], items_last_hour: 0, triggers_today: 0, event_queue: extra.event_queue ?? [] }
      },
    } as unknown as Wire,
  })
  await engine.start()
})

afterEach(async () => {
  vi.useRealTimers()
  await engine.shutdown("test over")
  await bus.stop()
})

describe("Engine", () => {
  it("starts up, reconciles with the paper wallet and reports its health", async () => {
    await until(async () => (await db.col.engineStatus.findOne({ _id: "engine" })) !== null)
    const status = (await db.col.engineStatus.findOne({ _id: "engine" }))!
    expect(status).toMatchObject({ status: "running", instance: "test", kill_switch: false, paper_wallet: { ok: true, workspace: "test" }, reconciliation: { ok: true }, ai: { enabled: false } })
    // The dashboard reads fields by name, but the document keeps its field order.
    expect(Object.keys(status)).toEqual([
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
      "kraken",
      "paper_wallet",
      "symbols",
      "ai",
      "system",
      "last_cycle",
      "next_cycle_at",
      "reconciliation",
      "errors_last_hour",
      "wire",
    ])
    expect(engine.ready).toBe(true)
    expect(await db.col.cycles.findOne({ _id: "interrupted" })).toMatchObject({ status: "failed", error: "the engine restarted during this cycle" })
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["engine.started", "engine.status", "alert"]))
  })

  it("pauses, resumes and applies settings from audited commands", async () => {
    expect(await command({ type: "pause", reason: "lunch" })).toMatchObject({ status: "done", result: "paused: no new decisions or entries; stops and targets stay active" })
    expect(engine.status).toBe("paused")
    expect(await db.col.engineState.findOne({ _id: "engine" })).toMatchObject({ status: "paused", pause_reason: "lunch" })
    expect(await command({ type: "resume" })).toMatchObject({ status: "done", result: "running" })
    expect(engine.status).toBe("running")
    const updated = await command({ type: "settings.update", patch: { schedule: { crypto_scan_minutes: 45 } }, expected_version: 1 })
    expect(updated).toMatchObject({ status: "done", result: "1 setting updated (v2)" })
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.schedule.crypto_scan_minutes).toBe(45)
    expect(await command({ type: "settings.update", patch: { schedule: { crypto_scan_minutes: 50 } }, expected_version: 1 })).toMatchObject({ status: "failed", error: expect.stringContaining("reload and retry") })
    expect(await command({ type: "strategy.set_enabled", strategy: "trend", enabled: false })).toMatchObject({ status: "done", result: "trend disabled" })
    expect(await db.col.audit.countDocuments({ action: "settings.update" })).toBe(2)
    expect(events.filter((e) => e.type === "engine.status").map((e) => e.summary)).toEqual(["Engine running: startup complete", "Engine paused: lunch", "Engine running: resumed from the dashboard"])
  })

  it("holds news triggers while it can't run them, merged by symbol", async () => {
    await command({ type: "pause", reason: "test" })
    expect(engine.requestEventCycle(focus)).toBe("queued")
    expect(engine.requestEventCycle({ ...focus, severity: 60, item_ids: ["i2"], trigger_id: "t2" })).toBe("queued")
    expect(engine.requestEventCycle({ ...focus, symbol: null, severity: 50, item_ids: ["i3"], trigger_id: "t3" })).toBe("queued")
    expect(internals().eventQueue.get("BTC/USD")).toMatchObject({ severity: 70, item_ids: ["i1", "i2"], trigger_id: "t1" })
    expect(internals().eventQueue.size).toBe(2)
    // The heartbeat lists what waits. It runs every 5 s, so allow two beats plus margin on a busy machine.
    await until(() => queues.some((q) => q?.length === 2), 12_000)
    expect(queues.find((q) => q?.length === 2)).toEqual(["BTC/USD", "MARKET"])
  })

  it("drops a trigger queued while paused once it has waited 30 minutes, so resuming never runs it", async () => {
    // Only the clock is faked (and keeps ticking), so the jump below moves every timestamp alike.
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true })
    await command({ type: "pause", reason: "test" })
    await queuedTrigger("t1")
    expect(engine.requestEventCycle(focus)).toBe("queued")
    vi.setSystemTime(Date.now() + 31 * 60_000)
    expect(await command({ type: "resume" })).toMatchObject({ status: "done", result: "running" })
    await internals().schedule()
    expect(internals().eventQueue.size).toBe(0)
    await until(async () => (await db.col.wireTriggers.findOne({ _id: "t1" }))?.status === "suppressed")
    expect(await db.col.wireTriggers.findOne({ _id: "t1" })).toMatchObject({ reason: "expired: waited 31 min in the queue", cycle_id: null, queue_wait_ms: null })
    expect(lines.filter((l) => l.msg === "event trigger expired")).toEqual([expect.objectContaining({ level: "info", symbol: "BTC/USD", rule: "held_negative", reason: "expired: waited 31 min in the queue" })])
    // The scheduled scan that was due runs instead; no event cycle ever starts.
    await until(async () => (await db.col.cycles.countDocuments({ kind: "scheduled" })) === 1)
    expect(await db.col.cycles.countDocuments({ kind: "event" })).toBe(0)
    expect(events.filter((e) => e.type === "cycle.started").map((e) => (e.data as { trigger: string }).trigger)).toEqual(["scheduled"])
  })

  it("runs a trigger queued while paused when trading resumes within 30 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true })
    await command({ type: "pause", reason: "test" })
    await queuedTrigger("t1")
    expect(engine.requestEventCycle(focus)).toBe("queued")
    vi.setSystemTime(Date.now() + 29 * 60_000)
    expect(await command({ type: "resume" })).toMatchObject({ status: "done", result: "running" })
    await internals().schedule()
    expect(internals().eventQueue.size).toBe(0)
    await until(async () => (await db.col.cycles.countDocuments({ kind: "event" })) === 1)
    const cycle = (await db.col.cycles.findOne({ kind: "event" }))!
    expect(cycle).toMatchObject({ trigger: "event: held negative BTC/USD", wire_trigger_id: "t1", wire_item_ids: ["i1"] })
    // Once the cycle ends, the trigger records which cycle served it and how long it waited.
    await until(async () => (await db.col.wireTriggers.findOne({ _id: "t1" }))?.cycle_id === cycle._id)
    const served = (await db.col.wireTriggers.findOne({ _id: "t1" }))!
    expect(served.status).toBe("queued")
    expect(served.queue_wait_ms).toBeGreaterThanOrEqual(29 * 60_000)
    expect(served.queue_wait_ms).toBeLessThan(30 * 60_000)
    expect(lines.some((l) => l.msg === "event trigger expired")).toBe(false)
  })

  it("halts with the kill switch and stays paused after release", async () => {
    expect(await command({ type: "kill_switch.engage", reason: "test", liquidate: false })).toMatchObject({ status: "done", result: "halted: no new orders; stops and targets stay active" })
    expect(engine.status).toBe("halted")
    expect(await command({ type: "resume" })).toMatchObject({ status: "failed", error: "the kill switch is engaged; release it first" })
    expect(await command({ type: "cycle.run_now" })).toMatchObject({ status: "failed", error: "engine is halted" })
    expect(await command({ type: "kill_switch.release", confirm: "RELEASE" })).toMatchObject({ status: "done", result: "kill switch released; engine paused until you resume" })
    expect(engine.status).toBe("paused")
    expect(await command({ type: "kill_switch.engage", reason: "again", liquidate: true })).toMatchObject({ status: "done", result: "halted and liquidated: no positions" })
    expect(await db.col.notifications.countDocuments({ title: "Kill switch engaged" })).toBe(2)
  })

  it("schedules and cancels the one-time seed, and replays news items only if they exist", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString()
    expect(await command({ type: "seed.schedule", amount_usd: 1_234.5678, at })).toMatchObject({ status: "done", result: `one-time seed of $1,234.568 scheduled for ${at}` })
    expect(await command({ type: "seed.schedule", amount_usd: 500, at })).toMatchObject({ status: "failed", error: expect.stringContaining("already scheduled") })
    expect(await command({ type: "seed.cancel" })).toMatchObject({ status: "done", result: `seed scheduled for ${at} canceled` })
    expect(await command({ type: "seed.cancel" })).toMatchObject({ status: "failed", error: "no scheduled seed to cancel" })
    expect(await command({ type: "wire.replay", item_id: "missing-item" })).toMatchObject({ status: "failed", error: "no wire item with that id" })
  })
})
