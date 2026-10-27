import type { Bar, NewsItem } from "@mb/stock-core/alpaca"
import type { Phase } from "@mb/stock-core/settings"
import { formatTime, marketDay, marketTime } from "@mb/stock-core/time"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineContext } from "../../src/bot/context"
import type { Session } from "../../src/bot/session"
import type { EventBus } from "../../src/bus/event-bus"
import { buildContext as build } from "../../src/market/context"
import { dailyTechnicals, intradayTechnicals } from "../../src/market/indicators"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import {
  afterOpen,
  alpacaOrder,
  bar,
  CLOSE,
  dailyStats,
  DAY,
  decision,
  decisionDoc,
  fill,
  planDoc,
  report,
  reportDoc,
  session,
  optionPositionDoc,
  watchItem,
} from "../helpers/factories"

const NOW = afterOpen(90) // 11:00 ET
const testDb = useTestDb()
let broker: FakeBroker
let ctx: EngineContext
let bus: EventBus
const collections = async () => testDb.col
const buildContext = async (phase: Phase, s: Session, now: Date, requested: string[] = []) => (await build(ctx, phase, s, { now, requested })).context

const news = (id: number, symbols: string[], at: string, headline = `headline ${id}`): NewsItem => ({
  id,
  headline,
  summary: "",
  source: "benzinga",
  url: `https://news.test/${id}`,
  symbols,
  created_at: at,
})

const nvdaIntraday: Bar[] = Array.from({ length: 18 }, (_, i) => bar(new Date(Date.UTC(2026, 9, 26, 13, 30 + i * 5)).toISOString(), 130 + i * 0.6, { v: 1_000 + i }))
const nvdaDaily: Bar[] = Array.from({ length: 25 }, (_, i) => bar(new Date(Date.UTC(2026, 8, 18 + i, 20)).toISOString(), 110 + i, { h: 111 + i, l: 109 + i }))

