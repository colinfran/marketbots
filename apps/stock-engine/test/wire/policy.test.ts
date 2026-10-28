import { silentLogger } from "@mb/engine-kit/log"
import { settle, useFakeClock } from "@mb/engine-kit/testing/timers"
import { DEFAULT_SETTINGS, type Settings } from "@mb/stock-core/settings"
import type { EventFocus, WireItemDoc } from "@mb/stock-core/wire"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AiRunner, ResearchResult } from "@mb/engine-kit/ai/runner"
import type { EngineContext } from "../../src/bot/context"
import { researchPlan, runCycle } from "../../src/bot/cycle"
import type { EventBus } from "../../src/bus/event-bus"
import { assembleDossier } from "../../src/wire/dossier"
import { CORE_REVIEW_RULE, stockRules, WirePolicy, withCoreBook } from "../../src/wire/policy"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeBus, makeCtx } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { afterOpen, DAY, decision, report, session } from "../helpers/factories"

const db = useTestDb()
const NOW = new Date("2026-10-27T15:00:00Z")

const item = (overrides: Partial<WireItemDoc> = {}): WireItemDoc => {
  const id = `i-${Math.random().toString(36).slice(2, 10)}`
  return {
    _id: id,
    cluster_id: id,
    source: "edgar:8k",
    tier: 1,
    kind: "filing",
    category: "general",
    title: "Something",
    summary: null,
    url: "https://sec.gov/x",
    domain: "sec.gov",
    symbols: ["NVDA"],
    published_at: new Date(NOW.getTime() - 60_000),
    first_seen_at: new Date(NOW.getTime() - 30_000),
    polarity: 0,
    severity: 60,
    severity_parts: {},
    confirmations: [],
    price_at_seen: {},
    meta: {},
    notable: false,
    notable_reasons: [],
    expires_at: new Date(NOW.getTime() + 30 * 86_400_000),
    ...overrides,
  }
}

const setup = async ({ held = ["NVDA"], open = true, settings = DEFAULT_SETTINGS, core = new Set<string>() }: { held?: string[]; open?: boolean; settings?: Settings; core?: Set<string> } = {}) => {
  const bus = await makeBus(db.col)
  const request = vi.fn<(f: EventFocus) => "fired" | "queued">(() => "fired")
  const alert = vi.fn(async () => undefined)
  const emergency = vi.fn(async () => "selling")
  const policy = new WirePolicy({
    col: db.col,
    bus,
    log: silentLogger,
    settings: () => settings,
    rules: withCoreBook(stockRules, () => core),
    engine: () => ({ running: true, killSwitch: false }),
    session: () => ({ open, reason: open ? "regular session" : "outside the regular session" }),
    held: () => held,
    universe: () => ["SPY", "AAPL"],
    request,
    markNotable: async () => undefined,
    emergency,
    alert,
    now: () => NOW,
  })
  return { policy, request, alert, emergency, bus }
}
const triggers = () => db.col.wireTriggers.find({}).toArray()

