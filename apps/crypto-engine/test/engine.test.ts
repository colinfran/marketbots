import { randomUUID } from "node:crypto"
import { STATUS_DETAIL_ID } from "@mb/core/db"
import type { Command } from "@mb/crypto-core/commands"
import { utcDay, type CommandDoc } from "@mb/crypto-core/db"
import type { EngineEvent } from "@mb/crypto-core/events"
import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import type { CommandView } from "@mb/engine-kit/commands"
import { createLogger, silentLogger } from "@mb/engine-kit/log"
import type { CommandIntake } from "@mb/engine-kit/stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
let lines: Record<string, unknown>[]

// Generous: the engine checks its queue every 3 seconds, and on the busy trading server (backfills,
// the GPU) a pass can take several. A real failure still times out.
const until = async (check: () => Promise<boolean> | boolean, ms = 15_000) => {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Where the engine hands its commands to the stream server's endpoints. */
let intake: CommandIntake | null = null

const FINAL = ["done", "failed", "rejected"]

/** Sends a command like the dashboard does (straight to the engine) and waits for its answer. */
const command = async (c: Command): Promise<CommandView> => {
  const id = randomUUID()
  const sent = intake!.submit(id, c, "owner")
  if (!sent.ok) throw new Error(sent.error)
  await until(() => FINAL.includes(intake!.status(id)?.status ?? ""))
  return intake!.status(id)!
}

/** Queues a command in the database (the dashboard couldn't reach the engine) and waits for the engine to answer it. */
const queued = async (c: Command): Promise<CommandDoc> => {
  const id = randomUUID()
  await db.col.commands.insertOne({ _id: id, type: c.type, command: c, status: "pending", created_at: new Date(), created_by: "owner", processed_at: null, result: null, error: null })
  await until(async () => FINAL.includes((await db.col.commands.findOne({ _id: id }))!.status))
  return (await db.col.commands.findOne({ _id: id }))!
}


type Internals = {
  /** At startup: an earlier breaker's drop to the old shadow level becomes a pause on entries. */
  upgradeDemotion: () => Promise<void>
}
const internals = () => engine as unknown as Internals

beforeEach(async () => {
  bus = await makeBus(db.col)
  events = []
  lines = []
  bus.subscribe((e) => events.push(e))
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
    calls,
    alerts: new Alerts(db.col, bus, silentLogger, null, null),
    stream: { clientCount: 0, setCommands: (i: CommandIntake) => (intake = i) } as unknown as StreamServer,
    // The news engine is covered by its own tests; here it only has to be present and inert.
    wire: {
      start: async () => undefined,
      stop: () => undefined,
      reconcile: () => undefined,
      onItem: () => undefined,
      markNotable: async () => [],
      healthy: () => false,
      health: () => ({ mode: "live", sources: [], items_last_hour: 0, triggers_today: 0 }),
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
      "ai",
      "system",
      "reconciliation",
      "errors_last_hour",
      "agent",
    ])
    // The large sections, apart (written once a minute).
    expect(Object.keys((await db.col.engineStatus.findOne({ _id: STATUS_DETAIL_ID as never }))!)).toEqual(["_id", "at", "symbols", "wire"])
    expect(engine.ready).toBe(true)
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["engine.started", "engine.status", "alert"]))
  })

  it("runs the agent by default, and says why it can't answer without the model server", async () => {
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.agent.level).toBe("on")
    expect(engine.agent.agent.status()).toMatchObject({ level: "on", state: "off", blocked: "no model server (LLM_URL not set)", pause: null })
    expect(await command({ type: "agent.ask", question: "What do you hold?" })).toMatchObject({ status: "failed", error: "the agent needs the model server (LLM_URL)" })
  })

  it("runs no timed cycles: Wake the agent goes to the agent", async () => {
    expect(await command({ type: "agent.review", symbols: ["BTC/USD"] })).toMatchObject({ status: "failed", error: "the agent needs the model server (LLM_URL)" })
    await until(async () => (await db.col.engineStatus.findOne({ _id: "engine" }))?.agent?.level === "on")
    expect(await db.col.engineStatus.findOne({ _id: "engine" })).not.toHaveProperty("next_cycle_at")
  })

  it("turns an earlier breaker's drop to shadow into a pause on entries, which the owner lifts", async () => {
    const reason = "daily loss: the shadow book is down -3.01% today"
    expect(await command({ type: "settings.update", patch: { agent: { level: "off" } }, expected_version: 1 })).toMatchObject({ status: "done" })
    await (engine as unknown as { d: { state: EngineStateStore } }).d.state.update({ agent_demotion: { at: new Date(), reason } }, "test", "test")
    await internals().upgradeDemotion()
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.agent.level).toBe("on")
    expect(await db.col.engineState.findOne({ _id: "engine" })).toMatchObject({ agent_pause: { reason }, agent_demotion: null })
    expect(await db.col.audit.findOne({ action: "agent.entries_paused" })).toMatchObject({ actor: "engine:migration" })
    expect(engine.agent.agent.entriesPaused()).toBe(`entries paused by a breaker until the owner resumes them: ${reason}`)

    expect(await command({ type: "agent.resume_entries" })).toMatchObject({ status: "done", result: expect.stringMatching(/^the agent's entries resumed/) })
    expect(await db.col.engineState.findOne({ _id: "engine" })).toMatchObject({ agent_pause: null, agent_promotion: { equity_usd: expect.any(Number) } })
    expect(engine.agent.agent.entriesPaused()).toBeNull()
    expect(await command({ type: "agent.resume_entries" })).toMatchObject({ status: "failed", error: "the agent's entries aren't paused" })
  })

  it("pauses, resumes and applies settings from audited commands", async () => {
    expect(await command({ type: "pause", reason: "lunch" })).toMatchObject({ status: "done", result: "paused: no new decisions or entries; stops and targets stay active" })
    expect(engine.status).toBe("paused")
    // In effect at once, saved just after.
    await until(async () => (await db.col.engineState.findOne({ _id: "engine" }))?.status === "paused")
    expect(await db.col.engineState.findOne({ _id: "engine" })).toMatchObject({ status: "paused", pause_reason: "lunch" })
    expect(await command({ type: "resume" })).toMatchObject({ status: "done", result: "running" })
    expect(engine.status).toBe("running")
    const updated = await command({ type: "settings.update", patch: { schedule: { trigger_move_atr: 2 } }, expected_version: 1 })
    expect(updated).toMatchObject({ status: "done", result: "1 setting updated (v2)" })
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings.schedule.trigger_move_atr).toBe(2)
    expect(await command({ type: "settings.update", patch: { schedule: { trigger_move_atr: 2.5 } }, expected_version: 1 })).toMatchObject({ status: "failed", error: expect.stringContaining("reload and retry") })
    expect(await command({ type: "strategy.set_enabled", strategy: "trend", enabled: false })).toMatchObject({ status: "done", result: "trend disabled" })
    expect(await db.col.audit.countDocuments({ action: "settings.update" })).toBe(2)
    expect(events.filter((e) => e.type === "engine.status").map((e) => e.summary)).toEqual(["Engine running: startup complete", "Engine paused: lunch", "Engine running: resumed from the dashboard"])
  })

  it("halts with the kill switch and stays paused after release", async () => {
    expect(await command({ type: "kill_switch.engage", reason: "test", liquidate: false })).toMatchObject({ status: "done", result: "halted: no new orders; stops and targets stay active" })
    expect(engine.status).toBe("halted")
    expect(await command({ type: "resume" })).toMatchObject({ status: "failed", error: "the kill switch is engaged; release it first" })
    expect(await command({ type: "agent.review" })).toMatchObject({ status: "failed", error: "engine is halted" })
    expect(await command({ type: "kill_switch.release", confirm: "RELEASE" })).toMatchObject({ status: "done", result: "kill switch released; engine paused until you resume" })
    expect(engine.status).toBe("paused")
    expect(await command({ type: "kill_switch.engage", reason: "again", liquidate: true })).toMatchObject({ status: "done", result: "halted and liquidated: no positions" })
    expect(await db.col.notifications.countDocuments({ title: "Kill switch engaged" })).toBe(2)
  })

  it("replays news items only if they exist", async () => {
    expect(await command({ type: "wire.replay", item_id: "missing-item" })).toMatchObject({ status: "failed", error: "no wire item with that id" })
  })

  it("runs a command the dashboard queued in the database because it couldn't reach the engine", async () => {
    expect(await queued({ type: "pause", reason: "queued" })).toMatchObject({ status: "done", result: "paused: no new decisions or entries; stops and targets stay active" })
    expect(engine.status).toBe("paused")
  })
})
