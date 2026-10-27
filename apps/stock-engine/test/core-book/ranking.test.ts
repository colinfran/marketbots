import type { AlpacaAsset, Bar } from "@mb/stock-core/alpaca"
import type { CoreMetrics } from "@mb/stock-core/core-book"
import { describe, expect, it } from "vitest"
import { coreCandidates, coreMetrics, passesTrend, productExclusion, rankCandidates } from "../../src/core-book/ranking"
import { bar } from "../helpers/factories"

/** One daily bar per calendar day from 2025-08-01 (dates only have to match between symbols). */
const daily = (closes: number[], extra: (i: number, c: number) => Partial<Bar> = () => ({})) =>
  closes.map((c, i) => bar(new Date(Date.UTC(2025, 7, 1 + i, 4)).toISOString(), c, extra(i, c)))

const asset = (symbol: string, name: string, overrides: Partial<AlpacaAsset> = {}): AlpacaAsset => ({ symbol, name, class: "us_equity", exchange: "NASDAQ", status: "active", tradable: true, fractionable: true, ...overrides })

describe("productExclusion", () => {
  it.each([
    ["ProShares UltraPro QQQ"],
    ["Direxion Daily Semiconductor Bull 3X Shares"],
    ["GraniteShares 2x Long NVDA Daily ETF"],
    ["ProShares Short S&P500"],
    ["iPath Series B S&P 500 VIX Short-Term Futures ETN"],
    ["VolatilityShares -1x Short VIX Futures ETF"],
    ["YieldMax NVDA Option Income Strategy ETF"],
  ])("drops %s", (name) => {
    expect(productExclusion(asset("X", name))).toBe("leveraged, inverse, volatility or option-income product")
  })

  it.each([["SPDR S&P 500 ETF Trust"], ["iShares Russell 2000 ETF"], ["Global X Uranium ETF"], ["Ultra Clean Holdings, Inc. Common Stock"], ["NVIDIA Corporation Common Stock"]])("keeps %s", (name) => {
    expect(productExclusion(asset("X", name))).toBeNull()
  })

  it("drops what Alpaca doesn't list as an active, tradable US equity", () => {
    expect(productExclusion(undefined)).toBe("not an active, tradable US equity on Alpaca")
    expect(productExclusion(asset("X", "Halted Inc.", { tradable: false }))).toBe("not an active, tradable US equity on Alpaca")
  })
})

describe("coreCandidates", () => {
  const assets = new Map(
    [
      asset("NVDA", "NVIDIA Corporation Common Stock"),
      asset("TQQQ", "ProShares UltraPro QQQ"),
      asset("AAPL", "Apple Inc. Common Stock"),
      asset("MSFT", "Microsoft Corporation Common Stock"),
      asset("SPY", "SPDR S&P 500 ETF Trust"),
      asset("VIXY", "ProShares VIX Short-Term Futures ETF"),
      asset("AVGO", "Broadcom Inc. Common Stock"),
      asset("SOXL", "Direxion Daily Semiconductor Bull 3X Shares"),
    ].map((a) => [a.symbol, a]),
  )

  it("takes the top eligible universe names, benchmarks, theme tickers and holdings", () => {
    const { candidates, excluded } = coreCandidates({
      universe: ["NVDA", "TQQQ", "AAPL", "MSFT"],
      universeSize: 2,
      benchmarks: ["SPY", "VIXY"],
      themes: ["AI buildout: NVDA, AVGO, ZZZZ"],
      held: ["SOXL", "SPY"],
      assets,
    })
    expect(candidates).toEqual([
      { symbol: "NVDA", name: "NVIDIA Corporation Common Stock", sources: ["universe", "theme"], themes: ["AI buildout"] },
      // TQQQ is skipped, so the second universe slot goes to AAPL; MSFT is past the cut.
      { symbol: "AAPL", name: "Apple Inc. Common Stock", sources: ["universe"], themes: [] },
      { symbol: "SPY", name: "SPDR S&P 500 ETF Trust", sources: ["benchmark", "held"], themes: [] },
      { symbol: "AVGO", name: "Broadcom Inc. Common Stock", sources: ["theme"], themes: ["AI buildout"] },
      // A holding is always reviewed, whatever it is.
      { symbol: "SOXL", name: "Direxion Daily Semiconductor Bull 3X Shares", sources: ["held"], themes: [] },
    ])
    expect(excluded).toEqual([
      { symbol: "TQQQ", reason: "leveraged, inverse, volatility or option-income product" },
      { symbol: "VIXY", reason: "leveraged, inverse, volatility or option-income product" },
      { symbol: "ZZZZ", reason: "not an active, tradable US equity on Alpaca" },
    ])
  })
})

