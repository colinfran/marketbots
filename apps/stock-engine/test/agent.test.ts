import type { Observation } from "@mb/core/agent"
import type { StockAgentAnswer } from "@mb/stock-core/agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { actOnStockAnswer } from "../src/agent/act"
import { createShadowBook, type StockAgentDeps } from "../src/agent/book"
import { liveEnvelopeHistory } from "../src/agent/live"
import { stockBrief, StockObserver } from "../src/agent/observe"
import { stockAgentTools } from "../src/agent/tools"
import { bookText } from "../src/agent/view"
import type { Session } from "../src/bot/session"
import { fakeBroker } from "./helpers/broker"
import { makeCtx } from "./helpers/ctx"
import { useTestDb } from "./helpers/db"
import { afterOpen, beforeClose, NVDA_CALL_150, OPEN, session } from "./helpers/factories"

const db = useTestDb()

type Dec = StockAgentAnswer["decisions"][number]
const decision = (over: Partial<Dec> = {}): Dec => ({
  symbol: "AAPL",
  action: "buy",
  allocation_pct: 10,
  sell_pct: null,
  stop_loss: 196,
  take_profit: 210,
  horizon: "overnight",
  setup: "breakout",
  conviction: 7,
  rationale: "Broke the 20-day high on volume.",
  evidence: ["20-day high 199.50", "volume 2× average"],
  invalidation: "Back below 198.",
  structure_id: null,
  option: null,
  ...over,
})
const answer = (decisions: Dec[]): StockAgentAnswer => ({ decisions, watches: [], cancel_watches: [], notes: [], reply: "ok" })
/** The episode an answer belongs to. */
const ep = (id: string) => ({ id, wake: { subject: "AAPL", priority: 1 as const, salience: 60, observations: [] }, entriesPaused: null })

