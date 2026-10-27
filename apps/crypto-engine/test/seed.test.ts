import { normalizeSeedAllocation, seedAllocationSchema, type SeedAllocationReport } from "@mb/crypto-core/report"
import { DEFAULT_SETTINGS, type Settings } from "@mb/crypto-core/settings"
import { describe, expect, it, vi } from "vitest"
import type { AiBudget } from "../src/ai/budget"
import { repairSeedAllocation } from "../src/ai/repair"
import type { AiRunner } from "../src/ai/runner"
import type { Alerts } from "../src/alerts"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import { silentLogger } from "../src/log"
import type { CandleCache } from "../src/market/candles"
import type { MarketHub } from "../src/market/hub"
import type { EngineContext } from "../src/orchestrator/context"
import { runCryptoCycle } from "../src/orchestrator/crypto-cycle"
import { Ledger } from "../src/portfolio/ledger"
import { cancelSeed, claimDueSeed, failInterruptedSeeds, failMissedSeeds, scheduleSeed } from "../src/state/seed-runs"
import type { EngineStateStore, SettingsStore } from "../src/state/stores"
import { useTestDb } from "./helpers/db"
import { candles, fakeHub, FakeWallet, makeBus } from "./helpers/fakes"

const db = useTestDb()
const NOW = new Date("2026-10-27T13:00:00Z")
const AT = "2026-10-27T13:45:00Z"

describe("seed runs", () => {
  it("schedules one run at a time and refuses a second seed after one is done unless forced", async () => {
    const run = await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    expect(run).toMatchObject({ status: "scheduled", amount_usd: 2_000, force: false })
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)).rejects.toThrow(/already scheduled/)

    await db.col.seedRuns.updateOne({ _id: run._id }, { $set: { status: "done", done_at: NOW } })
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)).rejects.toThrow(/already ran/)
    await expect(scheduleSeed(db.col, { amount_usd: 1_000, at: AT, force: true }, "owner", NOW)).resolves.toMatchObject({ status: "scheduled", force: true })
  })

  it("rejects times in the past or too far ahead", async () => {
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: "2026-10-27T12:00:00Z" }, "owner", NOW)).rejects.toThrow(/in the past/)
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: "2027-03-01T12:00:00Z" }, "owner", NOW)).rejects.toThrow(/days away/)
  })

  it("claims a due run exactly once, cancels, and fails missed and interrupted runs", async () => {
    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    expect(await claimDueSeed(db.col, NOW)).toBeNull()
    const due = new Date("2026-10-27T13:46:00Z")
    expect(await claimDueSeed(db.col, due)).toMatchObject({ status: "running" })
    expect(await claimDueSeed(db.col, due)).toBeNull()
    expect(await failInterruptedSeeds(db.col, due)).toBe(1)
    expect(await db.col.seedRuns.findOne({})).toMatchObject({ status: "failed", error: expect.stringContaining("restarted") })

    await db.col.seedRuns.deleteMany({})
    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    await expect(cancelSeed(db.col)).resolves.toMatchObject({ status: "canceled" })
    await expect(cancelSeed(db.col)).rejects.toThrow(/no scheduled seed/)

    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    const deadline = (r: { at: Date }) => new Date(r.at.getTime() + 120 * 60_000)
    expect(await failMissedSeeds(db.col, deadline, new Date("2026-10-27T14:00:00Z"))).toHaveLength(0)
    const missed = await failMissedSeeds(db.col, deadline, new Date("2026-10-27T16:00:00Z"))
    expect(missed).toHaveLength(1)
    expect(missed[0].error).toMatch(/missed/)
  })
})

const allocation = (overrides: Partial<SeedAllocationReport["allocations"][number]> = {}): SeedAllocationReport["allocations"][number] => ({
  symbol: "BTC/USD",
  weight_pct: 60,
  conviction: 70,
  thesis: "Core holding with ETF inflows.",
  invalidation: "Weekly close below the 200-day.",
  stop_loss: null,
  take_profit: null,
  horizon_hours: 2_160,
  ...overrides,
})

describe("seed allocation", () => {
  it("keeps listed pairs only, bounds numbers, and scales weights above 100%", () => {
    const n = normalizeSeedAllocation(
      {
        allocations: [allocation({ weight_pct: 90 }), allocation({ weight_pct: 50 }), allocation({ symbol: "eth/usd", weight_pct: 60, horizon_hours: 24 }), allocation({ symbol: "PEPE/USD" }), allocation({ symbol: "SOL/USD", weight_pct: 0 })],
        rationale: "Mostly BTC.",
      },
      { candidates: new Set(["BTC/USD", "ETH/USD", "SOL/USD"]) },
    )
    expect(n.allocations.map((a) => a.symbol)).toEqual(["BTC/USD", "ETH/USD"])
    expect(n.allocations.map((a) => a.weight_pct)).toEqual([60, 40])
    expect(n.allocations[1].horizon_hours).toBe(168)
    expect(n.notes.join(" ")).toMatch(/PEPE\/USD is not a seed candidate/)
  })

  it("repairs near-miss output", () => {
    const raw = { allocations: [{ ...allocation(), weight_pct: "55%", conviction: "70", stop_loss: "$60,000" }], rationale: "ok" }
    const repaired = repairSeedAllocation("```json\n" + JSON.stringify(raw) + "\n```")
    expect(repaired?.report.allocations[0]).toMatchObject({ weight_pct: 55, conviction: 70, stop_loss: 60_000 })
    expect(seedAllocationSchema.safeParse(repaired?.report).success).toBe(true)
  })
})