/** A realistic mid-morning state: two positions, a briefing, one earlier cycle, history and news. */
const seedDay = async () => {
  broker.lastEquity = 10_000
  broker.setPosition("NVDA", 10, 140, { avg: 130, lastday: 135 })
  broker.setPosition("AMD", 5, 150)
  for (const [s, p] of Object.entries({ SPY: 580, QQQ: 500, AAPL: 230, META: 600, TSLA: 250, SMCI: 40, INTC: 20, F: 4, PLTR: 30 })) broker.setPrice(s, p)
  broker.addOrder(
    alpacaOrder({
      symbol: "NVDA",
      side: "sell",
      type: "limit",
      order_class: "oco",
      qty: "10",
      limit_price: "150",
      status: "new",
      legs: [alpacaOrder({ symbol: "NVDA", side: "sell", type: "stop", order_class: "oco", qty: "10", stop_price: "130", status: "held" })],
    }),
  )
  broker.movers = {
    gainers: [
      { symbol: "SMCI", price: 40, change: 4.4, percent_change: 12.345 },
      { symbol: "BRK.B", price: 500, change: 25, percent_change: 5 },
      { symbol: "PENNY", price: 2, change: 1, percent_change: 50 },
      { symbol: "WARRANTW", price: 10, change: 1, percent_change: 11 },
    ],
    losers: [{ symbol: "INTC", price: 20, change: -1.4, percent_change: -6.789 }],
  }
  broker.mostActives = {
    most_actives: [
      { symbol: "F", volume: 1_000, trade_count: 10 },
      { symbol: "PLTR", volume: 900, trade_count: 9 },
      { symbol: "BRK.B", volume: 800, trade_count: 8 },
      { symbol: "NVDA", volume: 700, trade_count: 7 },
    ],
  }
  broker.bars["5Min"] = { NVDA: [...nvdaIntraday, bar("11:05", 999)] }
  broker.bars["1Day"] = { NVDA: nvdaDaily }
  broker.news = [
    news(1, ["NVDA"], "2026-10-26T14:30:00Z", "Nvidia extends rally"),
    news(2, ["SPY", "QQQ", "DIA", "IWM", "XLK", "SMH", "XLF", "XLE"], "2026-10-26T14:50:00Z", "Stocks climb"),
    news(3, ["AMD"], "2026-10-26T11:00:00Z", "Too old"),
  ]

  const db = await collections()
  await db.plans.insertOne(planDoc("NVDA", { stop_loss: 130, take_profit: 150, horizon: "intraday", thesis: "AI capex", invalidation: "Loses 135", opened_at: afterOpen(20) }))
  await db.reports.insertMany([
    reportDoc({
      phase: "premarket",
      created_at: afterOpen(-60),
      report: report({ headline: "Chips lead", summary: "Futures up.", market: { ...report().market, stance: "aggressive" }, watchlist: [watchItem("TSLA"), watchItem("NVDA")] }),
    }),
    reportDoc({ phase: "intraday", created_at: afterOpen(60), report: report({ headline: "Holding NVDA", next_focus: "NVDA 145", watchlist: [watchItem("AAPL"), watchItem("META")] }) }),
    reportDoc({ phase: "postmarket", trading_day: "2026-10-23", created_at: new Date("2026-10-23T20:10:00Z"), report: report({ lessons: ["Wait for VWAP"] }) }),
    reportDoc({ phase: "postmarket", trading_day: "2026-10-22", created_at: new Date("2026-10-22T20:10:00Z"), report: report({ lessons: ["Size down"] }) }),
  ])
  await db.dailyStats.insertMany([
    dailyStats("2026-10-26", { pnl: 999 }),
    dailyStats("2026-10-23", { pnl: 50, pnl_pct: 0.5, spy_pct: 0.3 }),
    dailyStats("2026-10-22", { pnl: -20, pnl_pct: -0.2 }),
    dailyStats("2026-10-21", { pnl: 10, pnl_pct: 0.1 }),
  ])
  await db.decisions.insertMany([
    decisionDoc({ symbol: "NVDA", action: "buy", status: "executed", reason: "bought 10 shares", created_at: afterOpen(20), request: decision({ symbol: "NVDA" }) }),
    decisionDoc({ symbol: "AAPL", action: "sell", status: "executed", reason: "sold 5 of 5 shares", created_at: afterOpen(40), request: decision({ symbol: "AAPL", action: "sell" }) }),
    decisionDoc({ symbol: "TSLA", action: "buy", status: "rejected", reason: "conviction 5 < 6", created_at: afterOpen(41), request: decision({ symbol: "TSLA" }) }),
    decisionDoc({ symbol: "META", action: "buy", status: "executed", trading_day: "2026-10-23", created_at: new Date("2026-10-23T15:00:00Z") }),
  ])
  await db.orders.insertMany([
    fill("NVDA", "buy", 10, 130, afterOpen(20), { decision_id: "d1" }),
    fill("AAPL", "buy", 5, 220, "2026-10-23T15:00:00Z"),
    fill("AAPL", "sell", 5, 230, afterOpen(40)),
  ])
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW })
  broker = fakeBroker()
  ;({ ctx, bus } = await makeCtx(testDb.col, broker))
})

afterEach(async () => {
  vi.useRealTimers()
  await bus.stop()
})

