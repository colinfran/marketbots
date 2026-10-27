import { settle, useFakeClock } from "@mb/engine-kit/testing/timers"
import type { CycleDoc } from "@mb/stock-core/db"
import type { EngineEvent } from "@mb/stock-core/events"
import type { BotReport } from "@mb/stock-core/report"
import type { Phase } from "@mb/stock-core/settings"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AiRunner, ResearchResult } from "@mb/engine-kit/ai/runner"
import type { EngineContext } from "../../src/bot/context"
import { runCycle } from "../../src/bot/cycle"
import type { EventBus } from "../../src/bus/event-bus"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx, type SentAlert } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { afterOpen, alpacaOrder, DAY, decision, planDoc, report, session } from "../helpers/factories"

const NOW = afterOpen(90) // Monday 11:00 ET
const db = useTestDb()
let broker: FakeBroker
let ctx: EngineContext
let bus: EventBus
let events: EngineEvent[]
let alerts: SentAlert[]

type Script = { memo?: string; researchError?: string; decision?: BotReport; decisionError?: Error }

/** A stand-in AI runner: research streams one query, one source and memo progress; the decision streams a partial report. */
const fakeAi = ({ memo = "## 1. Tape & macro\n- SPY +0.3% (10:55 ET, https://reuters.com/x)", researchError, decision: output = report(), decisionError }: Script = {}) => {
  const research = vi.fn(async (opts: Parameters<AiRunner["research"]>[0]): Promise<ResearchResult> => {
    opts.progress?.onQuery?.("spy today", "web_search")
    opts.progress?.onSource?.({ title: "Reuters", url: "https://reuters.com/x", domain: "reuters.com" })
    opts.progress?.onText?.(120, "SPY +0.3%")
    opts.progress?.onReasoning?.(40, "Tape looks firm.")
    return {
      memo: researchError ? "" : memo,
      sources: researchError ? [] : [{ title: "Reuters", url: "https://reuters.com/x", domain: "reuters.com" }],
      queries: researchError ? [] : ["spy today"],
      model: opts.model,
      x_search: true,
      duration_ms: 1_000,
      usage: { input: 100, output: 50, total: 150 },
      cost_usd: 0.05,
      error: researchError ?? null,
    }
  })
  const structured = vi.fn(async (opts: Parameters<AiRunner["structured"]>[0]) => {
    if (decisionError) throw decisionError
    opts.progress?.onPartial?.(500, { headline: output.headline, decisions: output.decisions })
    return { output, attempts: 1, repaired: false, model: opts.model, cost_usd: 0.02, usage: { input: 100, output: 50, total: 150 } }
  })
  ctx.ai = { available: true, research, structured } as unknown as AiRunner
  return { research, structured }
}

const run = (phase: Phase, extra: Partial<Parameters<typeof runCycle>[1]> = {}) => settle(runCycle(ctx, { phase, session: session(), trigger: "schedule", ...extra }))
const cycleOf = async (id: string) => (await db.col.cycles.findOne({ _id: id })) as CycleDoc
const types = () => events.filter((e) => e.type !== "cycle.state").map((e) => e.type)

beforeEach(async () => {
  useFakeClock(NOW)
  broker = fakeBroker()
  broker.calendar = [{ date: DAY, open: "09:30", close: "16:00" }]
  for (const [s, p] of Object.entries({ SPY: 580, QQQ: 500, AAPL: 100 })) broker.setPrice(s, p)
  ;({ ctx, bus, events, alerts } = await makeCtx(db.col, broker))
})

afterEach(async () => {
  vi.useRealTimers()
  await bus.stop()
})

