import type { AiRunner, ResearchResult } from "@mb/engine-kit/ai/runner"
import { settle, useFakeClock } from "@mb/engine-kit/testing/timers"
import type { CoreRanking, CoreRankRow, CoreReviewOutput } from "@mb/stock-core/core-book"
import type { CoreReviewDoc, SeedRunDoc } from "@mb/stock-core/db"
import type { EngineEvent } from "@mb/stock-core/events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineContext } from "../../src/bot/context"
import type { EventBus } from "../../src/bus/event-bus"
import { runCoreReview } from "../../src/core-book/review"
import { fakeBroker, isOpenStatus, type FakeBroker } from "../helpers/broker"
import { makeCtx, type SentAlert } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { afterOpen, DAY, planDoc, session } from "../helpers/factories"

const NOW = afterOpen(45) // Monday 10:15 ET
const db = useTestDb()
let broker: FakeBroker
let ctx: EngineContext
let bus: EventBus
let events: EngineEvent[]
let alerts: SentAlert[]

const row = (symbol: string, o: Partial<CoreRankRow> = {}): CoreRankRow => ({
  symbol,
  name: `${symbol} Inc.`,
  price: 100,
  sessions: 262,
  sma50: 95,
  sma200: 90,
  pct_from_sma50: 5.26,
  pct_from_sma200: 11.11,
  return_3m_pct: 8,
  return_6m_pct: 15,
  return_12m_pct: 30,
  return_12_1_pct: 25,
  rel_spy_3m_pct: 2,
  rel_spy_6m_pct: 5,
  rel_spy_12m_pct: 12,
  from_52w_high_pct: -3,
  volatility_60d_pct: 30,
  max_drawdown_1y_pct: -18,
  dollar_volume_20d: 5_000_000_000,
  sources: ["universe"],
  themes: [],
  trend_ok: true,
  score: 50,
  rank: 2,
  ...o,
})

const RANKING: CoreRanking = {
  day: DAY,
  built_at: NOW,
  as_of: "2026-10-23",
  universe_day: DAY,
  rows: [row("NVDA", { price: 200, rank: 1, score: 95, themes: ["AI buildout"], sources: ["universe", "theme"] }), row("SPY", { price: 500, rank: 2, sources: ["benchmark", "held"] }), row("DIA", { price: 400, rank: 3, sources: ["benchmark", "held"] }), row("AVGO", { rank: null, score: null, trend_ok: false, themes: ["AI buildout"], sources: ["theme"] })],
  excluded: [],
}

const OUTPUT: CoreReviewOutput = {
  summary: "Keep the index core, trim DIA, start the AI buildout with NVDA.",
  holdings: [
    { symbol: "SPY", action: "keep", target_weight_pct: 20, conviction: 8, thesis: "Broad US large caps compound with earnings.", invalidation: "S&P 500 forward earnings estimates fall two months running.", verdict: "Earnings season on track; raise the stop.", theme: null, stop: 470, evidence: [] },
    { symbol: "DIA", action: "trim", target_weight_pct: 15, conviction: 6, thesis: "Industrials and value ballast.", invalidation: "Industrial orders contract.", verdict: "Overlaps SPY; trim to make room.", theme: null, stop: null, evidence: [] },
    { symbol: "NVDA", action: "buy", target_weight_pct: 10, conviction: 8, thesis: "Data-center demand keeps outrunning supply; guidance raised twice.", invalidation: "Hyperscaler capex guidance cut.", verdict: "New core holding.", theme: "AI buildout", stop: 180, evidence: ["Q3 data-center revenue +60% y/y"] },
  ],
  watch: [{ symbol: "AVGO", reason: "Custom AI chips.", trigger: "Reclaims its 200-day average." }],
  sources: [{ title: "Reuters", url: "https://reuters.com/x" }],
}

const fakeAi = ({ output = OUTPUT, researchError }: { output?: CoreReviewOutput; researchError?: string } = {}) => {
  const research = vi.fn(
    async (opts: Parameters<AiRunner["research"]>[0]): Promise<ResearchResult> => ({
      memo: researchError ? "" : "## 1. Holdings\n- SPY: earnings on track (Oct 24, https://reuters.com/x)",
      sources: [],
      queries: ["nvda guidance"],
      model: opts.model,
      x_search: true,
      duration_ms: 1_000,
      usage: { input: 100, output: 50, total: 150 },
      cost_usd: 0.3,
      error: researchError ?? null,
    }),
  )
  const structured = vi.fn(async (opts: Parameters<AiRunner["structured"]>[0]) => ({ output, attempts: 1, repaired: false, model: opts.model, cost_usd: 0.1, usage: { input: 100, output: 50, total: 150 } }))
  ctx.ai = { available: true, research, structured } as unknown as AiRunner
  return { research, structured }
}

