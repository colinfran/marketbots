import type { SeedRunDoc } from "@mb/stock-core/db"
import type { BotReport } from "@mb/stock-core/report"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AiRunner, ResearchResult } from "../../src/ai/runner"
import type { EngineContext } from "../../src/bot/context"
import { runCycle } from "../../src/bot/cycle"
import { normalizeSeedDecisions, seedExits } from "../../src/bot/seed"
import type { EventBus } from "../../src/bus/event-bus"
import { seedDeadline } from "../../src/engine"
import { cancelSeed, claimDueSeed, failInterruptedSeeds, failMissedSeeds, scheduleSeed } from "../../src/state/seed-runs"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { afterOpen, DAY, decision, report, session } from "../helpers/factories"
import { settle, useFakeClock } from "../helpers/timers"

const db = useTestDb()

describe("seed runs", () => {
  const NOW = new Date("2026-10-27T13:00:00Z")
  const AT = "2026-10-27T13:45:00Z"

  it("schedules one run at a time and refuses a second seed after one is done unless forced", async () => {
    const run = await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    expect(run).toMatchObject({ status: "scheduled", amount_usd: 2_000, force: false })
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)).rejects.toThrow(/already scheduled/)
    await db.col.seedRuns.updateOne({ _id: run._id }, { $set: { status: "done", done_at: NOW } })
    await expect(scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)).rejects.toThrow(/already ran/)
    await expect(scheduleSeed(db.col, { amount_usd: 1_000, at: AT, force: true }, "owner", NOW)).resolves.toMatchObject({ force: true })
  })

  it("claims once, cancels, and fails interrupted runs", async () => {
    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    const due = new Date("2026-10-27T13:46:00Z")
    expect(await claimDueSeed(db.col, NOW)).toBeNull()
    expect(await claimDueSeed(db.col, due)).toMatchObject({ status: "running" })
    expect(await claimDueSeed(db.col, due)).toBeNull()
    expect(await failInterruptedSeeds(db.col, due)).toBe(1)
    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    await expect(cancelSeed(db.col)).resolves.toMatchObject({ status: "canceled" })
  })

  it("counts a seed as missed once its own session reaches the closing window", async () => {
    const today = session({ day: "2026-10-27", open: new Date("2026-10-27T13:30:00Z"), close: new Date("2026-10-27T20:00:00Z") })
    const deadline = seedDeadline(today, 25)
    const run = (at: string) => ({ at: new Date(at) }) as SeedRunDoc
    expect(deadline(run("2026-10-27T13:45:00Z"))).toEqual(new Date("2026-10-27T19:35:00Z"))
    expect(deadline(run("2026-10-26T13:45:00Z"))).toEqual(new Date("2026-10-26T13:45:00Z"))
    expect(deadline(run("2026-10-28T13:45:00Z")).getTime()).toBeGreaterThan(Date.now())
    const holiday = seedDeadline(session({ day: "2026-10-27", is_trading_day: false, open: null, close: null }), 25)
    expect(holiday(run("2026-10-27T13:45:00Z"))).toEqual(new Date("2026-10-27T13:45:00Z"))

    await scheduleSeed(db.col, { amount_usd: 2_000, at: AT }, "owner", NOW)
    expect(await failMissedSeeds(db.col, deadline, new Date("2026-10-27T15:00:00Z"))).toHaveLength(0)
    expect(await failMissedSeeds(db.col, deadline, new Date("2026-10-27T19:40:00Z"))).toHaveLength(1)
  })
})

describe("seed rules", () => {
  it("keeps up to three new buys, forces multi_day, and caps the total at the amount + 5%", () => {
    const { decisions, notes } = normalizeSeedDecisions(
      [
        decision({ symbol: "SPY", allocation_pct: 18 }),
        decision({ symbol: "QQQ", allocation_pct: 12 }),
        decision({ symbol: "AAPL", action: "hold", allocation_pct: null }),
        decision({ symbol: "MSFT", allocation_pct: 5 }),
        decision({ symbol: "NVDA", allocation_pct: 5 }),
        decision({ symbol: "TSLA", allocation_pct: 5 }),
      ],
      { held: new Set(["MSFT"]), equity: 10_000, amountUsd: 2_000 },
    )
    expect(decisions.map((d) => d.symbol)).toEqual(["SPY", "QQQ", "NVDA"])
    expect(decisions.every((d) => d.horizon === "multi_day")).toBe(true)
    const total = decisions.reduce((s, d) => s + (d.allocation_pct ?? 0), 0)
    expect(total).toBeLessThanOrEqual(21)
    expect(total).toBeGreaterThan(20.9)
    expect(notes.join(" ")).toMatch(/AAPL.*dropped.*MSFT: already held.*TSLA: more than 3/)
  })

  it("gives core holds a stop inside the range and a far target", () => {
    const risk = { min_stop_pct: 0.4, max_stop_pct: 8, min_reward_risk: 1.2 }
    expect(seedExits({ symbol: "SPY", stop_loss: 540, take_profit: 680 }, 580, risk)).toMatchObject({ stop_loss: 540, take_profit: 680, notes: [] })
    const repaired = seedExits({ symbol: "SPY", stop_loss: 578, take_profit: 585 }, 580, risk)
    expect(repaired.stop_loss).toBeCloseTo(536.5, 1)
    expect(repaired.take_profit).toBeCloseTo(580 + 2.5 * (580 - repaired.stop_loss), 1)
  })
})