describe("stock policy", () => {
  it("reviews a holding on a negative filing in session, and alerts instead when the market is closed", async () => {
    const a = await setup()
    await a.policy.onItem({ item: item({ category: "restatement", severity: 90, title: "NVDA 8-K: 4.02 Non-Reliance" }), backfill: false, confirmation: false })
    expect(a.request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "NVDA", rule: "held_negative", action: "review" }))
    await a.bus.stop()

    await db.col.wireTriggers.deleteMany({})
    const b = await setup({ open: false })
    await b.policy.onItem({ item: item({ category: "offering", severity: 65, polarity: -1 }), backfill: false, confirmation: false })
    expect(b.request).not.toHaveBeenCalled()
    expect(b.alert).toHaveBeenCalledWith(expect.stringContaining("market closed"), expect.any(String))
    expect((await triggers())[0]).toMatchObject({ status: "suppressed", reason: expect.stringContaining("market closed") })
    await b.bus.stop()
  })

  it("evaluates confirmed good news on a stock we don't hold, and checks unexplained movers only when unexplained_move_entries is on", async () => {
    const { policy, request, bus } = await setup({ held: [] })
    await policy.onItem({ item: item({ symbols: ["AAPL"], category: "m_and_a", polarity: 1, severity: 75, tier: 1, title: "AAPL to be acquired" }), backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "AAPL", action: "evaluate" }))
    request.mockClear()
    const mover = () => item({ symbols: ["ACME"], kind: "anomaly", category: "price_shock", polarity: 1, severity: 60, meta: { anomaly: "mover" } })
    await policy.onItem({ item: mover(), backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    expect((await triggers()).map((t) => t.rule)).not.toContain("unexplained_move")
    await bus.stop()

    const on = await setup({ held: [], settings: { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, unexplained_move_entries: true } } })
    await on.policy.onItem({ item: mover(), backfill: false, confirmation: false })
    expect(on.request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "ACME", rule: "unexplained_move", action: "gap_fill" }))
    await on.bus.stop()
  })

  it("alerts on a halt of a holding and reviews on the resumption", async () => {
    const { policy, request, alert, bus } = await setup()
    await policy.onItem({ item: item({ category: "halt", kind: "venue", severity: 75, polarity: -1, meta: { resumes_at: null } }), backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    expect(alert).toHaveBeenCalledOnce()
    await policy.onItem({ item: item({ category: "halt", kind: "venue", severity: 75, polarity: 0, meta: { resumes_at: "10:15:00" } }), backfill: false, confirmation: false })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ symbol: "NVDA", rule: "halt", action: "review" }))
    await bus.stop()
  })

  it("annotates odds, attention, insider clusters, congressional trades and our own readings; only a critical odds swing reviews what we hold", async () => {
    const a = await setup()
    const swing = (severity: number) => item({ source: "odds:kalshi", tier: 2, kind: "sentiment", category: "odds_swing", symbols: [], severity, meta: { metric: `kalshi:KXFED-26DEC-T4.25:${severity}` } })
    await a.policy.onItem({ item: swing(60), backfill: false, confirmation: false })
    expect(a.request).not.toHaveBeenCalled()
    await a.policy.onItem({ item: swing(90), backfill: false, confirmation: false })
    expect(a.request).toHaveBeenCalledWith(expect.objectContaining({ symbol: null, rule: "odds_swing", action: "market_review" }))
    a.request.mockClear()
    for (const context of [
      // An insider cluster is an idea for the next cycle, even when loud and positive.
      item({ source: "insiders", tier: 2, kind: "filing", category: "insider_buy", symbols: ["AAPL"], polarity: 1, severity: 80, meta: { insider: true, cluster: true } }),
      // A congressional trade is weeks old when it is disclosed: a purchase of a stock we could buy, a sale of one we hold.
      item({ source: "congress:house", tier: 3, kind: "filing", category: "general", symbols: ["AAPL"], polarity: 1, severity: 80, meta: { congress: true, transaction: "purchase" } }),
      item({ source: "congress:house", tier: 3, kind: "filing", category: "general", symbols: ["NVDA"], polarity: -1, severity: 80, meta: { congress: true, transaction: "sale" } }),
      item({ source: "vol_rates:vix", kind: "derivatives", category: "price_shock", symbols: [], polarity: -1, severity: 70, meta: { metric: "vix" } }),
      item({ source: "treasury", kind: "macro", category: "macro_release", symbols: [], polarity: -1, severity: 60, meta: { metric: "treasury:auction:10-Year" } }),
      item({ source: "finra_short", kind: "derivatives", category: "general", symbols: ["NVDA"], polarity: 0, severity: 60, meta: { metric: "finra_short:NVDA" } }),
      item({ source: "stocktwits", tier: 3, kind: "sentiment", category: "sentiment_spike", symbols: ["NVDA"], polarity: -1, severity: 70 }),
    ]) {
      await a.policy.onItem({ item: context, backfill: false, confirmation: false })
    }
    expect(a.request).not.toHaveBeenCalled()
    expect((await triggers()).map((t) => t.rule)).toEqual(["odds_swing"])
    await a.bus.stop()

    // With nothing held, even a critical swing is only context.
    await db.col.wireTriggers.deleteMany({})
    const b = await setup({ held: [] })
    await b.policy.onItem({ item: swing(95), backfill: false, confirmation: false })
    expect(b.request).not.toHaveBeenCalled()
    expect(await triggers()).toEqual([])
    await b.bus.stop()
  })

  it("runs the exit emergency action only on critical confirmed bad news", async () => {
    const exit = { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, emergency_action: "exit" as const } }
    const { policy, emergency, bus } = await setup({ settings: exit })
    await policy.onItem({ item: item({ category: "bankruptcy", severity: 95, polarity: -1 }), backfill: false, confirmation: false })
    expect(emergency).toHaveBeenCalledWith("NVDA", expect.anything())
    await bus.stop()
  })
})