const seedRun = (): SeedRunDoc => ({
  _id: "seed-1",
  status: "done",
  amount_usd: 4_000,
  at: new Date("2026-10-23T13:45:00Z"),
  created_at: new Date("2026-10-22T20:00:00Z"),
  created_by: "owner",
  force: false,
  started_at: new Date("2026-10-23T13:45:00Z"),
  cycle_id: "cycle-seed",
  result: {
    allocations: [
      { symbol: "SPY", weight_pct: 50, notional_usd: 2_000, thesis: "SPY: broad US large caps for the long run." },
      { symbol: "DIA", weight_pct: 50, notional_usd: 2_000, thesis: "DIA: blue-chip industrials." },
    ],
    orders: [
      { symbol: "SPY", decision_id: "d1", status: "executed", qty: 4, notional_usd: 1_920, reason: null },
      { symbol: "DIA", decision_id: "d2", status: "executed", qty: 5, notional_usd: 1_950, reason: null },
    ],
    notes: [],
    rationale: "Index core.",
  },
  error: null,
  done_at: new Date("2026-10-23T13:46:00Z"),
})

const review = (dryRun = false) =>
  settle(runCoreReview(ctx, { kind: "weekly", trigger: "schedule", dryRun, session: session(), entriesBlocked: () => null, ranking: { build: async () => RANKING, latest: async () => RANKING } }))

const reviewDoc = async (id: string) => (await db.col.coreReviews.findOne({ _id: id })) as CoreReviewDoc
const resting = () => broker.allOrders().filter((o) => isOpenStatus(o.status) && o.side === "sell").map((o) => [o.symbol, o.type, o.qty, o.stop_price ?? null, o.limit_price ?? null])

beforeEach(async () => {
  useFakeClock(NOW)
  broker = fakeBroker()
  broker.calendar = [{ date: DAY, open: "09:30", close: "16:00" }]
  // What the seed bought: SPY and DIA with their OCO exits (a ~7.5% stop and a far target).
  broker.setPosition("SPY", 4, 500, { avg: 480 }).setPosition("DIA", 5, 400, { avg: 390 }).setPrice("NVDA", 200).setPrice("AVGO", 300)
  ;({ ctx, bus, events, alerts } = await makeCtx(db.col, broker, { core: { enabled: true, themes: ["AI buildout: NVDA, AVGO"] } }))
  for (const [symbol, qty, stop, target] of [["SPY", 4, 444, 600], ["DIA", 5, 360, 480]] as const) {
    await broker.client.submitOrder({ symbol, qty: String(qty), side: "sell", type: "limit", time_in_force: "gtc", order_class: "oco", take_profit: { limit_price: String(target) }, stop_loss: { stop_price: String(stop) } })
    await db.col.plans.insertOne(planDoc(symbol, { horizon: "multi_day", stop_loss: stop, take_profit: target, thesis: `${symbol} seed thesis` }))
  }
  await db.col.seedRuns.insertOne(seedRun())
})

afterEach(async () => {
  vi.useRealTimers()
  await bus.stop()
})