describe("seed cycle", () => {
  const setup = async (output: SeedAllocationReport) => {
    const bus = await makeBus(db.col)
    const ledger = new Ledger(db.col, bus)
    await ledger.ensureAccount(10_000)
    const hub = { ...fakeHub(), features: new Map() } as unknown as MarketHub
    const wallet = new FakeWallet()
    const executor = new Executor(db.col, ledger, new PaperWalletExecution(wallet.cli(), hub), bus, silentLogger)
    // A steady uptrend ending near the live price, long enough for every daily indicator.
    const path = (n: number) => Array.from({ length: n }, (_, i) => 50_000 + (15_000 * i) / (n - 1))
    const candleCache = { get: async (_s: string, interval: number) => candles(path(250), interval * 60_000, Date.now() - 250 * interval * 60_000) } as unknown as CandleCache
    const settings: Settings = { ...DEFAULT_SETTINGS, universe: { kraken_symbols: ["BTC/USD"] } }
    const structured = vi.fn(async () => ({ output, attempts: 1, repaired: false, model: "test/decision", cost_usd: 0.05, usage: { input: 1, output: 1, total: 2 } }))
    const research = vi.fn(async () => ({ memo: "## Macro & flows\nCalm.", sources: [], queries: [], model: "test/research", x_search: true, duration_ms: 5, usage: { input: 1, output: 1, total: 2 }, cost_usd: 0.1, error: null }))
    const alerts = { send: vi.fn(async () => undefined), success: vi.fn(async () => undefined) }
    const ctx: EngineContext = {
      col: db.col,
      log: silentLogger,
      bus,
      settings: { current: settings, version: 1 } as unknown as SettingsStore,
      state: { state: { status: "running", kill_switch: { engaged: false } } } as unknown as EngineStateStore,
      hub,
      candles: candleCache,
      ledger,
      executor,
      ai: { available: true, research, structured } as unknown as AiRunner,
      budget: { estimate: async () => 0.1, canAfford: async () => ({ ok: true, status: { day: "", spent_usd: 0, budget_usd: 5, remaining_usd: 5, calls: 0 } }) } as unknown as AiBudget,
      alerts: alerts as unknown as Alerts,
      gate: () => ({ runStatus: "running", killSwitch: false, venueOnline: true, reconciled: true }),
      feeBps: () => 40,
      setCycleState: () => undefined,
      signal: new AbortController().signal,
    }
    return { ctx, structured, research, alerts }
  }

  it("turns the AI allocation into sized, owner-directed daily_trend buys", async () => {
    // Conviction 10 is far below min_conviction (55): owner-directed buys skip that gate.
    const { ctx, research } = await setup({ allocations: [allocation({ weight_pct: 75, conviction: 10 }), allocation({ symbol: "DOGE/USD", weight_pct: 25 })], rationale: "BTC only today." })
    const r = await runCryptoCycle(ctx, { kind: "seed", trigger: "seed", seed: { id: "seed-1", amountUsd: 2_000 } })
    expect(r.status).toBe("completed")
    expect(research).toHaveBeenCalledOnce()
    expect(r.seed?.allocations).toEqual([expect.objectContaining({ symbol: "BTC/USD", weight_pct: 75, notional_usd: 1_500 })])
    expect(r.seed?.notes.join(" ")).toMatch(/DOGE\/USD is not a seed candidate/)
    expect(r.seed?.executed).toBe(1)

    const decision = await db.col.decisions.findOne({ symbol: "BTC/USD" })
    expect(decision).toMatchObject({ trigger_kind: "seed", strategy_id: "daily_trend", action: "buy", execution: { status: "filled" } })
    expect(decision!.risk!.checks.map((c) => c.name)).toContain("owner_directed")
    expect(decision!.sizing.notional_usd).toBeCloseTo(1_500, 0)
    const position = await db.col.positions.findOne({ symbol: "BTC/USD", status: "open" })
    expect(position).toMatchObject({ strategy_id: "daily_trend", horizon_hours: 2_160 })
    expect(position!.stop_price).toBeLessThan(65_000)
    const cycle = await db.col.cycles.findOne({ _id: r.cycleId })
    expect(cycle).toMatchObject({ kind: "seed", status: "completed" })
  })

  it("buys nothing when entries are blocked, and nothing it can't afford", async () => {
    const { ctx, structured } = await setup({ allocations: [allocation({ weight_pct: 100 })], rationale: "x" })
    const blocked = await runCryptoCycle({ ...ctx, gate: () => ({ runStatus: "running", killSwitch: true, venueOnline: true, reconciled: true }) }, { kind: "seed", trigger: "seed", seed: { id: "s", amountUsd: 2_000 } })
    expect(blocked).toMatchObject({ status: "skipped", summary: expect.stringContaining("kill switch") })
    expect(structured).not.toHaveBeenCalled()
    expect(await db.col.positions.countDocuments({})).toBe(0)
  })
})