describe("core book holdings", () => {
  const core = new Set(["NVDA"])

  it("ask for a single-holding core review on bad news at evaluate severity, never an event cycle or the emergency exit", async () => {
    const exit = { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, emergency_action: "exit" as const } }
    const { policy, request, emergency, bus } = await setup({ held: ["NVDA", "AMD"], core, settings: exit })
    await policy.onItem({ item: item({ symbols: ["NVDA", "AMD"], category: "bankruptcy", severity: 95, polarity: -1 }), backfill: false, confirmation: false })
    expect(request.mock.calls.map(([f]) => [f.symbol, f.rule, f.action])).toEqual([
      ["AMD", "held_negative", "review"],
      ["NVDA", CORE_REVIEW_RULE, "review"],
    ])
    // The trading holding still gets the owner's emergency exit; the core one doesn't.
    expect(emergency).toHaveBeenCalledOnce()
    expect(emergency).toHaveBeenCalledWith("AMD", expect.anything())
    await bus.stop()
  })

  it("leave lesser news, price shocks and resumed halts to the weekly review, but still alert on a halt", async () => {
    const { policy, request, alert, bus } = await setup({ core })
    await policy.onItem({ item: item({ category: "offering", severity: 65, polarity: -1 }), backfill: false, confirmation: false }) // review severity, under evaluate (70)
    await policy.onItem({ item: item({ kind: "anomaly", category: "price_shock", severity: 75, polarity: -1, meta: { anomaly: "price" } }), backfill: false, confirmation: false })
    await policy.onItem({ item: item({ category: "halt", kind: "venue", severity: 75, polarity: 0, meta: { resumes_at: "10:15:00" } }), backfill: false, confirmation: false })
    expect(request).not.toHaveBeenCalled()
    await policy.onItem({ item: item({ category: "halt", kind: "venue", severity: 75, polarity: -1, meta: { resumes_at: null } }), backfill: false, confirmation: false })
    expect(alert).toHaveBeenCalledOnce()
    expect((await triggers()).map((t) => [t.rule, t.action])).toEqual([["halt", "alert_only"]])
    await bus.stop()
  })
})