describe("seed cycle", () => {
  let broker: FakeBroker
  let ctx: EngineContext
  let bus: EventBus

  const ai = (output: BotReport) => {
    const research = vi.fn(
      async (opts: Parameters<AiRunner["research"]>[0]): Promise<ResearchResult> => ({
        memo: "## 1. Tape & macro\n- calm",
        sources: [],
        queries: [],
        model: opts.model,
        x_search: true,
        duration_ms: 1,
        usage: { input: 1, output: 1, total: 2 },
        cost_usd: 0.05,
        error: null,
      }),
    )
    const structured = vi.fn(async (opts: Parameters<AiRunner["structured"]>[0]) => ({ output, attempts: 1, repaired: false, model: opts.model, cost_usd: 0.02, usage: { input: 1, output: 1, total: 2 } }))
    ctx.ai = { available: true, research, structured } as unknown as AiRunner
    return { research, structured }
  }
  const seedRun = () => settle(runCycle(ctx, { phase: "intraday", session: session(), trigger: "seed", kind: "seed", seed: { id: "seed-1", amountUsd: 2_000 } }))

  beforeEach(async () => {
    useFakeClock(afterOpen(15))
    broker = fakeBroker()
    broker.calendar = [{ date: DAY, open: "09:30", close: "16:00" }]
    for (const [s, p] of Object.entries({ SPY: 580, QQQ: 500, AAPL: 100 })) broker.setPrice(s, p)
    ;({ ctx, bus } = await makeCtx(db.col, broker))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await bus.stop()
  })

  it("buys only the core holdings, within the amount, through executeDecisions (plans written)", async () => {
    broker.setPosition("AAPL", 10, 100)
    const { research, structured } = ai(
      report({
        summary: "SPY as the core holding.",
        decisions: [
          decision({ symbol: "SPY", allocation_pct: 30, conviction: 8, horizon: "intraday", stop_loss: 537, take_profit: 680 }),
          decision({ symbol: "AAPL", action: "sell", allocation_pct: null, sell_pct: 100 }),
        ],
      }),
    )
    const r = await seedRun()
    expect(r.status).toBe("succeeded")
    expect(research.mock.calls[0][0].prompt).toMatch(/ONE-TIME SEED/)
    expect(structured.mock.calls[0][0].prompt).toMatch(/# ONE-TIME SEED/)
    expect(r.seed?.executed).toBe(1)
    expect(r.seed?.notes.join(" ")).toMatch(/AAPL: "sell" dropped/)
    // 30% asked, capped at the amount + 5% (21% of $10,000), then at max_position_pct (20%): 3 shares of SPY at $580.
    const spy = await db.col.decisions.findOne({ symbol: "SPY" })
    expect(spy).toMatchObject({ trigger_kind: "seed", status: "executed", qty: 3 })
    expect(spy!.notional!).toBeLessThanOrEqual(2_100)
    expect(await db.col.plans.findOne({ _id: "SPY" })).toMatchObject({ horizon: "multi_day", stop_loss: 537, take_profit: 680 })
    expect(broker.holdings.get("AAPL")).toMatchObject({ qty: 10 })
    expect(await db.col.cycles.findOne({ _id: r.cycleId })).toMatchObject({ kind: "seed" })
  })

  it("lets the normal risk checks reject a low-conviction seed buy", async () => {
    ai(report({ decisions: [decision({ symbol: "SPY", allocation_pct: 20, conviction: 4 })] }))
    const r = await seedRun()
    expect(r.seed?.executed).toBe(0)
    expect(r.seed?.orders).toEqual([expect.objectContaining({ symbol: "SPY", status: "rejected", reason: expect.stringContaining("conviction") })])
    expect(broker.holdings.has("SPY")).toBe(false)
  })
})