describe("a cycle", () => {
  it("gathers data, researches, decides, executes, protects and saves the report", async () => {
    fakeAi({ decision: report({ headline: "Buying AAPL", decisions: [decision({ symbol: "AAPL", allocation_pct: 10, stop_loss: 97, take_profit: 106 })] }) })
    const result = await run("intraday")
    expect(result).toMatchObject({ phase: "intraday", status: "succeeded", headline: "Buying AAPL" })

    const cycle = await cycleOf(result.cycleId)
    expect(cycle).toMatchObject({ status: "succeeded", trigger: "schedule", trading_day: DAY, report_id: expect.any(String), finished_at: NOW, error: null, ai_cost_usd: 0.07 })
    expect(cycle.steps.map((s) => [s.name, s.ok])).toEqual([
      ["context", true],
      ["research", true],
      ["decision", true],
      ["execution", true],
      ["protection", true],
    ])
    expect(cycle.steps[0].detail).toBe("0 stock positions, 0 options positions, 0 instruments, 0 headlines")

    const saved = (await db.col.reports.findOne({ _id: cycle.report_id! }))!
    expect(saved).toMatchObject({
      cycle_id: result.cycleId,
      phase: "intraday",
      research: { memo: expect.stringContaining("SPY +0.3%"), error: null, queries: ["spy today"], cost_usd: 0.05 },
      report: { headline: "Buying AAPL" },
      execution: { executed: 1, rejected: 0, failed: 0, noop: 0 },
      cost_usd: 0.07,
    })
    expect(await db.col.decisions.find().toArray()).toEqual([expect.objectContaining({ cycle_id: result.cycleId, report_id: cycle.report_id, symbol: "AAPL", status: "executed" })])
    expect(broker.holdings.get("AAPL")).toMatchObject({ qty: 10 })
    expect(await db.col.cache.findOne({ _id: "alpaca:account" })).not.toBeNull()
    expect(alerts).toEqual([])
  })

  it("streams the whole thinking process, in order, tagged with the cycle", async () => {
    fakeAi({ decision: report({ headline: "Buying AAPL", decisions: [decision({ symbol: "AAPL", allocation_pct: 10 })] }) })
    const { cycleId } = await run("intraday")
    expect(types()).toEqual([
      "cycle.started",
      "cycle.step",
      "context.built",
      "research.started",
      "research.query",
      "research.source",
      "research.progress",
      "ai.reasoning",
      "cycle.step",
      "research.completed",
      "ai.decision.started",
      "ai.decision.progress",
      "cycle.step",
      "ai.decision.completed",
      "ai.report",
      "ai.decision.proposed",
      "order.submitted",
      "risk.checked",
      "decision.result",
      "cycle.step",
      "cycle.step",
      "cycle.completed",
    ])
    expect(events.filter((e) => e.type !== "order.submitted").every((e) => e.cycle_id === cycleId)).toBe(true)
    const risk = events.find((e) => e.type === "risk.checked")!
    expect(risk.data).toMatchObject({ symbol: "AAPL", approved: true, qty: 10 })
    expect((risk.data as { checks: { name: string; ok: boolean }[] }).checks.map((c) => c.name)).toEqual([
      "engine",
      "loss limits",
      "not held",
      "open positions",
      "buys this cycle",
      "trades today",
      "conviction",
      "cooldown",
      "tradable",
      "price",
      "min price",
      "allocation",
      "size",
      "reward:risk",
    ])
    expect(events.find((e) => e.type === "ai.decision.progress")!.summary).toBe("Writing: “Buying AAPL” · 1 decisions so far")
  })

  it("hides model reasoning when streaming it is turned off", async () => {
    fakeAi()
    ctx.settings.current.ai.stream_reasoning = false
    await run("intraday")
    expect(types()).not.toContain("ai.reasoning")
  })

  it("records daily stats first and makes no trades in the postmarket review", async () => {
    fakeAi({ decision: report({ lessons: ["Wait for the pullback."], decisions: [decision()] }) })
    const { cycleId, status } = await run("postmarket")
    expect(status).toBe("succeeded")
    expect((await cycleOf(cycleId)).steps.map((s) => s.name)).toEqual(["daily stats", "context", "research", "decision", "execution"])
    expect(await db.col.dailyStats.findOne({ _id: DAY })).not.toBeNull()
    expect(broker.submitted).toEqual([])
  })

  it("continues on broker data alone when research fails, with a warning", async () => {
    const { structured } = fakeAi({ researchError: "gateway timeout" })
    const { cycleId, status } = await run("intraday")
    expect(status).toBe("succeeded")
    expect((await cycleOf(cycleId)).steps.find((s) => s.name === "research")!.detail).toBe("failed: gateway timeout")
    expect(alerts).toContainEqual(expect.objectContaining({ level: "warning", title: "Research failed (intraday), continuing with broker data only", message: "gateway timeout" }))
    expect(structured.mock.calls[0][0].prompt).toContain("RESEARCH UNAVAILABLE (gateway timeout)")
  })

  it("alerts with a link to the report when orders fail", async () => {
    broker.fillMode = "reject"
    fakeAi({ decision: report({ decisions: [decision({ symbol: "AAPL" })] }) })
    const { cycleId } = await run("intraday")
    const { report_id } = await cycleOf(cycleId)
    expect(alerts).toContainEqual({ level: "error", title: "1 order failed (intraday)", message: "BUY AAPL: order rejected by broker", path: `/research/${report_id}`, fields: { Cycle: cycleId } })
  })

  it("marks the cycle failed and alerts when the decision step fails", async () => {
    fakeAi({ decisionError: new Error("decision failed after 3 attempts: model overloaded") })
    const { cycleId, status } = await run("intraday")
    expect(status).toBe("failed")
    expect(await cycleOf(cycleId)).toMatchObject({ status: "failed", error: "decision failed after 3 attempts: model overloaded", report_id: null })
    expect(await db.col.reports.countDocuments()).toBe(0)
    expect(types()).toEqual(expect.arrayContaining(["ai.decision.failed", "cycle.failed"]))
    expect(alerts).toContainEqual(expect.objectContaining({ level: "error", title: "intraday cycle failed" }))
  })

  it("applies the overnight rules after the closing cycle, even to a position Grok held", async () => {
    fakeAi({ decision: report({ decisions: [decision({ symbol: "AAPL", action: "hold" })] }) })
    broker.setPosition("AAPL", 10, 100)
    await db.col.plans.insertOne(planDoc("AAPL", { horizon: "intraday" }))
    const { cycleId } = await run("close")
    expect((await cycleOf(cycleId)).steps.find((s) => s.name === "overnight rules")).toMatchObject({ ok: true, detail: "flattened AAPL" })
    expect(broker.holdings.has("AAPL")).toBe(false)
  })

  it("sells intraday positions when the closing cycle fails", async () => {
    fakeAi({ decisionError: new Error("model overloaded") })
    broker.setPosition("AAPL", 10, 100)
    await db.col.plans.insertOne(planDoc("AAPL", { horizon: "intraday" }))
    const { cycleId, status } = await run("close")
    expect(status).toBe("failed")
    expect((await cycleOf(cycleId)).error).toBe("model overloaded | fallback: flattened AAPL")
    expect(broker.holdings.has("AAPL")).toBe(false)
  })

  it("protects positions after the closing cycle", async () => {
    fakeAi()
    broker.setPosition("MSFT", 2, 400)
    broker.addOrder(alpacaOrder({ symbol: "MSFT", side: "sell", type: "limit", order_class: "oco", qty: "2", status: "new" }))
    const { cycleId } = await run("close")
    expect((await cycleOf(cycleId)).steps.map((s) => s.name)).toContain("protection")
  })

  it("fails a cycle whose context can't be built, without calling the AI", async () => {
    const { research } = fakeAi()
    vi.mocked(broker.client.getAccount).mockRejectedValue(new Error("401 unauthorized"))
    const { cycleId, status } = await run("intraday")
    expect(status).toBe("failed")
    expect((await cycleOf(cycleId)).steps.map((s) => [s.name, s.ok])).toEqual([["context", false]])
    expect(research).not.toHaveBeenCalled()
  })

  it("rejects new entries if the kill switch is engaged mid-cycle", async () => {
    fakeAi({ decision: report({ decisions: [decision({ symbol: "AAPL", allocation_pct: 10 })] }) })
    await run("intraday", { entriesBlocked: () => "kill switch engaged: testing" })
    expect(await db.col.decisions.findOne({ symbol: "AAPL" })).toMatchObject({ status: "rejected", reason: "kill switch engaged: testing" })
    expect(broker.submitted).toEqual([])
  })
})

