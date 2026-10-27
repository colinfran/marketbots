import { describe, expect, it } from "vitest"
import type { Bar } from "@mb/stock-core/alpaca"
import { dailyTechnicals, intradayTechnicals, pctChange, round, snapshotPrice } from "../../src/market/indicators"
import { bar } from "../helpers/factories"

/** 5-minute bars from 09:30, one per close. */
const fiveMin = (closes: number[], extra: (i: number, c: number) => Partial<Bar> = () => ({})) =>
  closes.map((c, i) => bar(new Date(Date.UTC(2026, 9, 26, 13, 30 + i * 5)).toISOString(), c, extra(i, c)))

const daily = (closes: number[], extra: (i: number, c: number) => Partial<Bar> = () => ({})) =>
  closes.map((c, i) => bar(new Date(Date.UTC(2026, 8, 1 + i)).toISOString(), c, extra(i, c)))

// Wilder's classic RSI example (as published by StockCharts).
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28]

describe("round", () => {
  it("rounds to the given digits", () => {
    expect(round(1.234)).toBe(1.23)
    expect(round(1.236)).toBe(1.24)
    expect(round(1.25, 1)).toBe(1.3)
    expect(round(1234.5, 0)).toBe(1235)
    expect(round(-1.236)).toBe(-1.24)
  })

  it.each([null, undefined, NaN, Infinity, -Infinity])("returns null for %s", (value) => {
    expect(round(value)).toBeNull()
  })
})

describe("pctChange", () => {
  it("returns the % change rounded to 2 decimals", () => {
    expect(pctChange(100, 110)).toBe(10)
    expect(pctChange(200, 199)).toBe(-0.5)
    expect(pctChange(3, 4)).toBe(33.33)
  })

  it("returns null when either side is missing or zero", () => {
    expect(pctChange(null, 10)).toBeNull()
    expect(pctChange(10, undefined)).toBeNull()
    expect(pctChange(0, 10)).toBeNull()
  })
})