describe("buildContext: a mid-session cycle", () => {
  beforeEach(seedDay)

  it("describes the time, session and risk state", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx).toMatchObject({ generated_at: NOW.toISOString(), now_et: "11:00", trading_day: DAY, phase: "intraday" })
    expect(ctx.session).toEqual({ open_et: "09:30", close_et: "16:00", is_open: true, early_close: false, minutes_to_open: -90, minutes_to_close: 300 })
    expect(ctx.risk).toMatchObject({
      equity: 10_100,
      cash: 7_950,
      day_pnl: 100,
      day_pnl_pct: 1,
      deployable_cash: 7_445,
      open_positions: 2,
      trades_today: 2, // only executed buys/sells from today
      trades_remaining: 28,
      min_conviction: 6,
      max_new_buys_this_cycle: 3,
      rebuy_cooldown_minutes: 30,
    })
  })

  it("enriches positions with their plans and exit-order status", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.positions).toEqual([
      {
        symbol: "NVDA",
        qty: 10,
        avg_entry: 130,
        price: 140,
        market_value: 1_400,
        unrealized_pl: 100,
        unrealized_pl_pct: 7.69,
        today_pl_pct: 3.7,
        stop_loss: 130,
        take_profit: 150,
        horizon: "intraday",
        thesis: "AI capex",
        invalidation: "Loses 135",
        opened_at_et: formatTime(afterOpen(20)),
        opened_on: marketDay(afterOpen(20)),
        has_exit_orders: true,
      },
      {
        symbol: "AMD",
        qty: 5,
        avg_entry: 150,
        price: 150,
        market_value: 750,
        unrealized_pl: 0,
        unrealized_pl_pct: 0,
        today_pl_pct: 0,
        stop_loss: null,
        take_profit: null,
        horizon: null,
        thesis: null,
        invalidation: null,
        opened_at_et: null,
        opened_on: null,
        has_exit_orders: false,
      },
    ])
    expect(ctx.open_orders).toEqual([
      { symbol: "NVDA", side: "sell", type: "limit", qty: 10, limit_price: 150, stop_price: null, status: "new" },
      { symbol: "NVDA", side: "sell", type: "stop", qty: 10, limit_price: null, stop_price: 130, status: "held" },
    ])
  })

  it("focuses on held, watchlist and mover symbols, with every tag", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.instruments.map((i) => [i.symbol, i.tags])).toEqual([
      ["NVDA", ["held", "watchlist"]],
      ["AMD", ["held"]],
      ["AAPL", ["watchlist"]],
      ["META", ["watchlist"]],
      ["TSLA", ["watchlist"]],
      ["SMCI", ["top_mover"]],
      ["INTC", ["top_mover"]],
    ])
  })

  it("attaches quotes and technicals computed from the bars", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    const nvda = ctx.instruments.find((i) => i.symbol === "NVDA")!
    expect(nvda.quote).toEqual({
      symbol: "NVDA",
      price: 140,
      change_pct: 3.7,
      prev_close: 135,
      open: 135,
      high: 140,
      low: 135,
      day_vwap: 140,
      iex_volume: 10_000,
      last_trade_et: formatTime(NOW),
    })
    // Bars after "now" are never requested.
    expect(nvda.intraday).toEqual(intradayTechnicals(nvdaIntraday))
    expect(nvda.daily).toEqual(dailyTechnicals(nvdaDaily, 140))
    const amd = ctx.instruments.find((i) => i.symbol === "AMD")!
    expect(amd.intraday).toBeNull()
    expect(amd.daily).toBeNull()
  })

  it("requests today's 5-minute bars and 380 days of daily bars (a year of sessions for the 200-day average and 52-week high)", async () => {
    await buildContext("intraday", session(), NOW)
    const symbols = ["NVDA", "AMD", "AAPL", "META", "TSLA", "SMCI", "INTC", "SPY", "QQQ"]
    expect(broker.barRequests).toEqual([
      { symbols, timeframe: "5Min", start: session().open, end: NOW },
      { symbols, timeframe: "1Day", start: marketTime("2025-10-11", "00:00"), end: marketTime(DAY, "00:00") },
    ])
  })

  it("includes only benchmarks with a quote", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.benchmarks.map((b) => b.symbol)).toEqual(["SPY", "QQQ"])
  })

  it("keeps only liquid, plain-ticker movers", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.movers).toEqual({
      gainers: [{ symbol: "SMCI", price: 40, change_pct: 12.35 }],
      losers: [{ symbol: "INTC", price: 20, change_pct: -6.79 }],
      most_active: [
        { symbol: "PLTR", price: 30, change_pct: 0, iex_volume: 900 },
        { symbol: "NVDA", price: 140, change_pct: 3.7, iex_volume: 700 },
      ],
    })
  })

  it("merges symbol and market news, newest first, deduped", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.news).toEqual([
      { at_et: formatTime("2026-10-26T14:50:00Z"), symbols: ["SPY", "QQQ", "DIA", "IWM", "XLK", "SMH"], headline: "Stocks climb", source: "benzinga", url: "https://news.test/2" },
      { at_et: formatTime("2026-10-26T14:30:00Z"), symbols: ["NVDA"], headline: "Nvidia extends rally", source: "benzinga", url: "https://news.test/1" },
    ])
    const since = new Date(NOW.getTime() - 3 * 3_600_000)
    expect(broker.newsRequests).toEqual([
      { symbols: ["NVDA", "AMD", "AAPL", "META", "TSLA", "NVDA"], start: since, limit: 30 },
      { symbols: null, start: since, limit: 15 },
    ])
  })

  it("event scope: only held and requested symbols, no movers, watchlist or broker news", async () => {
    const { context } = await build(ctx, "intraday", session(), { now: NOW, requested: ["PLTR"], scope: "event" })
    expect(context.instruments.map((i) => [i.symbol, i.tags])).toEqual([
      ["PLTR", ["requested"]],
      ["NVDA", ["held"]],
      ["AMD", ["held"]],
    ])
    expect(context.movers).toEqual({ gainers: [], losers: [], most_active: [] })
    expect(context.news).toEqual([])
    expect(broker.newsRequests).toEqual([])
  })

  it("summarizes the morning briefing and the previous cycle", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.briefing).toEqual({
      headline: "Chips lead",
      summary: "Futures up.",
      stance: "aggressive",
      watchlist: [
        { symbol: "TSLA", setup: "breakout", trigger: "Breaks the opening range high.", stop_loss: 98, take_profit: 105, conviction: 7 },
        { symbol: "NVDA", setup: "breakout", trigger: "Breaks the opening range high.", stop_loss: 98, take_profit: 105, conviction: 7 },
      ],
    })
    expect(ctx.previous_cycle).toEqual({ at_et: formatTime(afterOpen(60)), phase: "intraday", headline: "Holding NVDA", next_focus: "NVDA 145" })
  })

  it("lists today's decisions and fills with realized P&L", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.today.decisions).toEqual([
      { at_et: formatTime(afterOpen(20)), symbol: "NVDA", action: "buy", status: "executed", reason: "bought 10 shares" },
      { at_et: formatTime(afterOpen(40)), symbol: "AAPL", action: "sell", status: "executed", reason: "sold 5 of 5 shares" },
      { at_et: formatTime(afterOpen(41)), symbol: "TSLA", action: "buy", status: "rejected", reason: "conviction 5 < 6" },
    ])
    expect(ctx.today.fills).toEqual([
      { at_et: formatTime(afterOpen(20)), symbol: "NVDA", side: "buy", qty: 10, price: 130, role: "entry", realized_pnl: null },
      { at_et: formatTime(afterOpen(40)), symbol: "AAPL", side: "sell", qty: 5, price: 230, role: "exit", realized_pnl: 50 },
    ])
    expect(ctx.today.realized_pnl).toBe(50)
  })

  it("remembers recent days and their lessons", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.memory).toEqual({
      recent_days: [
        { day: "2026-10-23", pnl: 50, pnl_pct: 0.5, spy_pct: 0.3, lessons: ["Wait for VWAP"] },
        { day: "2026-10-22", pnl: -20, pnl_pct: -0.2, spy_pct: null, lessons: ["Size down"] },
        { day: "2026-10-21", pnl: 10, pnl_pct: 0.1, spy_pct: null, lessons: [] },
      ],
      profitable_days: 2,
      total_days: 3,
    })
  })
})