describe("stock agent", () => {
  let now: Date
  let prices: Record<string, number>
  let current: Session | null
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    now = afterOpen(60)
    vi.setSystemTime(now)
    prices = { AAPL: 200, SPY: 500 }
    current = session()
  })
  afterEach(() => vi.useRealTimers())

  /** `live`: level auto, the paper account on the fake broker. */
  const setup = async ({ live = false } = {}) => {
    const broker = fakeBroker()
    const { ctx, alerts } = await makeCtx(db.col, broker, live ? { agent: { level: "auto" } } : {})
    const snapshot = async () => ({ account: await broker.getAccount(), positions: await broker.getPositions() })
    let snap = await snapshot()
    const d: StockAgentDeps = { ctx, shadow: createShadowBook(ctx), history: null, session: () => current, price: (s) => prices[s] ?? null, snapshot: () => snap, offered: new Map(), reviews: new Map() }
    const known = (s: string) => s in prices
    /** The engine's 15-second account refresh. */
    const refresh = async () => {
      snap = await snapshot()
    }
    return { d, ctx, known, broker, alerts, refresh }
  }

  it("buys in the regular session through the cycle's buy rules, at the envelope's share", async () => {
    const { d, known } = await setup()
    const [a] = await actOnStockAnswer(d, answer([decision()]), ep("e1"), known)
    // 10% of $10,000 buys 5 shares; the envelope's half is $500: 2 shares at the ask plus 5 bps.
    expect(a).toMatchObject({ symbol: "AAPL", action: "buy", outcome: "filled", detail: expect.stringMatching(/^bought 2 at 200\.10/) })
    const [p] = await d.shadow.open()
    expect(p).toMatchObject({ symbol: "AAPL", qty: 2, stop_price: 196, take_profit_price: 210, horizon: "overnight", strategy: "breakout", conviction: 7, episode_id: "e1" })
  })

  it("buys only in the session, refuses what the cycle's rules refuse, and drops unknown tickers", async () => {
    const { d, known } = await setup()
    current = null
    const [closed] = await actOnStockAnswer(d, answer([decision()]), ep("e1"), known)
    expect(closed).toMatchObject({ outcome: "blocked", detail: expect.stringContaining("outside the regular session") })
    current = session()
    const out = await actOnStockAnswer(d, answer([decision({ conviction: 4 }), decision({ symbol: "ZZZZ" })]), ep("e2"), known)
    expect(out).toEqual([
      { symbol: "ZZZZ", action: "unknown", conviction: 0, outcome: "rejected", detail: "ZZZZ: not a ticker the agent may trade" },
      expect.objectContaining({ symbol: "AAPL", outcome: "rejected", detail: "conviction 4 < 6" }),
    ])
  })

  it("moves a held stop up but never down, and sells while the market is open", async () => {
    const { d, known } = await setup()
    await actOnStockAnswer(d, answer([decision()]), ep("e1"), known)
    vi.setSystemTime(afterOpen(120))
    const [up] = await actOnStockAnswer(d, answer([decision({ action: "adjust_exits", stop_loss: 198, take_profit: 212 })]), ep("e2"), known)
    expect(up).toMatchObject({ outcome: "updated", detail: expect.stringContaining("stop 198, target 212") })
    const [down] = await actOnStockAnswer(d, answer([decision({ action: "adjust_exits", stop_loss: 190, take_profit: null })]), ep("e3"), known)
    expect(down.outcome).toBe("updated")
    expect((await d.shadow.open())[0].stop_price).toBe(198)
    const [sold] = await actOnStockAnswer(d, answer([decision({ action: "sell", sell_pct: 100 })]), ep("e4"), known)
    expect(sold).toMatchObject({ outcome: "filled", detail: "sold 2 at 199.90" })
    expect(await d.shadow.open()).toEqual([])
  })

  it("closes intraday positions before the bell and wakes for the session's phases", async () => {
    const { d, known } = await setup()
    await actOnStockAnswer(d, answer([decision({ horizon: "intraday" })]), ep("e1"), known)
    const seen: Observation[] = []
    const observer = new StockObserver(d, (o) => seen.push(o))
    await observer.tick(new Date())
    expect(seen.map((o) => [o.kind, o.subject, o.priority])).toEqual([["session", "MARKET", 2]])
    vi.setSystemTime(beforeClose(2))
    await observer.tick(new Date())
    expect(seen.map((o) => o.summary)).toContainEqual(expect.stringMatching(/^Closing window/))
    expect(await d.shadow.open()).toEqual([])
    const fills = await d.ctx.col.shadowFills.find({ side: "sell" }).toArray()
    expect(fills.map((f) => f.reason)).toEqual(["overnight"])
    vi.setSystemTime(new Date(OPEN.getTime() - 30 * 60_000))
    current = session()
    expect(await bookText(d)).toContain("- Market: outside the regular session. New buys: blocked")
  })

  it("wakes for a minute's setups while buys are allowed, leaving out stocks it holds", async () => {
    const { d, known } = await setup()
    await actOnStockAnswer(d, answer([decision()]), ep("e1"), known)
    const seen: Observation[] = []
    const observer = new StockObserver(d, (o) => seen.push(o))
    const minute = (m: number, close: number, volume: number) => ["AAPL", "NVDA"].map((symbol) => ({ symbol, t: afterOpen(m).getTime(), close, volume }))
    for (let m = 0; m < 15; m++) await observer.onBars(minute(m, m % 2 ? 101 : 100, 1_000), now)
    await observer.onBars(minute(15, 101.5, 3_000), now)
    expect(seen).toEqual([expect.objectContaining({ subject: "MARKET", kind: "setup", priority: 1, refs: { symbol: "NVDA" }, summary: expect.stringMatching(/^NVDA opening-range breakout/) })])
    // Outside the session the screen keeps count, but nothing wakes the agent.
    current = null
    const quiet = new StockObserver(d, (o) => seen.push(o))
    for (let m = 0; m < 16; m++) await quiet.onBars(minute(m, m === 15 ? 101.5 : m % 2 ? 101 : 100, m === 15 ? 3_000 : 1_000), now)
    expect(seen).toHaveLength(1)
  })

  describe("at level auto", () => {
    it("buys on the paper account through the cycles' own path, at the envelope's share, and records its episode", async () => {
      const { d, ctx, known, broker } = await setup({ live: true })
      broker.setPrice("AAPL", 200)
      const [a] = await actOnStockAnswer(d, answer([decision()]), ep("e1"), known)
      // 10% of $10,000 asked; the envelope's half is 5%: $500 buys 2 shares at 200.
      expect(a).toMatchObject({ symbol: "AAPL", action: "buy", outcome: "filled", detail: expect.stringMatching(/^bought 2 shares/) })
      expect(await broker.getPositions()).toEqual([expect.objectContaining({ symbol: "AAPL", qty: "2" })])
      const docs = await ctx.col.decisions.find().toArray()
      expect(docs).toEqual([expect.objectContaining({ cycle_id: "e1", agent_episode_id: "e1", trigger_kind: "agent", status: "executed", request: expect.objectContaining({ allocation_pct: 5 }) })])
      expect(await liveEnvelopeHistory(d, 10_000)).toMatchObject({ openPositions: 1, entries: [expect.objectContaining({ symbol: "AAPL", notionalUsd: 400 })] })
      expect(await d.shadow.open()).toEqual([])
    })

    it("sells what it holds and posts the exit, and buys nothing outside the session or while paused", async () => {
      const { d, known, broker, alerts, refresh } = await setup({ live: true })
      broker.setPrice("AAPL", 200)
      await actOnStockAnswer(d, answer([decision()]), ep("e1"), known)
      await refresh()
      expect(await bookText(d)).toContain("- AAPL: 2 shares at 200.00")
      const [sold] = await actOnStockAnswer(d, answer([decision({ action: "sell", sell_pct: 100 })]), ep("e2"), known)
      expect(sold).toMatchObject({ outcome: "filled", detail: "sold 2 of 2 shares" })
      expect(alerts.map((x) => [x.title, x.path])).toContainEqual(["Agent sold AAPL", "/agent/e2"])
      const [paused] = await actOnStockAnswer(d, answer([decision({ symbol: "SPY" })]), { ...ep("e3"), entriesPaused: "entries paused: the model is slow" }, known)
      expect(paused).toMatchObject({ outcome: "blocked", detail: "entries paused: the model is slow" })
      current = null
      const [closed] = await actOnStockAnswer(d, answer([decision({ symbol: "SPY" })]), ep("e4"), known)
      expect(closed).toMatchObject({ outcome: "blocked", detail: expect.stringContaining("outside the regular session") })
    })

    it("buys an option only from a menu it loaded in the same episode", async () => {
      const { d, ctx, known, broker } = await setup({ live: true })
      prices.NVDA = 142
      broker.setPrice("NVDA", 142)
      ctx.prices.onTrade("NVDA", 142, Date.now())
      broker.listContract(NVDA_CALL_150, { bid: 0.9, ask: 0.96, delta: 0.35 })
      const buy = decision({
        symbol: "NVDA",
        action: "buy_option",
        allocation_pct: null,
        conviction: 8,
        horizon: "multi_day",
        option: { strategy: "long_call", long_leg: NVDA_CALL_150, short_leg: null, premium_pct: 2, stop_loss_pct: null, take_profit_pct: null },
      })
      const [refused] = await actOnStockAnswer(d, answer([buy]), ep("e1"), known)
      expect(refused).toMatchObject({ outcome: "rejected" })
      const menu = stockAgentTools(d).find((t) => t.name === "option_menu")!
      expect(await menu.run({ symbol: "NVDA" } as never, { episodeId: "e2", urls: new Set(), signal: new AbortController().signal })).toContain(NVDA_CALL_150)
      const [bought] = await actOnStockAnswer(d, answer([buy]), ep("e2"), known)
      expect(bought).toMatchObject({ outcome: "filled", detail: expect.stringMatching(/^bought 1 contract/) })
      expect(await ctx.col.optionPositions.countDocuments({ underlying: "NVDA", status: "open" })).toBe(1)
      // The menu was the episode's alone.
      expect(d.offered.size).toBe(0)
    })

    it("keeps options out of the shadow book", async () => {
      const { d, known } = await setup()
      const [a] = await actOnStockAnswer(d, answer([decision({ action: "buy_option", option: { strategy: "long_call", long_leg: NVDA_CALL_150, short_leg: null, premium_pct: 2, stop_loss_pct: null, take_profit_pct: null } })]), ep("e1"), known)
      expect(a).toMatchObject({ outcome: "not_applicable", detail: expect.stringContaining("level auto") })
      expect(await stockAgentTools(d).find((t) => t.name === "option_menu")!.run({ symbol: "AAPL" } as never, { episodeId: "e1", urls: new Set(), signal: new AbortController().signal })).toMatch(/^options are traded only at level auto/)
    })
  })

  it("puts each subject's latest news in the brief, fenced, or says there is none", async () => {
    const { d, ctx } = await setup()
    const wake = { subject: "AAPL", priority: 1 as const, salience: 70, observations: [] }
    expect((await stockBrief(d, wake)).text).toContain("- news: nothing in our feeds about it in the last 24 h")
    await ctx.col.wireItems.insertOne({
      _id: "beef0000beef0000",
      cluster_id: "beef0000beef0000",
      source: "rss:businesswire",
      tier: 1,
      kind: "news",
      category: "earnings",
      title: "Apple beats on services revenue",
      summary: null,
      url: "https://www.businesswire.com/apple",
      domain: "businesswire.com",
      symbols: ["AAPL"],
      published_at: new Date(),
      first_seen_at: new Date(),
      polarity: 1,
      severity: 64,
      severity_parts: {},
      confirmations: [],
      price_at_seen: {},
      meta: {},
      notable: false,
      notable_reasons: [],
      expires_at: new Date(Date.now() + 86_400_000),
    })
    const { text, urls } = await stockBrief(d, wake)
    expect(text).toMatch(/SUBJECT AAPL\n- 200; technicals: use the tools\n- news in our feeds, last 24 h, most severe first:\n<untrusted source="wire">\nbeef0000beef .*Apple beats on services revenue/)
    expect(urls).toEqual(["https://www.businesswire.com/apple"])
  })

  it("answers technicals from Alpaca's bars and quotes from live prices", async () => {
    const { d } = await setup()
    const tools = stockAgentTools(d)
    const ctx = { episodeId: "e1", urls: new Set<string>(), signal: new AbortController().signal }
    expect(await tools.find((t) => t.name === "quote")!.run({ symbol: "AAPL" } as never, ctx)).toBe("AAPL: 200, change n/a, from the price layers.")
    const technicals = await tools.find((t) => t.name === "technicals")!.run({ symbol: "AAPL" } as never, ctx)
    expect(technicals).toContain("AAPL at 200.")
    expect(technicals).toContain("Daily: no bars.")
  })
})