describe("stock research modes", () => {
  const ctxFor = (wire: Partial<Settings["wire"]>) => ({ settings: { current: { ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, ...wire } }, version: 1 } }) as unknown as Pick<EngineContext, "settings">
  const empty = assembleDossier([], { symbols: ["NVDA"], since: NOW, now: NOW, price: () => null, timeLabel: () => "", reviewThreshold: 55 })
  it("is full without a healthy wire, and follows the mode otherwise", () => {
    expect(researchPlan(ctxFor({}), { isEvent: false, wireHealthy: false, dossier: empty }).kind).toBe("full")
    expect(researchPlan(ctxFor({}), { isEvent: false, wireHealthy: true, dossier: null }).kind).toBe("full")
    expect(researchPlan(ctxFor({ research_mode: "gap_fill" }), { isEvent: false, wireHealthy: true, dossier: empty }).kind).toBe("gap")
    expect(researchPlan(ctxFor({ event_research: "none" }), { isEvent: true, wireHealthy: true, dossier: empty }).kind).toBe("none")
    expect(researchPlan(ctxFor({}), { isEvent: true, wireHealthy: true, dossier: empty }).kind).toBe("gap")
  })

  it("auto runs the gap-fill for a gap on any subject or the market, and skips Grok otherwise (no X-freshness rule)", () => {
    const moved = item({ symbols: ["NVDA"], kind: "anomaly", category: "price_shock", polarity: 1, url: null, meta: { anomaly: "price" } })
    const rumor = item({ symbols: [], source: "rss:blog", tier: 3, kind: "news", url: "https://blog.test/a" })
    const o = { symbols: ["NVDA", "ACME"], since: new Date(NOW.getTime() - 3_600_000), now: NOW, price: () => null, timeLabel: () => "", reviewThreshold: 55 }
    const auto = ctxFor({ research_mode: "auto" })
    expect(researchPlan(auto, { isEvent: false, wireHealthy: true, dossier: assembleDossier([moved], o) })).toEqual({ kind: "gap", reason: "1 unexplained moves, 0 unconfirmed items" })
    expect(researchPlan(auto, { isEvent: false, wireHealthy: true, dossier: assembleDossier([rumor], o) })).toEqual({ kind: "gap", reason: "0 unexplained moves, 1 unconfirmed items" })
    expect(researchPlan(auto, { isEvent: false, wireHealthy: true, dossier: empty })).toEqual({ kind: "none", reason: "no unexplained moves or unconfirmed items in our feeds" })
  })

  it("always gives the one-time seed the full research", () => {
    expect(researchPlan(ctxFor({}), { isEvent: false, isSeed: true, wireHealthy: true, dossier: empty })).toEqual({ kind: "full", reason: "one-time seed" })
    expect(researchPlan(ctxFor({ research_mode: "gap_fill" }), { isEvent: false, isSeed: true, wireHealthy: true, dossier: empty }).kind).toBe("full")
  })
})

describe("stock event cycle", () => {
  let broker: FakeBroker
  let ctx: EngineContext
  let bus: EventBus

  beforeEach(async () => {
    useFakeClock(afterOpen(30))
    broker = fakeBroker()
    broker.calendar = [{ date: DAY, open: "09:30", close: "16:00" }]
    for (const [s, p] of Object.entries({ SPY: 580, QQQ: 500, AAPL: 100 })) broker.setPrice(s, p)
    ;({ ctx, bus } = await makeCtx(db.col, broker))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await bus.stop()
  })

  it("focuses on the event symbol with gap-fill research and records the trigger on the decision", async () => {
    const research = vi.fn(async (opts: Parameters<AiRunner["research"]>[0]): Promise<ResearchResult> => ({ memo: "## X sentiment\nUpbeat.", sources: [], queries: [], model: opts.model, x_search: true, duration_ms: 1, usage: { input: 1, output: 1, total: 2 }, cost_usd: 0.02, error: null }))
    const structured = vi.fn(async (opts: Parameters<AiRunner["structured"]>[0]) => ({
      output: report({ decisions: [decision({ symbol: "AAPL", allocation_pct: 10, conviction: 8, stop_loss: 97, take_profit: 106 })] }),
      attempts: 1,
      repaired: false,
      model: opts.model,
      cost_usd: 0.02,
      usage: { input: 1, output: 1, total: 2 },
    }))
    ctx.ai = { available: true, research, structured } as unknown as AiRunner
    const focus: EventFocus = { symbol: "AAPL", rule: "entry_event", action: "evaluate", severity: 76, polarity: 1, item_ids: ["item-1"], trigger_id: "trig-1", headline: "AAPL wins a big contract" }
    const r = await settle(runCycle(ctx, { phase: "intraday", session: session(), trigger: "event: entry event AAPL", kind: "event", events: [focus] }))
    expect(r.status).toBe("succeeded")
    expect(research.mock.calls[0][0]).toMatchObject({ prompt: expect.stringContaining("THIS CYCLE WAS STARTED BY AN EVENT"), timeoutMs: 45_000 })
    expect(structured.mock.calls[0][0]).toMatchObject({ prompt: expect.stringContaining("# EVENT (why this cycle started)"), timeoutMs: 90_000 })
    expect(await db.col.decisions.findOne({ symbol: "AAPL" })).toMatchObject({ trigger_kind: "event", wire_item_ids: ["item-1"], status: "executed" })
    expect(await db.col.cycles.findOne({ _id: r.cycleId })).toMatchObject({ kind: "event", wire_trigger_id: "trig-1", research_plan: { kind: "gap", reason: "event check (x_verify)" } })
  })
})
