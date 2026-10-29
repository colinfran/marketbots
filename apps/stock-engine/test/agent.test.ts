import type { Observation } from "@mb/core/agent"
import type { StockAgentAnswer } from "@mb/stock-core/agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { actOnStockAnswer } from "../src/agent/act"
import { bookText, createShadowBook, type StockAgentDeps } from "../src/agent/book"
import { StockObserver } from "../src/agent/observe"
import { stockAgentTools } from "../src/agent/tools"
import type { Session } from "../src/bot/session"
import { fakeBroker } from "./helpers/broker"
import { makeCtx } from "./helpers/ctx"
import { useTestDb } from "./helpers/db"
import { afterOpen, beforeClose, OPEN, session } from "./helpers/factories"

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
  ...over,
})
const answer = (decisions: Dec[]): StockAgentAnswer => ({ decisions, watches: [], cancel_watches: [], notes: [], reply: "ok" })

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

  const setup = async () => {
    const broker = fakeBroker()
    const { ctx } = await makeCtx(db.col, broker)
    const d: StockAgentDeps = { ctx, shadow: createShadowBook(ctx), history: null, session: () => current, price: (s) => prices[s] ?? null }
    const known = (s: string) => s in prices
    return { d, ctx, known, broker }
  }

  it("buys in the regular session through the cycle's buy rules, at the envelope's share", async () => {
    const { d, known } = await setup()
    const [a] = await actOnStockAnswer(d, answer([decision()]), { id: "e1" }, known)
    // 10% of $10,000 buys 5 shares; the envelope's half is $500: 2 shares at the ask plus 5 bps.
    expect(a).toMatchObject({ symbol: "AAPL", action: "buy", outcome: "filled", detail: expect.stringMatching(/^bought 2 at 200\.10/) })
    const [p] = await d.shadow.open()
    expect(p).toMatchObject({ symbol: "AAPL", qty: 2, stop_price: 196, take_profit_price: 210, horizon: "overnight", strategy: "breakout", conviction: 7, episode_id: "e1" })
  })

  it("buys only in the session, refuses what the cycle's rules refuse, and drops unknown tickers", async () => {
    const { d, known } = await setup()
    current = null
    const [closed] = await actOnStockAnswer(d, answer([decision()]), { id: "e1" }, known)
    expect(closed).toMatchObject({ outcome: "blocked", detail: expect.stringContaining("outside the regular session") })
    current = session()
    const out = await actOnStockAnswer(d, answer([decision({ conviction: 4 }), decision({ symbol: "ZZZZ" })]), { id: "e2" }, known)
    expect(out).toEqual([
      { symbol: "ZZZZ", action: "unknown", conviction: 0, outcome: "rejected", detail: "ZZZZ: not a ticker the agent may trade" },
      expect.objectContaining({ symbol: "AAPL", outcome: "rejected", detail: "conviction 4 < 6" }),
    ])
  })

  it("moves a held stop up but never down, and sells while the market is open", async () => {
    const { d, known } = await setup()
    await actOnStockAnswer(d, answer([decision()]), { id: "e1" }, known)
    vi.setSystemTime(afterOpen(120))
    const [up] = await actOnStockAnswer(d, answer([decision({ action: "adjust_exits", stop_loss: 198, take_profit: 212 })]), { id: "e2" }, known)
    expect(up).toMatchObject({ outcome: "updated", detail: expect.stringContaining("stop 198, target 212") })
    const [down] = await actOnStockAnswer(d, answer([decision({ action: "adjust_exits", stop_loss: 190, take_profit: null })]), { id: "e3" }, known)
    expect(down.outcome).toBe("updated")
    expect((await d.shadow.open())[0].stop_price).toBe(198)
    const [sold] = await actOnStockAnswer(d, answer([decision({ action: "sell", sell_pct: 100 })]), { id: "e4" }, known)
    expect(sold).toMatchObject({ outcome: "filled", detail: "sold 2 at 199.90" })
    expect(await d.shadow.open()).toEqual([])
  })

  it("closes intraday positions before the bell and wakes for the session's phases", async () => {
    const { d, known } = await setup()
    await actOnStockAnswer(d, answer([decision({ horizon: "intraday" })]), { id: "e1" }, known)
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
