import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { silentLogger } from "@mb/engine-kit/log"
import type { Wire } from "../src/wire/wire"
import { randomUUID } from "node:crypto"
import type { Command } from "@mb/stock-core/commands"
import type { CommandDoc, StreamHealth } from "@mb/stock-core/db"
import type { EngineEvent } from "@mb/stock-core/events"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { marketDay } from "@mb/stock-core/time"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Alerts } from "../src/alerts"
import type { MarketStream } from "../src/alpaca/market-stream"
import type { TradeStream } from "../src/alpaca/trade-stream"
import type { EventBus } from "../src/bus/event-bus"
import type { Database } from "../src/db/mongo"
import type { Session } from "../src/bot/session"
import { Engine } from "../src/engine"
import { loadEnv } from "../src/env"
import { LivePrices } from "../src/market/prices"
import { EngineStateStore, loadSettings } from "../src/state/stores"
import type { StreamServer } from "../src/stream/server"
import { fakeBroker, type FakeBroker } from "./helpers/broker"
import { makeBus } from "./helpers/ctx"
import { useTestDb } from "./helpers/db"

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
    expect(await db.col.cache.findOne({ _id: "alpaca:account" })).not.toBeNull()
    // What it holds, then the index ETFs, then the rest of the watchlist: the benchmarks.
    expect(symbols[0]).toEqual(["AAPL", ...DEFAULT_SETTINGS.universe.benchmarks])
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

  it("watches what it holds, the agent's watches and the benchmarks; the agent's watches are the news engine's focus", async () => {
    vi.spyOn(engine.agent.agent, "watchedSymbols").mockReturnValue(["NVDA"])
    const benchmarks = DEFAULT_SETTINGS.universe.benchmarks
    expect(engine.wireSymbols()).toEqual({ universe: [...benchmarks, "AAPL", "NVDA"], held: ["AAPL"], focus: ["NVDA"] })
    const internals = engine as unknown as { streamSymbols: () => string[] }
    expect(internals.streamSymbols()).toEqual(["AAPL", "SPY", "QQQ", "NVDA", ...benchmarks.filter((s) => s !== "SPY" && s !== "QQQ")])
  })

  it("refuses core reviews: the core book is gone", async () => {
    expect(await command({ type: "core.review" })).toMatchObject({ status: "failed", error: "the core book is gone: the agent decides" })
    expect(await command({ type: "core.review", dry_run: true })).toMatchObject({ status: "failed", error: "the core book is gone: the agent decides" })
    expect(await db.col.coreReviews.countDocuments()).toBe(0)
  })

  it("runs no timed cycles: Wake the agent goes to the agent", async () => {
    await until(async () => (await db.col.engineStatus.findOne({ _id: "engine" })) !== null)
    expect(await db.col.engineStatus.findOne({ _id: "engine" })).toMatchObject({ current_phase: null, schedule: { phase: null, reason: "The agent decides: no timed cycles." }, last_cycle: null })
    expect(await command({ type: "cycle.run_now", phase: "postmarket" })).toMatchObject({ status: "failed", error: "the agent needs the model server (LLM_URL)" })
    expect(await db.col.cycles.countDocuments()).toBe(0)
  })

  it("turns an earlier breaker's drop to shadow into a pause on entries, which the owner lifts", async () => {
    const internals = engine as unknown as { upgradeDemotion: () => Promise<void>; d: { state: EngineStateStore } }
    const reason = "daily loss: the shadow book is down -3.10% today"
    expect(await command({ type: "settings.update", patch: { agent: { level: "off" } }, expected_version: 1 })).toMatchObject({ status: "done" })
    await internals.d.state.update({ agent_demotion: { at: new Date(), reason } }, "test", "test")
    await internals.upgradeDemotion()
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.agent.level).toBe("on")
    expect(await db.col.engineState.findOne({ _id: "engine" })).toMatchObject({ agent_pause: { reason }, agent_demotion: null })
    expect(await db.col.audit.findOne({ action: "agent.entries_paused" })).toMatchObject({ actor: "engine:migration" })
    expect(engine.agent.agent.entriesPaused()).toBe(`entries paused by a breaker until the owner resumes them: ${reason}`)
    expect(await command({ type: "agent.resume_entries" })).toMatchObject({ status: "done", result: expect.stringMatching(/^the agent's entries resumed/) })
    expect(await db.col.engineState.findOne({ _id: "engine" })).toMatchObject({ agent_pause: null })
    expect(engine.agent.agent.entriesPaused()).toBeNull()
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

  it("runs the agent by default, and says why it can't answer without the model server", async () => {
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.agent.level).toBe("on")
    expect(engine.agent.agent.status()).toMatchObject({ level: "on", state: "off", blocked: "no model server (LLM_URL not set)", pause: null })
    expect(await command({ type: "agent.ask", question: "What do you hold?" })).toMatchObject({ status: "failed", error: "the agent needs the model server (LLM_URL)" })
  })

  it("writes the day's record once, after the close", async () => {
    const internals = engine as unknown as { recordDay: (s: Session, now: Date) => Promise<void> }
    const close = new Date("2026-10-26T20:00:00Z")
    const session: Session = { day: "2026-10-26", is_trading_day: true, open: new Date("2026-10-26T13:30:00Z"), close, open_et: "09:30", close_et: "16:00", early_close: false }
    await internals.recordDay(session, new Date(close.getTime() - 60_000))
    expect(await db.col.dailyStats.countDocuments({ _id: "2026-10-26" })).toBe(0)
    await internals.recordDay(session, new Date(close.getTime() + 2 * 3_600_000))
    expect(await db.col.dailyStats.findOne({ _id: "2026-10-26" })).toMatchObject({ trading_day: "2026-10-26" })
    expect(events.filter((e) => e.type === "daily.stats")).toHaveLength(1)
    await internals.recordDay(session, new Date(close.getTime() + 3 * 3_600_000))
    expect(events.filter((e) => e.type === "daily.stats")).toHaveLength(1)
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
