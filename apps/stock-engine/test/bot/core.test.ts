import { settle, useFakeClock } from "@mb/engine-kit/testing/timers"
import type { AlpacaAsset, Bar } from "@mb/stock-core/alpaca"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { marketTime } from "@mb/stock-core/time"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineContext } from "../../src/bot/context"
import { StockCore } from "../../src/bot/core"
import { coreCandidates, coreRegime, coreStats, coreTrendBroken, GEARED_NAME } from "../../src/bot/core-rules"
import type { EventBus } from "../../src/bus/event-bus"
import { SCAN_UNIVERSE_KEY } from "../../src/market/scan-universe"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx, type SentAlert } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { afterOpen, DAY, session } from "../helpers/factories"

const DAY_MS = 86_400_000
/** Midnight New York time on DAY: the plan uses bars before it. */
const END = marketTime(DAY, "00:00").getTime()

/** `n` daily bars ending the day before DAY, the close growing by `growth` a day around a ±0.8% daily swing, highs and lows 1% around it. */
const daily = (n: number, growth: number, start = 100): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const c = start * (1 + growth) ** i * (i % 2 === 0 ? 1.008 : 0.992)
    return { t: new Date(END - (n - i) * DAY_MS).toISOString(), o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000, vw: c, n: 1_000 }
  })

const last = (bars: Bar[]) => bars.at(-1)!.c

describe("the trend core's rules", () => {
  it("measures a stock from a year of daily bars, and needs at least 210 sessions", () => {
    expect(coreStats("AAPL", daily(200, 0.002))).toBeNull()
    const s = coreStats("AAPL", daily(260, 0.002))!
    expect(s.close).toBeGreaterThan(s.sma50)
    expect(s.sma50).toBeGreaterThan(s.sma200)
    expect(s.ret126Pct).toBeCloseTo((1.002 ** 126 - 1) * 100, 0)
    expect(s.atrPct).toBeGreaterThan(2)
    expect(s.atrPct).toBeLessThan(3.5)
    expect(s.rsi).toBeGreaterThan(50)
    expect(s.rsi).toBeLessThan(70)
    expect(s.strength).toBeCloseTo(s.ret126Pct / s.atrPct)
  })

  it("opens positions only while SPY is above its 200-day average", () => {
    expect(coreRegime(coreStats("SPY", daily(260, 0.001))).on).toBe(true)
    expect(coreRegime(coreStats("SPY", daily(260, -0.001)))).toMatchObject({ on: false, detail: expect.stringMatching(/^SPY -\d/) })
    expect(coreRegime(null).on).toBe(false)
  })

  it("ranks qualifying stocks by 6-month return per unit of volatility, with a 2-ATR stop inside the allowed range", () => {
    const stats = [coreStats("SLOW", daily(260, 0.001)), coreStats("FAST", daily(260, 0.003)), coreStats("DOWN", daily(260, -0.002)), coreStats("PENNY", daily(260, 0.002, 1))].flatMap((s) => (s ? [s] : []))
    const picks = coreCandidates(stats, DEFAULT_SETTINGS)
    expect(picks.map((p) => p.symbol)).toEqual(["FAST", "SLOW"])
    const fast = stats.find((x) => x.symbol === "FAST")!
    expect(picks[0].stop_pct).toBeCloseTo(2 * fast.atrPct, 1)
    expect(picks[0].signal).toMatch(/^Trend core: /)
    // A wild stock's 2 ATRs would pass the 8% maximum stop: it isn't a core stock at all (daily ATR over 6%).
    const wild = daily(260, 0.002).map((b) => ({ ...b, h: b.c * 1.07, l: b.c * 0.93 }))
    expect(coreCandidates([coreStats("WILD", wild)!], DEFAULT_SETTINGS)).toEqual([])
  })

  it("leaves out stocks far from their 52-week high and overbought ones", () => {
    const base = { symbol: "X", close: 70, sma50: 65, sma200: 60, high252: 100, ret126Pct: 10, atrPct: 2, rsi: 55, strength: 5 }
    // In an uptrend by its averages, but 30% under its 52-week high.
    expect(coreCandidates([base], DEFAULT_SETTINGS)).toEqual([])
    expect(coreCandidates([{ ...base, high252: 90 }], DEFAULT_SETTINGS).map((p) => p.symbol)).toEqual(["X"])
    expect(coreCandidates([{ ...base, high252: 90, rsi: 85 }], DEFAULT_SETTINGS)).toEqual([])
  })

  it("ends a trend below the 50-day average, and knows a geared fund by its name", () => {
    expect(coreTrendBroken({ close: 99, sma50: 100 })).toBe(true)
    expect(coreTrendBroken({ close: 101, sma50: 100 })).toBe(false)
    for (const name of ["Direxion Daily Semiconductor Bull 3X Shares", "ProShares UltraPro QQQ", "ProShares Ultra VIX Short-Term Futures ETF", "iPath S&P 500 VIX ETN", "AXS 1.5X NVDA Bear Daily ETF"]) expect(GEARED_NAME.test(name)).toBe(true)
    for (const name of ["iShares Semiconductor ETF", "NVIDIA Corporation", "SPDR S&P 500 ETF Trust", "Bullfrog AI Holdings"]) expect(GEARED_NAME.test(name)).toBe(false)
  })
})

