import { describe, expect, it } from "vitest"
import { brierScore, calibrationTable, drawdownSeries, maxDrawdown, performanceMetrics, tradeStats } from "../src/metrics"

const HOUR = 3_600_000
const series = (values: number[], stepMs = 24 * HOUR) => values.map((equity, i) => ({ t: i * stepMs, equity }))

describe("drawdowns", () => {
  it("measures the worst peak-to-trough drop and its duration", () => {
    const points = series([100, 120, 90, 110, 130, 117])
    expect(maxDrawdown(points).pct).toBeCloseTo(-25)
    expect(maxDrawdown(points).hours).toBe(48)
    expect(drawdownSeries(points).map((p) => Math.round(p.dd_pct))).toEqual([0, 0, -25, -8, 0, -10])
  })
})

describe("tradeStats", () => {
  it("computes win rate, profit factor and expectancy", () => {
    const stats = tradeStats([
      { pnl_usd: 100, return_pct: 2 },
      { pnl_usd: -50, return_pct: -1 },
      { pnl_usd: 50, return_pct: 1 },
      { pnl_usd: 0, return_pct: 0 },
    ])
    expect(stats).toMatchObject({ trades: 4, wins: 2, losses: 1, win_rate_pct: 50, profit_factor: 3, expectancy_usd: 25 })
  })

  it("reports no profit factor without losses", () => {
    expect(tradeStats([{ pnl_usd: 10, return_pct: 1 }]).profit_factor).toBeNull()
  })
})

describe("performanceMetrics", () => {
  it("annualizes only with at least 30 days of history", () => {
    expect(performanceMetrics(series([100, 101, 102]), []).annualized_return_pct).toBeNull()
    const year = series(Array.from({ length: 366 }, (_, i) => 100 * 1.001 ** i))
    const m = performanceMetrics(year, [])
    expect(m.annualized_return_pct).toBeCloseTo(44.06, 0)
    expect(m.sharpe).toBeNull() // zero volatility
  })

  it("gives positive sharpe/sortino for a rising, noisy curve", () => {
    const values = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5 + (i % 2 ? 1 : -1))
    const m = performanceMetrics(series(values, HOUR), [])
    expect(m.sharpe!).toBeGreaterThan(0)
    expect(m.sortino!).toBeGreaterThan(0)
    expect(m.total_return_pct).toBeCloseTo(((values.at(-1)! / values[0]) - 1) * 100, 1)
  })
})

describe("forecast quality", () => {
  it("scores brier and buckets calibration", () => {
    expect(brierScore([{ p: 1, outcome: 1 }, { p: 0, outcome: 0 }])).toBe(0)
    expect(brierScore([{ p: 0.5, outcome: 1 }])).toBe(0.25)
    const table = calibrationTable([{ p: 0.1, outcome: 0 }, { p: 0.9, outcome: 1 }, { p: 0.95, outcome: 0 }], 5)
    expect(table[0]).toMatchObject({ n: 1, hit_rate: 0 })
    expect(table[4]).toMatchObject({ n: 2, hit_rate: 0.5 })
  })
})