describe("buildContext: other phases and edge cases", () => {
  it("works on a quiet first cycle with nothing stored", async () => {
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx).toMatchObject({
      positions: [],
      open_orders: [],
      instruments: [],
      benchmarks: [],
      news: [],
      briefing: null,
      previous_cycle: null,
      today: { decisions: [], fills: [], realized_pnl: 0 },
      memory: { recent_days: [], profitable_days: 0, total_days: 0 },
    })
    // SPY and QQQ bars are always requested for the tape.
    expect(broker.barRequests[0].symbols).toEqual(["SPY", "QQQ"])
  })

  it("skips intraday bars before the open and in premarket, and looks back 16h for news", async () => {
    const before = afterOpen(-45)
    vi.setSystemTime(before)
    const ctx = await buildContext("premarket", session(), before)
    expect(broker.barRequests.map((r) => r.timeframe)).toEqual(["1Day"])
    expect(ctx.session).toMatchObject({ is_open: false, minutes_to_open: 45 })
    expect(broker.newsRequests[0].start).toEqual(new Date(before.getTime() - 16 * 3_600_000))

    broker.barRequests.length = 0
    await buildContext("premarket", session(), NOW)
    expect(broker.barRequests.map((r) => r.timeframe)).toEqual(["1Day"])
  })

  it("stops intraday bars at the bell after the close", async () => {
    const after = new Date(CLOSE.getTime() + 30 * 60_000)
    vi.setSystemTime(after)
    const ctx = await buildContext("postmarket", session(), after)
    expect(broker.barRequests[0]).toMatchObject({ timeframe: "5Min", end: CLOSE })
    expect(ctx.session).toMatchObject({ is_open: false, minutes_to_close: -30 })
    expect(broker.newsRequests[0].start).toEqual(new Date(after.getTime() - 6 * 3_600_000))
  })

  it("handles a holiday session", async () => {
    const ctx = await buildContext("premarket", { ...session(), is_trading_day: false, open: null, close: null, open_et: null, close_et: null }, NOW)
    expect(ctx.session).toEqual({ open_et: null, close_et: null, is_open: false, early_close: false, minutes_to_open: null, minutes_to_close: null })
    expect(broker.barRequests.map((r) => r.timeframe)).toEqual(["1Day"])
  })

  it("uses the last close as the reference before today's bar exists", async () => {
    broker.snapshots.set("SPY", {
      latestTrade: { p: 581, t: NOW.toISOString() },
      dailyBar: bar("2026-10-23T04:00:00Z", 578, { o: 570, h: 579, l: 569 }),
      prevDailyBar: bar("2026-10-22T04:00:00Z", 575),
    })
    const [spy] = (await buildContext("premarket", session(), NOW)).benchmarks
    expect(spy).toMatchObject({ price: 581, prev_close: 578, change_pct: 0.52, open: null, high: null, low: null, day_vwap: null, iex_volume: null })
  })

  it("falls back to the daily close when there's no trade", async () => {
    broker.snapshots.set("SPY", { dailyBar: bar("2026-10-26T04:00:00Z", 579, { o: 575 }), prevDailyBar: bar("2026-10-23T04:00:00Z", 570) })
    const [spy] = (await buildContext("intraday", session(), NOW)).benchmarks
    expect(spy).toMatchObject({ price: 579, prev_close: 570, open: 575, change_pct: 1.58, last_trade_et: null })
  })

  it("survives failing optional data sources", async () => {
    await seedDay()
    broker.movers = new Error("screener 500")
    broker.mostActives = new Error("screener 500")
    vi.mocked(broker.client.getBars).mockRejectedValue(new Error("bars 500"))
    vi.mocked(broker.client.getNews).mockRejectedValue(new Error("news 500"))
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.movers).toEqual({ gainers: [], losers: [], most_active: [] })
    expect(ctx.news).toEqual([])
    expect(ctx.instruments.every((i) => i.intraday === null && i.daily === null)).toBe(true)
    expect(ctx.positions).toHaveLength(2)
  })

  it("fails when the broker's core data is unavailable", async () => {
    vi.mocked(broker.client.getAccount).mockRejectedValue(new Error("401 unauthorized"))
    await expect(buildContext("intraday", session(), NOW)).rejects.toThrow("401 unauthorized")
  })

  it("caps the watchlist, movers and news", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `W${String.fromCharCode(65 + i)}`)
    await (await collections()).reports.insertOne(reportDoc({ report: report({ watchlist: many.map((s) => watchItem(s)) }) }))
    broker.movers = {
      gainers: Array.from({ length: 12 }, (_, i) => ({ symbol: `G${String.fromCharCode(65 + i)}`, price: 10, change: 1, percent_change: 10 })),
      losers: Array.from({ length: 8 }, (_, i) => ({ symbol: `L${String.fromCharCode(65 + i)}`, price: 10, change: -1, percent_change: -10 })),
    }
    broker.news = Array.from({ length: 50 }, (_, i) => news(i, [], new Date(NOW.getTime() - i * 60_000).toISOString()))
    const ctx = await buildContext("intraday", session(), NOW)
    expect(ctx.instruments.filter((i) => i.tags.includes("watchlist"))).toHaveLength(15)
    expect(ctx.instruments.filter((i) => i.tags.includes("top_mover"))).toHaveLength(8)
    expect(ctx.movers.gainers).toHaveLength(8)
    expect(ctx.movers.losers).toHaveLength(5)
    expect(ctx.news).toHaveLength(15) // the market feed is capped at 15
  })
})