describe("the trend core on the paper account", () => {
  const testDb = useTestDb()
  let broker: FakeBroker
  let ctx: EngineContext
  let bus: EventBus
  let alerts: SentAlert[]
  let paused: string | null
  let core: StockCore

  const asset = (symbol: string, name: string): AlpacaAsset => ({ symbol, name, class: "us_equity", exchange: "NASDAQ", status: "active", tradable: true, fractionable: true })

  beforeEach(async () => {
    useFakeClock(afterOpen(10))
    broker = fakeBroker()
    ;({ ctx, bus, alerts } = await makeCtx(testDb.col, broker))
    paused = null
    const bars = { SPY: daily(260, 0.001, 400), FAST: daily(260, 0.003), SLOW: daily(260, 0.001), DOWN: daily(260, -0.002), TQQQ: daily(260, 0.005) }
    broker.bars["1Day"] = bars
    broker.assetList = [asset("TQQQ", "ProShares UltraPro QQQ"), asset("FAST", "Fast Corp"), asset("SLOW", "Slow Corp"), asset("DOWN", "Down Corp")]
    for (const [symbol, b] of Object.entries(bars)) broker.setPrice(symbol, last(b))
    await testDb.col.cache.insertOne({ _id: SCAN_UNIVERSE_KEY, data: { day: DAY, built_at: new Date(), symbols: ["TQQQ", "FAST", "DOWN", "SLOW"], dollar_volume: {} }, fetched_at: new Date(), expires_at: new Date(Date.now() + DAY_MS) })
    core = new StockCore(ctx, { session: () => session(), entriesPaused: () => paused, busy: () => false, pauseMs: 0 })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await bus.stop()
  })

  const tick = (minutes: number) => {
    vi.setSystemTime(afterOpen(minutes))
    return settle(core.tick(afterOpen(minutes)))
  }

  it("plans the day from completed bars, leaving out geared funds, and acts 30 minutes after the open", async () => {
    await tick(10)
    expect(core.today).toMatchObject({ day: DAY, regime: { on: true }, broken: [] })
    expect(core.today!.picks.map((p) => p.symbol)).toEqual(["FAST", "SLOW"])
    expect(broker.barRequests.every((r) => r.end?.getTime() === END)).toBe(true)
    expect(broker.submitted).toEqual([])
    // A restart reuses the day's plan.
    const again = new StockCore(ctx, { session: () => session(), entriesPaused: () => null, busy: () => false, pauseMs: 0 })
    const requests = broker.barRequests.length
    await settle(again.tick(afterOpen(11)))
    expect(again.today?.picks.map((p) => p.symbol)).toEqual(["FAST", "SLOW"])
    expect(broker.barRequests.length).toBe(requests)
  })

  it("buys the picks with a market order and a plain stop, risking 1% of equity, and records rules decisions", async () => {
    await tick(10)
    await tick(35)
    const plans = await testDb.col.plans.find().sort({ _id: 1 }).toArray()
    expect(plans.map((p) => [p._id, p.book, p.take_profit, p.horizon])).toEqual([
      ["FAST", "core", null, "multi_day"],
      ["SLOW", "core", null, "multi_day"],
    ])
    const fast = plans[0]
    const price = last(broker.bars["1Day"]!.FAST)
    // $100 at risk over a ~4% stop is ~$2,500: the 20% position cap ($2,000) holds it.
    const shares = Number((await broker.getPositions()).find((p) => p.symbol === "FAST")!.qty)
    expect(shares * price).toBeGreaterThan(1_900)
    expect(shares * price).toBeLessThanOrEqual(2_000)
    expect(fast.trail_usd).toBeCloseTo(price - fast.stop_loss!, 1)
    expect(broker.submitted.filter((o) => o.symbol === "FAST").map((o) => [o.side, o.type])).toEqual([
      ["buy", "market"],
      ["sell", "stop"],
    ])
    const decisions = await testDb.col.decisions.find({ trigger_kind: "core" }).toArray()
    expect(decisions.map((d) => [d.symbol, d.action, d.status])).toEqual([
      ["FAST", "buy", "executed"],
      ["SLOW", "buy", "executed"],
    ])
    expect(decisions[0].checks.map((c) => c.name)).toEqual(["regime", "rules_entry", "size"])
    // Once a day.
    await tick(60)
    expect(await testDb.col.decisions.countDocuments()).toBe(2)
  })

  it("opens nothing while SPY is below its 200-day, while entries are paused, or in a stock sold within 72 h or with bad news", async () => {
    broker.bars["1Day"]!.SPY = daily(260, -0.001, 400)
    await tick(10)
    await tick(35)
    expect(broker.submitted).toEqual([])
    await testDb.col.cache.deleteMany({ _id: "core:plan" })

    paused = "entries paused by a breaker until the owner resumes them: drawdown"
    broker.bars["1Day"]!.SPY = daily(260, 0.001, 400)
    core = new StockCore(ctx, { session: () => session(), entriesPaused: () => paused, busy: () => false, pauseMs: 0 })
    await tick(35)
    expect(broker.submitted).toEqual([])

    paused = null
    core = new StockCore(ctx, { session: () => session(), entriesPaused: () => paused, busy: () => false, pauseMs: 0 })
    await testDb.col.orders.insertOne({ _id: "o1", symbol: "FAST", side: "sell", asset_class: "us_equity", filled_at: new Date(afterOpen(-60 * 20)) } as never)
    await testDb.col.wireItems.insertOne({ _id: "n1", symbols: ["SLOW"], polarity: -1, severity: 60, first_seen_at: afterOpen(-60) } as never)
    await tick(35)
    expect(broker.submitted).toEqual([])
  })

  it("sells a core position whose trend broke, and leaves the agent's alone", async () => {
    await testDb.col.plans.insertMany([
      { _id: "OLDCORE", decision_id: null, stop_loss: 80, take_profit: null, horizon: "multi_day", setup: "momentum", thesis: "t", invalidation: "i", opened_at: new Date(), updated_at: new Date(), book: "core" },
      { _id: "AGENTS", decision_id: null, stop_loss: 80, take_profit: 120, horizon: "multi_day", setup: "momentum", thesis: "t", invalidation: "i", opened_at: new Date(), updated_at: new Date() },
    ])
    // Up for most of a year, then 15% down in three weeks: under its 50-day average.
    const broke = [...daily(240, 0.002), ...daily(20, -0.008, 100 * 1.002 ** 240)]
    broker.bars["1Day"]!.OLDCORE = broke
    broker.bars["1Day"]!.AGENTS = broke
    broker.setPosition("OLDCORE", 10, last(broke))
    broker.setPosition("AGENTS", 10, last(broke))
    await tick(10)
    expect(core.today?.broken).toEqual(["OLDCORE"])
    await tick(35)
    expect(broker.holdings.has("OLDCORE")).toBe(false)
    expect(broker.holdings.has("AGENTS")).toBe(true)
    expect(await testDb.col.plans.findOne({ _id: "OLDCORE" })).toBeNull()
    expect(await testDb.col.decisions.findOne({ symbol: "OLDCORE" })).toMatchObject({ action: "sell", status: "executed", trigger_kind: "core" })
    expect(alerts).toContainEqual(expect.objectContaining({ level: "success", title: "Trend core sold OLDCORE" }))
  })
})