describe("intradayTechnicals", () => {
  it("returns null with no bars", () => {
    expect(intradayTechnicals([])).toBeNull()
  })

  it("computes volume-weighted VWAP from each bar's vw", () => {
    const bars = fiveMin([10, 20], (i) => ({ vw: i === 0 ? 10 : 20, v: i === 0 ? 300 : 100 }))
    const t = intradayTechnicals(bars)!
    expect(t.vwap).toBe(12.5)
    expect(t.pct_from_vwap).toBe(60)
  })

  it("falls back to the typical price when a bar has no vw", () => {
    const bars = fiveMin([12], () => ({ h: 15, l: 9, c: 12, vw: 0, v: 100 }))
    expect(intradayTechnicals(bars)!.vwap).toBe(12)
  })

  it("has no VWAP when there's no volume", () => {
    const t = intradayTechnicals(fiveMin([10, 11], () => ({ v: 0 })))!
    expect(t.vwap).toBeNull()
    expect(t.pct_from_vwap).toBeNull()
  })

  it("takes the opening range from the first 30 minutes and the day range from all bars", () => {
    const highs = [10, 12, 11, 13, 12, 11, 20, 15]
    const lows = [9, 8, 9.5, 10, 9, 10, 14, 7]
    const bars = fiveMin([10, 10, 10, 10, 10, 10, 15, 8], (i) => ({ h: highs[i], l: lows[i] }))
    const t = intradayTechnicals(bars)!
    expect(t.opening_range_high).toBe(13)
    expect(t.opening_range_low).toBe(8)
    expect(t.day_high).toBe(20)
    expect(t.day_low).toBe(7)
  })

  it("needs 9 and 21 closes for the EMAs and a trend", () => {
    const short = intradayTechnicals(fiveMin([1, 2, 3, 4, 5, 6, 7, 8]))!
    expect(short.ema9_5m).toBeNull()
    expect(short.trend_5m).toBeNull()

    // EMA seeds with the SMA of the first 9 closes (5), then 10 * 0.2 + 5 * 0.8 = 6.
    const ten = intradayTechnicals(fiveMin([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))!
    expect(ten.ema9_5m).toBe(6)
    expect(ten.ema21_5m).toBeNull()
    expect(ten.trend_5m).toBeNull()
  })

  it("reads the 5-minute trend from EMA9 vs EMA21", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i)
    expect(intradayTechnicals(fiveMin(up))!.trend_5m).toBe("up")
    expect(intradayTechnicals(fiveMin([...up].reverse()))!.trend_5m).toBe("down")
    expect(intradayTechnicals(fiveMin(Array(30).fill(100)))!.trend_5m).toBe("flat")
  })

  it("calls a tiny EMA spread flat (< 0.05% of price)", () => {
    // EMAs differ by well under 0.05% of a $1000 stock.
    const closes = [...Array(29).fill(1000), 1000.2]
    expect(intradayTechnicals(fiveMin(closes))!.trend_5m).toBe("flat")
  })

  it("computes Wilder's RSI(14)", () => {
    expect(intradayTechnicals(fiveMin(WILDER.slice(0, 14)))!.rsi14_5m).toBeNull()
    const rsi = intradayTechnicals(fiveMin(WILDER))!.rsi14_5m!
    expect(Math.abs(rsi - 70.53)).toBeLessThan(0.1)

    // Wilder smoothing on the next closes. The published table rounds its intermediate averages,
    // so allow a little drift from the exact values.
    const more = [46.0, 46.03, 46.41, 46.22, 45.64]
    const published = [66.32, 66.49, 69.41, 66.36, 57.97]
    more.forEach((_, i) => {
      const value = intradayTechnicals(fiveMin([...WILDER, ...more.slice(0, i + 1)]))!.rsi14_5m!
      expect(Math.abs(value - published[i])).toBeLessThan(0.15)
    })
  })

  it("pins RSI to 100 with no losses and 0 with no gains", () => {
    expect(intradayTechnicals(fiveMin(Array.from({ length: 20 }, (_, i) => 10 + i)))!.rsi14_5m).toBe(100)
    expect(intradayTechnicals(fiveMin(Array.from({ length: 20 }, (_, i) => 30 - i)))!.rsi14_5m).toBe(0)
  })

  it("measures the 30-minute change against the close six bars back", () => {
    expect(intradayTechnicals(fiveMin([100, 101, 102, 103, 104, 105, 110]))!.change_30m_pct).toBe(10)
    expect(intradayTechnicals(fiveMin([90, 95, 99, 100, 102, 103, 104, 105, 106, 110]))!.change_30m_pct).toBe(10)
    // Fewer than 7 bars: compare with the first bar.
    expect(intradayTechnicals(fiveMin([100, 105]))!.change_30m_pct).toBe(5)
  })

  it("rounds every output", () => {
    const t = intradayTechnicals(fiveMin([10.123456, 10.987654], () => ({ vw: 10.55555 })))!
    expect(t.vwap).toBe(10.56)
    expect(t.day_high).toBe(10.99)
  })
})