describe("buildContext: options", () => {
  const CALL = "NVDA261120C00140000"
  const CALL_150 = "NVDA261120C00150000"
  const PUT = "NVDA261120P00130000"

  beforeEach(() => {
    broker.setPrice("NVDA", 140)
    broker.listContract(CALL, { bid: 6, ask: 6.2, delta: 0.52, iv: 0.45 })
    broker.listContract(CALL_150, { bid: 2.4, ask: 2.5, delta: 0.3, iv: 0.43 })
    broker.listContract(PUT, { bid: 3.9, ask: 4.1, delta: -0.32, iv: 0.47 })
    // Too wide a market to be offered.
    broker.listContract("NVDA261120C00160000", { bid: 0.5, ask: 1.5, delta: 0.15 })
  })

  it("offers a menu of liquid contracts for requested and watched stocks, and returns them by symbol", async () => {
    const built = await build(ctx, "intraday", session(), { now: NOW, requested: ["NVDA"] })
    expect(built.context.requested).toEqual(["NVDA"])
    expect(built.context.instruments[0]).toMatchObject({ symbol: "NVDA", tags: ["requested"] })
    const chain = built.context.options.chains.find((c) => c.underlying === "NVDA")!
    expect(chain.price).toBe(140)
    expect(chain.contracts.map((c) => c.symbol)).toEqual([CALL, CALL_150, PUT])
    expect(chain.contracts[0]).toMatchObject({ type: "call", strike: 140, expiration: "2026-11-20", dte: 25, bid: 6, ask: 6.2, mid: 6.1, spread_pct: 3.3, delta: 0.52, iv: 0.45, open_interest: 5_000 })
    expect([...built.chains.keys()].sort()).toEqual([CALL, CALL_150, PUT].sort())
    expect(built.context.options).toMatchObject({ enabled: true, new_positions_allowed: true, open_positions: 0, max_premium_per_trade_pct: 2 })
  })

  it("doesn't load chains in planning phases or when options are off", async () => {
    expect((await build(ctx, "premarket", session(), { now: NOW, requested: ["NVDA"] })).context.options.chains).toEqual([])
    ctx.settings.current.options.enabled = false
    const off = await build(ctx, "intraday", session(), { now: NOW, requested: ["NVDA"] })
    expect(off.context.options).toMatchObject({ enabled: false, new_positions_allowed: false, chains: [], notes: ["Options trading is disabled."] })
    expect(broker.client.getOptionContracts).not.toHaveBeenCalled()
  })

  it("lists open options positions with their marks", async () => {
    await testDb.col.optionPositions.insertOne(
      optionPositionDoc({ mark: { value: 7, exit_value: 6.9, pnl_usd: 200, pnl_pct: 40, underlying_price: 141, delta: 0.55, at: NOW } }),
    )
    const c = await buildContext("intraday", session(), NOW)
    expect(c.options.positions).toEqual([
      expect.objectContaining({ underlying: "NVDA", strategy: "long_call", contracts: 1, paid: 5, value: 7, pnl_usd: 200, pnl_pct: 40, dte: 25, underlying_price: 141, legs: [`long NVDA Nov 20 '26 140C (${CALL})`] }),
    ])
    expect(c.options.premium_open_usd).toBe(700)
    expect(c.instruments.find((i) => i.symbol === "NVDA")?.tags).toContain("options_held")
  })
})
