import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { AiRunner } from "@mb/engine-kit/ai/runner"
import { silentLogger } from "@mb/engine-kit/log"
import type { Wire } from "../src/wire/wire"
import { randomUUID } from "node:crypto"
import type { Command } from "@mb/stock-core/commands"
import type { CommandDoc, StreamHealth } from "@mb/stock-core/db"
import type { EngineEvent } from "@mb/stock-core/events"
import { marketDay } from "@mb/stock-core/time"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Alerts } from "../src/alerts"
import type { MarketStream } from "../src/alpaca/market-stream"
import type { TradeStream } from "../src/alpaca/trade-stream"
import type { EventBus } from "../src/bus/event-bus"
import type { Database } from "../src/db/mongo"
import { Engine } from "../src/engine"
import { loadEnv } from "../src/env"
import { LivePrices } from "../src/market/prices"
import { EngineStateStore, loadSettings } from "../src/state/stores"
import type { StreamServer } from "../src/stream/server"
import { fakeBroker, type FakeBroker } from "./helpers/broker"
import { makeBus } from "./helpers/ctx"
import { useTestDb } from "./helpers/db"
import { cycleDoc } from "./helpers/factories"

const db = useTestDb()
let broker: FakeBroker
let bus: EventBus
let engine: Engine
let events: EngineEvent[]
let symbols: string[][]

