import { describe, expect, it } from "vitest"
import { atr, bollinger, ema, emaSeries, rsi, sma, weeklyCloseVs200, type HighLowClose } from "../src/indicators"

/** Bars that open at the previous close, with highs and lows 0.2% beyond the body. */
const bars = (closes: number[]): HighLowClose[] =>
  closes.map((close, i) => {
    const open = i ? closes[i - 1] : close
    return { high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close }
  })

describe("indicators", () => {
  it("compute standard values", () => {
    expect(ema([1, 2, 3, 4, 5], 5)).toBe(3)
    expect(rsi(Array.from({ length: 20 }, (_, i) => i))).toBe(100)
    expect(rsi(Array.from({ length: 20 }, () => 5))).toBe(50)
    expect(bollinger([1, 1, 1, 1], 4)).toEqual({ mid: 1, upper: 1, lower: 1 })
    expect(atr(bars([10, 10, 10, 10]), 2)).toBeCloseTo(0.04, 2)
  })

  it("need enough history", () => {
    expect(ema([1, 2], 3)).toBeNull()
    expect(emaSeries([1, 2, 3, 4], 3)).toEqual([2, 3])
    expect(sma([1, 2], 3)).toBeNull()
    expect(rsi([1, 2, 3], 14)).toBeNull()
    expect(atr(bars([1, 2, 3]), 14)).toBeNull()
  })

  it("read a flat RSI window as 50 unless told otherwise", () => {
    const flat = Array.from({ length: 20 }, () => 5)
    expect(rsi(flat, 14, { flat: 100 })).toBe(100)
    // Only the flat case changes: a window with gains and no losses is 100 either way.
    const rising = Array.from({ length: 20 }, (_, i) => i)
    expect(rsi(rising, 14, { flat: 100 })).toBe(rsi(rising))
  })

  it("smooth ATR with Wilder's method, or average the last true ranges", () => {
    const series: HighLowClose[] = [
      { high: 10, low: 10, close: 10 },
      { high: 12, low: 10, close: 11 }, // TR 2
      { high: 11, low: 11, close: 11 }, // TR 0
      { high: 15, low: 11, close: 14 }, // TR 4
    ]
    // Wilder: mean of the first two ranges (1), then (1 × 1 + 4) / 2.
    expect(atr(series, 2)).toBe(2.5)
    // SMA: the mean of the last two ranges.
    expect(atr(series, 2, { smoothing: "sma" })).toBe(2)
  })
})

describe("the long-term books' weekly rule", () => {
  const DAY = 86_400_000
  // 250 daily bars: flat at 100 for 230 days, then 20 days at 90.
  const bars = Array.from({ length: 250 }, (_, i) => ({ t: i * DAY, close: i < 230 ? 100 : 90 }))

  it("judges the last completed week's close against its 200-day average, ignoring bars from this week", () => {
    // The week starts at bar 220: its close is bar 219's, 100, at a 200-day average of 100.
    expect(weeklyCloseVs200(bars, 220 * DAY)).toEqual({ close: 100, sma200: 100, above: false })
    // A week later, bar 239: 90 against (190 × 100 + 10 × 90) / 200 = 99.5.
    expect(weeklyCloseVs200(bars, 240 * DAY)).toEqual({ close: 90, sma200: 99.5, above: false })
    const rising = bars.map((b, i) => ({ ...b, close: 100 + i }))
    expect(weeklyCloseVs200(rising, 240 * DAY)?.above).toBe(true)
  })

  it("needs 200 bars before the week", () => {
    expect(weeklyCloseVs200(bars, 199 * DAY)).toBeNull()
    expect(weeklyCloseVs200(bars, 200 * DAY)).not.toBeNull()
  })
})