describe("the core review", () => {
  it("adopts the seed holdings, then trims, buys and raises stops by the rules, and records it all", async () => {
    const { research, structured } = fakeAi()
    const result = await review()
    expect(result).toMatchObject({ status: "done", summary: OUTPUT.summary })

    // The OCOs gave way to plain GTC stops; DIA lost a share, NVDA came in, SPY's stop went up.
    expect(resting().sort()).toEqual([
      ["DIA", "stop", "4", "331.50", null],
      ["NVDA", "stop", "5", "180.00", null],
      ["SPY", "stop", "4", "470.00", null],
    ])
    expect(broker.holdings.get("DIA")!.qty).toBe(4)
    expect(broker.holdings.get("NVDA")!.qty).toBe(5)

    const plans = new Map((await db.col.plans.find().toArray()).map((p) => [p._id, p]))
    expect(plans.get("NVDA")).toMatchObject({ book: "core", theme: "AI buildout", stop_loss: 180, take_profit: null, horizon: "multi_day", thesis: OUTPUT.holdings[2].thesis, invalidation: "Hyperscaler capex guidance cut." })
    // The first review writes an adopted holding's thesis; the seed's reasoning stays in its notes.
    expect(plans.get("SPY")).toMatchObject({ book: "core", stop_loss: 470, take_profit: null, thesis: OUTPUT.holdings[0].thesis, last_reviewed_at: expect.any(Date) })
    expect(plans.get("SPY")!.notes!.map((n) => [n.action, n.text])).toEqual([
      ["adopted", "Adopted from the one-time seed into the core book."],
      ["keep", "Earnings season on track; raise the stop."],
    ])
    expect(plans.get("DIA")!.notes!.map((n) => n.action)).toEqual(["adopted", "trim"])

    const doc = await reviewDoc(result.reviewId)
    expect(doc).toMatchObject({ status: "done", dry_run: false, adopted: ["SPY", "DIA"], summary: OUTPUT.summary, watch: OUTPUT.watch, cost_usd: 0.4, model: "local/qwen3.6-35b-a3b-q2", ranking: { day: DAY, as_of: "2026-10-23" } })
    expect(doc.decisions.map((d) => [d.symbol, d.action, d.status, d.qty])).toEqual([
      ["DIA", "trim", "executed", 1],
      ["NVDA", "buy", "executed", 5],
      ["SPY", "keep", "noop", null],
    ])
    expect(doc.book_before).toMatchObject({ core_pct: 39.49, holdings: ["SPY", "DIA"] })
    expect(doc.book_after).toMatchObject({ holdings: ["SPY", "DIA", "NVDA"] })
    expect(doc.context!.first_review).toBe(true)
    expect(doc.context!.holdings.map((h) => [h.symbol, h.thesis, h.stop])).toEqual([
      ["SPY", "SPY: broad US large caps for the long run.", 408],
      ["DIA", "DIA: blue-chip industrials.", 331.5],
    ])
    expect(doc.context!.candidates.map((c) => c.symbol)).toEqual(["NVDA", "SPY", "DIA", "AVGO"])

    // Trades are decisions like any other, with orders linked to them.
    const decisions = await db.col.decisions.find().sort({ symbol: 1 }).toArray()
    expect(decisions.map((d) => [d.symbol, d.action, d.status, d.trigger_kind, d.report_id, d.request.sell_pct, d.request.allocation_pct])).toEqual([
      ["DIA", "sell", "executed", "core", result.reviewId, 20, null],
      ["NVDA", "buy", "executed", "core", result.reviewId, null, 10],
    ])
    expect(await db.col.orders.countDocuments({ decision_id: decisions[1]._id })).toBe(2) // the buy and its stop

    const cycle = (await db.col.cycles.findOne({ _id: result.cycleId }))!
    expect(cycle).toMatchObject({ kind: "core", phase: "intraday", status: "succeeded", report_id: result.reviewId, ai_cost_usd: 0.4 })
    expect(cycle.steps.map((s) => s.name)).toEqual(["book", "ranking", "research", "decision", "execution"])
    expect(research.mock.calls[0][0].prompt).toContain("CORE HOLDINGS (thesis and invalidation as written)")
    expect(structured.mock.calls[0][0]).toMatchObject({ name: "core_review", task: "decision" })
    expect(events.filter((e) => e.type.startsWith("core.review")).map((e) => [e.type, e.data])).toEqual([
      ["core.review.started", { review_id: result.reviewId, cycle_id: result.cycleId, kind: "weekly", trigger: "schedule", symbol: null, dry_run: false }],
      [
        "core.review.completed",
        expect.objectContaining({ status: "done", executed: 2, rejected: 0, decisions: [expect.objectContaining({ symbol: "DIA", status: "executed" }), expect.objectContaining({ symbol: "NVDA" }), expect.objectContaining({ symbol: "SPY", status: "noop" })] }),
      ],
    ])
    expect(alerts.map((a) => [a.level, a.title])).toEqual([["success", "Core review done"]])
  })

  it("adopts the seed only once", async () => {
    fakeAi()
    await review()
    broker.submitted.length = 0
    fakeAi({ output: { ...OUTPUT, holdings: [] } })
    const second = await review()
    expect((await reviewDoc(second.reviewId)).adopted).toEqual([])
    expect((await reviewDoc(second.reviewId)).context!.first_review).toBe(false)
    expect((await reviewDoc(second.reviewId)).context!.last_review).toMatchObject({ on: DAY, summary: OUTPUT.summary })
  })

  it("reviews a single holding on news: only that holding, no buys, no adoption", async () => {
    await db.col.plans.updateMany({}, { $set: { book: "core", take_profit: null, last_reviewed_at: NOW } })
    const { research, structured } = fakeAi({ output: { ...OUTPUT, holdings: [{ ...OUTPUT.holdings[1], action: "sell" }, OUTPUT.holdings[2], { ...OUTPUT.holdings[0], action: "trim" }] } })
    const event = "- [held review] DIA: Dow components cut guidance (severity 80)"
    const result = await settle(
      runCoreReview(ctx, { kind: "holding", trigger: "news: Dow components cut guidance", dryRun: false, session: session(), entriesBlocked: () => null, ranking: { build: async () => null, latest: async () => RANKING }, symbol: "DIA", event }),
    )
    const doc = await reviewDoc(result.reviewId)
    expect(doc).toMatchObject({ kind: "holding", symbol: "DIA", status: "done", adopted: [], watch: [] })
    expect(doc.decisions.map((d) => [d.symbol, d.action, d.status])).toEqual([["DIA", "sell", "executed"]])
    expect(broker.holdings.has("DIA")).toBe(false)
    expect(broker.holdings.get("SPY")!.qty).toBe(4)
    expect(broker.holdings.has("NVDA")).toBe(false)
    expect(doc.context).toMatchObject({ kind: "holding", first_review: false, book: { holdings: 2 } })
    expect(doc.context!.holdings.map((h) => h.symbol)).toEqual(["DIA"])
    expect(doc.context!.candidates.map((c) => c.symbol)).toEqual(["DIA"])
    expect(research.mock.calls[0][0]).toMatchObject({ timeoutMs: 120_000 })
    expect(research.mock.calls[0][0].prompt).toContain(`THIS IS A SINGLE-HOLDING REVIEW, started by news about a core holding:\n${event}`)
    expect(structured.mock.calls[0][0].prompt).toContain(`# EVENT (why this review started)\n${event}`)
    expect(events.find((e) => e.type === "core.review.started")).toMatchObject({ instrument: "DIA", data: { kind: "holding", symbol: "DIA" } })
  })

  it("skips a single-holding review of something no longer in the book", async () => {
    fakeAi()
    const result = await settle(runCoreReview(ctx, { kind: "holding", trigger: "news", dryRun: false, session: session(), entriesBlocked: () => null, ranking: { build: async () => null, latest: async () => RANKING }, symbol: "AAPL", event: "x" }))
    expect(result.status).toBe("skipped")
    expect(await reviewDoc(result.reviewId)).toMatchObject({ error: "AAPL is no longer a core holding" })
  })

  it("plans a dry run without placing orders or touching plans", async () => {
    fakeAi()
    const sent = broker.submitted.length
    const result = await review(true)
    expect(result.status).toBe("done")
    expect(broker.submitted.length).toBe(sent)
    expect(await db.col.plans.countDocuments({ book: "core" })).toBe(0)
    expect(await db.col.decisions.countDocuments()).toBe(0)
    const doc = await reviewDoc(result.reviewId)
    expect(doc).toMatchObject({ dry_run: true, adopted: ["SPY", "DIA"] })
    expect(doc.decisions.map((d) => [d.symbol, d.action, d.status, d.qty])).toEqual([
      ["DIA", "trim", "planned", 1],
      ["NVDA", "buy", "planned", 5],
      ["SPY", "keep", "noop", null],
    ])
    expect(alerts).toEqual([
      {
        level: "info",
        title: "Core review (dry run) done: nothing was traded",
        message: OUTPUT.summary,
        path: "/core",
        fields: { DIA: "trim · planned · 1 shares", NVDA: "buy · planned · 5 shares", SPY: "keep · noop" },
      },
    ])
  })

  it("buys nothing when research failed", async () => {
    fakeAi({ researchError: "research timed out" })
    const result = await review()
    const doc = await reviewDoc(result.reviewId)
    expect(doc.decisions.find((d) => d.symbol === "NVDA")).toMatchObject({ status: "rejected", reason: "research unavailable (research timed out): no buys" })
    expect(doc.decisions.find((d) => d.symbol === "DIA")).toMatchObject({ status: "executed" })
  })

  it("is skipped without AI, after taking stock of the book", async () => {
    const result = await review()
    expect(result.status).toBe("skipped")
    expect(await reviewDoc(result.reviewId)).toMatchObject({ status: "skipped", error: "AI is disabled (LLM_URL not set)", book_before: { holdings: ["SPY", "DIA"] } })
    expect((await db.col.cycles.findOne({ _id: result.cycleId }))!.status).toBe("skipped")
  })

  it("fails and alerts when the decision fails, changing nothing", async () => {
    const { structured } = fakeAi()
    structured.mockRejectedValueOnce(new Error("decision failed after 3 attempts"))
    const result = await review()
    expect(result.status).toBe("failed")
    expect(await reviewDoc(result.reviewId)).toMatchObject({ status: "failed", error: "decision failed after 3 attempts" })
    expect(broker.holdings.get("DIA")!.qty).toBe(5)
    expect(alerts.map((a) => [a.level, a.title])).toEqual([["error", "Core review failed"]])
  })
})