// Generous: the engine polls commands every second, and on the busy trading server (backfills,
// the GPU) a pass can take several. A real failure still times out.
const until = async (check: () => Promise<boolean> | boolean, ms = 15_000) => {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

const health = (): StreamHealth => ({ state: "connected", last_message_at: null, last_error: null })

/** Queues a command like the dashboard does and waits for the engine to answer it. */
const command = async (c: Command): Promise<CommandDoc> => {
  const id = randomUUID()
  await db.col.commands.insertOne({ _id: id, type: c.type, command: c, status: "pending", created_at: new Date(), created_by: "owner", processed_at: null, result: null, error: null })
  await until(async () => ["done", "failed", "rejected"].includes((await db.col.commands.findOne({ _id: id }))!.status))
  return (await db.col.commands.findOne({ _id: id }))!
}

beforeEach(async () => {
  broker = fakeBroker()
  broker.setPosition("AAPL", 10, 100)
  bus = await makeBus(db.col)
  events = []
  symbols = []
  bus.subscribe((e) => events.push(e))
  await db.col.cycles.insertOne(cycleDoc({ _id: "interrupted", status: "running" }))
  const env = loadEnv({ MONGODB_URI: "mongodb://test", ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s", STREAM_TOKEN_SECRET: "x".repeat(40), ENGINE_INSTANCE: "test" })
  const settings = await loadSettings(db.col, env, silentLogger)
  const state = await EngineStateStore.load(db.col)
  const calls = new AiCallLog(db.col, marketDay)
  engine = new Engine({
    env,
    log: silentLogger,
    db: { col: db.col } as Database,
    bus,
    settings,
    state,
    alpaca: broker.client,
    prices: new LivePrices(bus),
    tradeStream: { start: () => undefined, stop: () => undefined, health: health() } as unknown as TradeStream,
    marketStream: { start: () => undefined, stop: () => undefined, setSymbols: (s: string[]) => symbols.push(s), health: health(), symbols: [] } as unknown as MarketStream,
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
      health: () => ({ mode: "live", sources: [], items_last_hour: 0, triggers_today: 0, event_queue: [] }),
    } as unknown as Wire,
    coverage: { setSymbols: () => undefined, price: () => null },
  })
  await engine.start()
})

afterEach(async () => {
  await engine.shutdown("test over")
  await bus.stop()
})

describe("Engine", () => {
  it("starts up, reports its health and copies the account for the website", async () => {
    await until(async () => (await db.col.engineStatus.findOne({ _id: "engine" })) !== null)
    const status = (await db.col.engineStatus.findOne({ _id: "engine" }))!
    expect(status).toMatchObject({ status: "running", instance: "test", kill_switch: false, broker: { trade_stream: { state: "connected" } }, ai: { enabled: false } })
    expect(engine.ready).toBe(true)
    expect(await db.col.cycles.findOne({ _id: "interrupted" })).toMatchObject({ status: "timed_out", error: "the engine restarted during this cycle" })
    expect(await db.col.cache.findOne({ _id: "alpaca:account" })).not.toBeNull()
    expect(symbols[0]).toEqual(["AAPL", "SPY", "QQQ"])
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["engine.started", "engine.status", "alert"]))
  })

  it("pauses, resumes and applies settings from audited commands", async () => {
    expect(await command({ type: "pause", reason: "lunch" })).toMatchObject({ status: "done", result: expect.stringContaining("paused") })
    expect(engine.status).toBe("paused")
    expect(await command({ type: "resume" })).toMatchObject({ status: "done", result: "running" })
    const updated = await command({ type: "settings.update", patch: { options: { max_open_positions: 2 } }, expected_version: 1 })
    expect(updated).toMatchObject({ status: "done", result: "1 setting updated (v2)" })
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.options.max_open_positions).toBe(2)
    expect(await command({ type: "settings.update", patch: { risk: { max_position_pct: 500 } }, expected_version: 2 })).toMatchObject({ status: "failed" })
    expect(await db.col.audit.countDocuments({ action: "settings.update" })).toBe(1)
  })

  it("holds news triggers while it can't run them, merged by symbol, and drops them once stale", async () => {
    await command({ type: "pause", reason: "test" })
    await db.col.wireTriggers.insertOne({ _id: "t1", at: new Date(), rule: "held_negative", action: "review", status: "queued", reason: "queued", item_ids: ["i1"], symbols: ["AAPL"], severity: 70, cycle_id: null, queue_wait_ms: null, expires_at: new Date(Date.now() + 86_400_000) })
    const focus = { symbol: "AAPL", rule: "held_negative", action: "review" as const, severity: 70, polarity: -1 as const, item_ids: ["i1"], trigger_id: "t1", headline: "AAPL sued" }
    expect(engine.requestEventCycle(focus)).toBe("queued")
    expect(engine.requestEventCycle({ ...focus, severity: 60, item_ids: ["i2"], trigger_id: "t2" })).toBe("queued")
    const internals = engine as unknown as { eventQueue: Map<string, { severity: number; item_ids: string[]; trigger_id: string }>; expireEvents: (now: number) => void }
    expect(internals.eventQueue.get("AAPL")).toMatchObject({ severity: 70, item_ids: ["i1", "i2"], trigger_id: "t1" })
    internals.expireEvents(Date.now() + 31 * 60_000)
    expect(internals.eventQueue.size).toBe(0)
    await until(async () => (await db.col.wireTriggers.findOne({ _id: "t1" }))?.status === "suppressed")
    expect((await db.col.wireTriggers.findOne({ _id: "t1" }))!.reason).toMatch(/^expired: waited 3\d min in the queue$/)
    expect(await db.col.cycles.countDocuments({ kind: "event" })).toBe(0)
  })

  it("sends bad news about a core holding to a single-holding core review, not an event cycle", async () => {
    await command({ type: "pause", reason: "test" })
    const focus = { symbol: "SPY", rule: "core_negative", action: "review" as const, severity: 80, polarity: -1 as const, item_ids: ["i1"], trigger_id: "t1", headline: "S&P futures limit down" }
    expect(engine.requestEventCycle(focus)).toBe("queued")
    expect(engine.requestEventCycle({ ...focus, symbol: "AAPL", rule: "held_negative", trigger_id: "t2" })).toBe("queued")
    const internals = engine as unknown as { eventQueue: { keys(): string[] }; coreQueue: { keys(): string[] } }
    expect(internals.coreQueue.keys()).toEqual(["SPY"])
    expect(internals.eventQueue.keys()).toEqual(["AAPL"])
  })

  it("runs the core review on request only when it can", async () => {
    expect(await command({ type: "core.review" })).toMatchObject({ status: "failed", error: "the core book is off: turn it on in Admin → Settings → Core book, or run a dry run" })
    await command({ type: "settings.update", patch: { core: { enabled: true } }, expected_version: 1 })
    expect(await command({ type: "core.review" })).toMatchObject({ status: "failed", error: "a core review trades, so it runs only while the market is open (a dry run works any time)" })
    // A dry run works with the market closed, but still needs the AI.
    expect(await command({ type: "core.review", dry_run: true })).toMatchObject({ status: "failed", error: "AI is disabled (LLM_URL not set)" })
    expect(await db.col.coreReviews.countDocuments()).toBe(0)
  })

  it("at level auto runs no timed cycles: news triggers and Run now go to the agent, core reviews still go to the core book", async () => {
    expect(await command({ type: "settings.update", patch: { agent: { level: "auto" } }, expected_version: 1 })).toMatchObject({ status: "done" })
    const focus = { symbol: "AAPL", rule: "held_negative", action: "review" as const, severity: 70, polarity: -1 as const, item_ids: ["i1"], trigger_id: "t1", headline: "AAPL sued" }
    expect(engine.requestEventCycle(focus)).toBe("agent")
    expect(engine.requestEventCycle({ ...focus, symbol: "SPY", rule: "core_negative", trigger_id: "t2" })).toMatch(/^(fired|queued)$/)
    const internals = engine as unknown as { eventQueue: { keys(): string[] }; schedule: () => Promise<void> }
    expect(internals.eventQueue.keys()).toEqual([])
    await internals.schedule()
    expect(await db.col.cycles.countDocuments({ _id: { $ne: "interrupted" }, kind: { $ne: "core" } })).toBe(0)
    expect(await command({ type: "cycle.run_now", phase: "postmarket" })).toMatchObject({ status: "failed", error: "the agent needs the model server (LLM_URL)" })
  })

  it("runs a cycle on request (skipped without an AI key) and refuses a second one", async () => {
    expect(await command({ type: "cycle.run_now", phase: "postmarket" })).toMatchObject({ status: "done", result: "postmarket cycle started" })
    await until(async () => (await db.col.cycles.countDocuments({ phase: "postmarket", status: "skipped" })) === 1)
    expect(await db.col.cycles.findOne({ phase: "postmarket" })).toMatchObject({ trigger: "manual", error: "AI is disabled (LLM_URL not set)" })
  })

  it("halts with the kill switch, liquidating when asked, and stays paused after release", async () => {
    const halted = await command({ type: "kill_switch.engage", reason: "test", liquidate: true })
    expect(halted).toMatchObject({ status: "done", result: "halted and liquidated: flattened AAPL (kill switch)" })
    expect(broker.holdings.has("AAPL")).toBe(false)
    expect(engine.status).toBe("halted")
    expect(await command({ type: "resume" })).toMatchObject({ status: "failed", error: "the kill switch is engaged; release it first" })
    expect(await command({ type: "cycle.run_now", phase: "premarket" })).toMatchObject({ status: "failed", error: "engine is halted" })
    expect(await command({ type: "kill_switch.release", confirm: "RELEASE" })).toMatchObject({ status: "done" })
    expect(engine.status).toBe("paused")
  })

  it("closes a stock position for the owner and refuses options closes outside market hours", async () => {
    expect(await command({ type: "position.close", symbol: "AAPL" })).toMatchObject({ status: "done" })
    expect(broker.holdings.has("AAPL")).toBe(false)
    expect(await command({ type: "position.close", symbol: "MSFT" })).toMatchObject({ status: "failed", error: "no MSFT position" })
    expect(await command({ type: "option.close", structure_id: "x" })).toMatchObject({ status: "failed", error: "options can only be closed while the market is open" })
  })

  it("re-syncs with Alpaca on request", async () => {
    expect(await command({ type: "broker.sync" })).toMatchObject({ status: "done", result: "synced: 0 fills on record, 1 positions; website data refresh failed: history unavailable" })
  })

  it("keeps the field order of its status document", async () => {
    await until(async () => (await db.col.engineStatus.findOne({ _id: "engine" })) !== null)
    expect(Object.keys((await db.col.engineStatus.findOne({ _id: "engine" }))!)).toEqual([
      "_id",
      "at",
      "instance",
      "version",
      "started_at",
      "status",
      "cycle_state",
      "current_task",
      "current_phase",
      "kill_switch",
      "ws_clients",
      "event_seq",
      "broker",
      "market",
      "schedule",
      "quotes",
      "ai",
      "system",
      "last_cycle",
      "errors_last_hour",
      "wire",
      "agent",
    ])
  })

  it("runs the agent in shadow by default, and says why it can't answer without the model server", async () => {
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.agent.level).toBe("shadow")
    expect(engine.agent.agent.status()).toMatchObject({ level: "shadow", state: "off", blocked: "no model server (LLM_URL not set)" })
    expect(await command({ type: "agent.ask", question: "What do you hold?" })).toMatchObject({ status: "failed", error: "the agent needs the model server (LLM_URL)" })
  })

  it("words its control results for stocks and options", async () => {
    expect(await command({ type: "pause" })).toMatchObject({ status: "done", result: "paused: no new cycles or entries; stops, targets and options exits stay active" })
    expect(await command({ type: "kill_switch.engage", reason: "test", liquidate: false })).toMatchObject({ status: "done", result: "halted: no new orders; stops, targets and options exits stay active" })
    expect(await command({ type: "kill_switch.release", confirm: "RELEASE" })).toMatchObject({ status: "done", result: "kill switch released; engine paused until you resume" })
    expect(events.filter((e) => e.type === "engine.status").map((e) => e.summary)).toEqual([
      "Engine running: startup complete",
      "Engine paused: paused from the dashboard",
      "Engine halted: test",
      "Engine paused: kill switch released; paused until resumed",
    ])
    expect(await db.col.audit.find({ action: { $in: ["pause", "kill_switch.engage", "kill_switch.release"] } }).sort({ at: 1 }).toArray()).toMatchObject([
      { actor: "owner", action: "pause", target: "engine", details: { status: "paused", pause_reason: null } },
      { actor: "owner", action: "kill_switch.engage", target: "engine", details: { reason: "test", status: "halted" } },
      { actor: "owner", action: "kill_switch.release", target: "engine", details: { status: "paused" } },
    ])
  })

  it("schedules and cancels the one-time seed, and replays news items only if they exist", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString()
    expect(await command({ type: "seed.schedule", amount_usd: 1_234.5678, at })).toMatchObject({ status: "done", result: `one-time seed of $1,234.57 scheduled for ${at}; it runs in the regular session, after the opening buffer` })
    expect(await command({ type: "seed.schedule", amount_usd: 500, at })).toMatchObject({ status: "failed", error: expect.stringContaining("already scheduled") })
    expect(await command({ type: "seed.cancel" })).toMatchObject({ status: "done", result: `seed scheduled for ${at} canceled` })
    expect(await command({ type: "seed.cancel" })).toMatchObject({ status: "failed", error: "no scheduled seed to cancel" })
    expect(await command({ type: "wire.replay", item_id: "missing-item" })).toMatchObject({ status: "failed", error: "no wire item with that id" })
  })
})