describe("retries", () => {
  it("reuses the failed attempt's research when the scheduler retries the phase, instead of paying for it again", async () => {
    fakeAi({ decisionError: new Error("decision failed after 3 attempts: timeout") })
    const failed = await run("intraday", { kind: "scheduled" })
    expect(failed.status).toBe("failed")
    expect(await cycleOf(failed.cycleId)).toMatchObject({ research: { memo: expect.stringContaining("SPY +0.3%"), mode: "full", cost_usd: 0.05, at: expect.any(Date) } })

    vi.setSystemTime(NOW.getTime() + 4 * 60_000)
    const { research, structured } = fakeAi()
    const retry = await run("intraday", { kind: "scheduled" })
    expect(retry.status).toBe("succeeded")
    expect(research).not.toHaveBeenCalled()
    expect(structured.mock.calls[0][0].prompt).toContain("SPY +0.3%")
    const cycle = await cycleOf(retry.cycleId)
    expect(cycle.ai_cost_usd).toBe(0.02)
    expect(cycle.steps.find((s) => s.name === "research")!.detail).toMatch(/^reused from the failed attempt at \d{1,2}:\d{2}.* ET, 1 sources$/)
    expect(await db.col.reports.findOne({ cycle_id: retry.cycleId })).toMatchObject({ research: { memo: expect.stringContaining("SPY +0.3%"), reused_from: failed.cycleId, cost_usd: 0 }, cost_usd: 0.02 })
  })

  it("researches afresh outside a scheduled retry, or when the failed attempt's research is stale", async () => {
    fakeAi({ decisionError: new Error("model overloaded") })
    await run("intraday", { kind: "scheduled" })

    const manual = fakeAi()
    await run("intraday", { kind: "manual" })
    expect(manual.research).toHaveBeenCalledTimes(1)

    vi.setSystemTime(NOW.getTime() + 21 * 60_000)
    const late = fakeAi()
    await run("intraday", { kind: "scheduled" })
    expect(late.research).toHaveBeenCalledTimes(1)
  })
})

describe("skipped cycles", () => {
  it("skips the AI when it's disabled, but still enforces the closing rules", async () => {
    broker.setPosition("AAPL", 10, 100)
    await db.col.plans.insertOne(planDoc("AAPL", { horizon: "intraday" }))
    const result = await run("close")
    expect(result.status).toBe("skipped")
    expect(await cycleOf(result.cycleId)).toMatchObject({ status: "skipped", error: "AI is disabled (AI_GATEWAY_API_KEY not set)" })
    expect(broker.holdings.has("AAPL")).toBe(false)
    expect(types()).toContain("cycle.skipped")
  })

  it("skips when the daily AI budget is spent, and says so", async () => {
    const { research } = fakeAi()
    ctx.settings.current.ai.daily_budget_usd = 0
    const result = await run("intraday")
    expect(result.status).toBe("skipped")
    expect(research).not.toHaveBeenCalled()
    expect(types()).toContain("budget.exhausted")
    expect(alerts).toContainEqual(expect.objectContaining({ level: "warning", title: "Daily AI budget exhausted" }))
  })
})