describe("dailyTechnicals", () => {
  const closes = Array.from({ length: 25 }, (_, i) => 100 + i) // 100 … 124
  const bars = daily(closes, (_, c) => ({ h: c + 1, l: c - 1 }))

  it("needs at least 6 completed days", () => {
    expect(dailyTechnicals(daily([1, 2, 3, 4, 5]), 5)).toBeNull()
  })

  it("computes 20-day levels, returns, ATR and RSI", () => {
    expect(dailyTechnicals(bars, null)).toEqual({
      sma20: 114.5, // mean of 105 … 124
      pct_from_sma20: 8.3,
      sma50: null, // only 25 days
      pct_from_sma50: null,
      sma200: null,
      pct_from_sma200: null,
      high_52w: null,
      pct_from_high_52w: null,
      return_5d_pct: 4.2, // 119 → 124
      return_20d_pct: 19.23, // 104 → 124
      atr14: 2, // every true range is 2
      atr_pct: 1.61,
      high_20d: 125,
      low_20d: 104,
      rsi14_daily: 100,
    })
  })

  it("adds the 50-day average once there are 50 days", () => {
    const t = dailyTechnicals(daily(Array.from({ length: 60 }, (_, i) => 100 + i)), null)! // 100 … 159
    expect(t.sma50).toBe(134.5) // mean of 110 … 159
    expect(t.pct_from_sma50).toBe(18.22)
  })

  it("adds the 200-day average and the 52-week high once there is a year of days", () => {
    const year = daily(Array.from({ length: 260 }, (_, i) => 100 + i), (_, c) => ({ h: c + 1 })) // 100 … 359
    const t = dailyTechnicals(year, 350)!
    expect(t.sma200).toBe(259.5) // mean of 160 … 359
    expect(t.pct_from_sma200).toBe(34.87)
    expect(t.high_52w).toBe(360) // the highest high of the last 252 days
    expect(t.pct_from_high_52w).toBe(-2.78)
    const short = dailyTechnicals(daily(Array.from({ length: 249 }, (_, i) => 100 + i)), null)!
    expect(short.sma200).not.toBeNull()
    expect(short.high_52w).toBeNull() // under 250 days
  })

  it("measures against the live price when given", () => {
    const t = dailyTechnicals(bars, 130)!
    expect(t.return_5d_pct).toBe(9.24)
    expect(t.pct_from_sma20).toBe(13.54)
    expect(t.atr_pct).toBe(1.54)
  })

  it("uses gaps from the prior close in the true range", () => {
    // Each day gaps 10 above the prior close with a 1-point range: true range = 10.5.
    const gappy = daily(Array.from({ length: 16 }, (_, i) => 100 + i * 10), (_, c) => ({ h: c + 0.5, l: c - 0.5 }))
    expect(dailyTechnicals(gappy, null)!.atr14).toBe(10.5)
  })

  it("leaves indicators null until there's enough history", () => {
    const t = dailyTechnicals(daily([10, 11, 12, 13, 14, 15]), null)!
    expect(t.sma20).toBeNull()
    expect(t.pct_from_sma20).toBeNull()
    expect(t.return_20d_pct).toBeNull()
    expect(t.atr14).toBeNull()
    expect(t.atr_pct).toBeNull()
    expect(t.rsi14_daily).toBeNull()
    expect(t.return_5d_pct).toBe(50)
    expect(t.high_20d).toBe(15)
    expect(t.low_20d).toBe(10)
  })
})

describe("snapshotPrice", () => {
  const trade = (p: number, t: string) => ({ p, t })
  const quote = (bp: number, ap: number, t: string) => ({ bp, ap, t })
  const EARLY = "2026-10-26T15:00:00Z"
  const LATE = "2026-10-26T15:05:00Z"

  it("has no price without a snapshot or any trade or quote", () => {
    expect(snapshotPrice(undefined)).toBeNull()
    expect(snapshotPrice({})).toBeNull()
  })

  it("uses the last trade when there's no usable quote", () => {
    expect(snapshotPrice({ latestTrade: trade(100, EARLY) })).toBe(100)
    expect(snapshotPrice({ latestTrade: trade(100, EARLY), latestQuote: quote(0, 101, LATE) })).toBe(100) // one-sided
    expect(snapshotPrice({ latestTrade: trade(100, EARLY), latestQuote: quote(101, 100.9, LATE) })).toBe(100) // crossed
  })

  it("uses a tight quote's midpoint when it's newer than the last trade", () => {
    expect(snapshotPrice({ latestTrade: trade(100, EARLY), latestQuote: quote(101.9, 102.1, LATE) })).toBe(102)
    expect(snapshotPrice({ latestQuote: quote(49.99, 50.02, LATE) })).toBe(50.005)
  })

  it("keeps the last trade when the quote is older or too wide", () => {
    expect(snapshotPrice({ latestTrade: trade(100, LATE), latestQuote: quote(101.9, 102.1, EARLY) })).toBe(100)
    expect(snapshotPrice({ latestTrade: trade(100, EARLY), latestQuote: quote(101, 102, LATE) })).toBe(100) // ~1% spread
  })
})