describe("coreMetrics", () => {
  // 300 sessions closing 100, 101 … 399 against a flat SPY at 400.
  const closes = Array.from({ length: 300 }, (_, i) => 100 + i)
  const spy = daily(closes.map(() => 400))

  it("computes averages, returns, relative strength, the 52-week high and liquidity", () => {
    const m = coreMetrics("UP", daily(closes, () => ({ v: 1_000 })), spy, "Up Corp")!
    expect(m).toMatchObject({
      symbol: "UP",
      name: "Up Corp",
      price: 399,
      sessions: 300,
      sma50: 374.5, // mean of 350 … 399
      sma200: 299.5, // mean of 200 … 399
      pct_from_sma50: 6.54,
      pct_from_sma200: 33.22,
      return_3m_pct: 18.75, // 336 → 399
      return_6m_pct: 46.15, // 273 → 399
      return_12m_pct: 171.43, // 147 → 399
      return_12_1_pct: 157.14, // 147 → 378: the last month left out
      rel_spy_3m_pct: 18.75, // SPY was flat
      rel_spy_6m_pct: 46.15,
      rel_spy_12m_pct: 171.43,
      from_52w_high_pct: 0,
      max_drawdown_1y_pct: 0,
      dollar_volume_20d: 389_500, // mean close of the last 20 (389.5) × 1,000 shares
    })
    const logs = closes.slice(-61).flatMap((c, i, all) => (i ? [Math.log(c / all[i - 1])] : []))
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length
    const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1))
    expect(m.volatility_60d_pct).toBe(Math.round(sd * Math.sqrt(252) * 10_000) / 100)
  })

  it("measures SPY between the same two days", () => {
    const rising = daily(closes.map((_, i) => 400 + i)) // SPY 400 → 699
    const m = coreMetrics("UP", daily(closes), rising)!
    expect(m.rel_spy_3m_pct).toBe(Math.round((18.75 - (699 / 636 - 1) * 100) * 100) / 100)
  })

  it("measures the worst drawdown and the distance from the high", () => {
    const upDown = [...Array.from({ length: 200 }, (_, i) => 100 + i), ...Array.from({ length: 60 }, (_, i) => 299 - i)] // peak 299, ends 240
    const m = coreMetrics("DD", daily(upDown), spy)!
    expect(m.max_drawdown_1y_pct).toBe(-19.73) // 299 → 240
    expect(m.from_52w_high_pct).toBe(-19.73)
  })

  it("leaves what needs more history empty", () => {
    const m = coreMetrics("NEW", daily(closes.slice(0, 120)), spy)!
    expect(m).toMatchObject({ sessions: 120, sma50: 194.5, sma200: null, return_3m_pct: 40.38, return_6m_pct: null, return_12_1_pct: null, from_52w_high_pct: null, max_drawdown_1y_pct: null })
    expect(coreMetrics("NONE", [], spy)).toBeNull()
  })
})

describe("passesTrend and rankCandidates", () => {
  const row = (symbol: string, o: Partial<CoreMetrics>) => ({
    ...(coreMetrics(symbol, daily([100]), undefined) as CoreMetrics),
    price: 120,
    sma50: 110,
    sma200: 100,
    sources: ["universe" as const],
    themes: [],
    ...o,
  })

  it("needs price above the 200-day average and the 50-day above it", () => {
    expect(passesTrend({ price: 120, sma50: 110, sma200: 100 })).toBe(true)
    expect(passesTrend({ price: 95, sma50: 110, sma200: 100 })).toBe(false)
    expect(passesTrend({ price: 120, sma50: 99, sma200: 100 })).toBe(false)
    expect(passesTrend({ price: 120, sma50: 110, sma200: null })).toBe(false)
  })

  it("scores risk-adjusted 12-1 and 6-month momentum by percentile among names in a trend", () => {
    const rows = rankCandidates([
      row("CCC", { return_12_1_pct: 40, return_6m_pct: 10, volatility_60d_pct: 40 }), // 1.0, 0.25
      row("AAA", { return_12_1_pct: 30, return_6m_pct: 20, volatility_60d_pct: 20 }), // 1.5, 1.0
      row("ZZZ", { price: 90, return_12_1_pct: 90, return_6m_pct: 90, volatility_60d_pct: 10 }), // below its 200-day
      row("BBB", { return_12_1_pct: 20, return_6m_pct: 20, volatility_60d_pct: 20 }), // 1.0, 1.0
      // 3% on 5% volatility would be 0.6 a year; measured at the 15% floor it's 0.2.
      row("LOW", { return_12_1_pct: 3, return_6m_pct: 3, volatility_60d_pct: 5 }),
      row("NEW", { return_12_1_pct: null, return_6m_pct: 10, volatility_60d_pct: 10 }),
    ])
    expect(rows.map((r) => [r.symbol, r.trend_ok, r.score, r.rank])).toEqual([
      ["AAA", true, 91.7, 1],
      ["BBB", true, 66.7, 2],
      ["CCC", true, 41.7, 3],
      ["LOW", true, 0, 4],
      ["NEW", true, null, null],
      ["ZZZ", false, null, null],
    ])
  })
})
