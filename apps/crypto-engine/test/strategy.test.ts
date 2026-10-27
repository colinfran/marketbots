import type { DecisionDoc, PositionDoc } from "@mb/crypto-core/db"
import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { describe, expect, it } from "vitest"
import { aggregate, simulate } from "../src/backtest/simulate"
import { classifyRegime, computeFeatures } from "../src/market/features"
import { recentlyJudged, reviewsDue, viableSetup } from "../src/orchestrator/crypto-cycle"
import { firstTouch, scoreDecision } from "../src/orchestrator/outcomes"
import { correlatedWith, correlationMatrix } from "../src/risk/correlation"
import { dailyTrendStrategy } from "../src/strategies/daily-trend"
import { meanReversionStrategy } from "../src/strategies/mean-reversion"
import { screenCrypto } from "../src/strategies/registry"
import { useTestDb } from "./helpers/db"
import { candles, quote } from "./helpers/fakes"

const HOUR = 3_600_000

/** A steady uptrend with small noise, then a fresh push to new highs. */
const uptrend = (n: number, start = 100) => Array.from({ length: n }, (_, i) => start * (1 + 0.002 * i) * (1 + (i % 3 === 0 ? 0.001 : -0.0005)))

const featureSet = (closes1h: number[]) => {
  const h1 = candles(closes1h)
  const h4 = aggregate(h1, 4)
  const d1 = aggregate(h1, 24)
  const last = closes1h.at(-1)!
  return computeFeatures("BTC/USD", { h1, h4, d1 }, quote({ bid: last * 0.9999, ask: last * 1.0001, mid: last, spreadBps: 2 }))
}

describe("features and screens", () => {
  it("need enough history and see an uptrend", () => {
    expect(featureSet(uptrend(30))).toBeNull()
    const f = featureSet(uptrend(24 * 45))!
    expect(f.trend_4h).toBe("up")
    expect(f.ret_7d_pct!).toBeGreaterThan(0)
    const regime = classifyRegime([f])
    const candidates = screenCrypto({ regime, features: [f], held: new Set(), settings: DEFAULT_SETTINGS })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0].stop_hint).toBeLessThan(f.price)
    expect(candidates[0].target_hint).toBeGreaterThan(f.price)
    // Held symbols are reviewed, never re-entered.
    expect(screenCrypto({ regime, features: [f], held: new Set(["BTC/USD"]), settings: DEFAULT_SETTINGS })).toEqual([])
  })

  it("skip disabled strategies", () => {
    const f = featureSet(uptrend(24 * 45))!
    const off = Object.fromEntries(Object.entries(DEFAULT_SETTINGS.strategies).map(([k, v]) => [k, { ...v, enabled: false }])) as typeof DEFAULT_SETTINGS.strategies
    expect(screenCrypto({ regime: classifyRegime([f]), features: [f], held: new Set(), settings: { ...DEFAULT_SETTINGS, strategies: off } })).toEqual([])
  })
})

describe("correlation", () => {
  it("treats co-moving assets as correlated and unknown pairs as correlated", () => {
    const a = uptrend(400)
    const m = correlationMatrix(new Map([["A", a], ["B", a.map((x) => x * 2)], ["C", a.map((_, i) => 100 + Math.sin(i))]]))
    expect(m.get("A")!.get("B")).toBeCloseTo(1, 5)
    expect(correlatedWith("A", ["B", "C", "Z"], m, 0.75)).toEqual(["B", "Z"])
  })
})

describe("backtest", () => {
  const params = { symbols: ["BTC/USD"], strategies: ["trend", "mean_reversion", "momentum"] as ("trend" | "mean_reversion" | "momentum")[], interval: 60 as const, starting_usd: 10_000, slippage_bps: 5, fee_bps: 40, in_sample_fraction: 0.7 }

  it("trades and reports metrics with costs", () => {
    const series = new Map([["BTC/USD", candles(uptrend(24 * 60))]])
    const r = simulate(series, params, DEFAULT_SETTINGS)
    expect(r.metrics).not.toBeNull()
    expect(r.trades.length).toBeGreaterThan(0)
    expect(r.equity_curve.length).toBeGreaterThan(10)
    expect(r.benchmarks.buy_hold_btc_pct).not.toBeNull()
  })

  it("has no look-ahead: changing the future doesn't change past trades", () => {
    const base = uptrend(24 * 60)
    const crashed = [...base.slice(0, 24 * 50), ...base.slice(24 * 50).map((x) => x * 0.5)]
    const a = simulate(new Map([["BTC/USD", candles(base)]]), params, DEFAULT_SETTINGS)
    const b = simulate(new Map([["BTC/USD", candles(crashed)]]), params, DEFAULT_SETTINGS)
    const cutoff = Date.UTC(2026, 0, 1) + 24 * 50 * HOUR
    const before = (r: typeof a) => r.trades.filter((t) => t.exit_at.getTime() < cutoff).map((t) => [t.entry_at.getTime(), t.entry_price, t.exit_price])
    expect(before(b)).toEqual(before(a))
  })

  it("refuses to backtest without enough history", () => {
    expect(simulate(new Map([["BTC/USD", candles(uptrend(100))]]), params, DEFAULT_SETTINGS).notes.at(-1)).toMatch(/Not enough history/)
  })
})

describe("decision outcomes", () => {
  const path = candles([100, 101, 103, 99, 96, 104])
  it("finds the first level touched, assuming the stop when both are in one candle", () => {
    expect(firstTouch(path, 95, 102.5)).toBe("target")
    expect(firstTouch(path, 98.9, 110)).toBe("stop")
    expect(firstTouch([{ ...path[0], high: 120, low: 80 }], 90, 110)).toBe("stop")
    expect(firstTouch(path, null, null)).toBeNull()
  })

  it("scores buys, skipped candidates and holds", () => {
    const d = (action: DecisionDoc["action"], held = false) =>
      ({ action, held, quant: { price: 100, features: {} }, sizing: { stop_price: 95, take_profit_price: 102.5 }, ai: { stop_loss: null, take_profit: null, horizon_hours: 6 }, costs: { round_trip_bps: 90, fee_bps: 40 } }) as unknown as DecisionDoc
    expect(scoreDecision(d("buy"), path)).toMatchObject({ hit: "target", correct: true, forward_return_pct: 4 })
    expect(scoreDecision(d("no_trade"), path).correct).toBe(false) // a missed winner
    expect(scoreDecision(d("hold", true), path).correct).toBe(true)
  })
})

describe("long-term trend", () => {
  const base = featureSet(uptrend(24 * 45))!
  const range = { label: "range" as const, btc_trend: "up" as const, btc_vol_pct: 30, breadth_pct: 40, notes: [] }
  const daily = (o: Partial<typeof base>) => ({ ...base, sma50_1d: 100, sma200_1d: 90, atr_pct_1d: 2, rsi14_1d: 45, ...o })
  const screen = (f: typeof base, regime: typeof range | { label: "risk_off_trend" } = range) =>
    dailyTrendStrategy.screen({ regime: regime as typeof range, features: [f], held: new Set(), settings: DEFAULT_SETTINGS })

  it("buys a pullback to the 50-day in a long-term uptrend, with a daily stop and a 3R target", () => {
    const [c] = screen(daily({ price: 98, rsi14_1d: 42 }))
    expect(c).toMatchObject({ strategy: "daily_trend", symbol: "BTC/USD" })
    expect(c.signal).toContain("Pullback")
    expect(c.stop_hint).toBeCloseTo(98 - 2.5 * 1.96) // 2.5 daily ATR
    expect(c.target_hint).toBeCloseTo(98 + 3 * 2.5 * 1.96)
  })

  it("buys a continuation above the 50-day that isn't overbought", () => {
    expect(screen(daily({ price: 103, rsi14_1d: 55 }))[0].signal).toContain("Long-term uptrend")
  })

  it("passes on broken trends, deep pullbacks, overbought tape and a risk-off market", () => {
    expect(screen(daily({ price: 98, sma50_1d: 95, sma200_1d: 100 }))).toEqual([]) // 50-day under the 200-day
    expect(screen(daily({ price: 89 }))).toEqual([]) // below the 200-day
    expect(screen(daily({ price: 94 }))).toEqual([]) // more than 1.5 ATR under the 50-day
    expect(screen(daily({ price: 103, rsi14_1d: 75 }))).toEqual([])
    expect(screen(daily({ price: 98 }), { label: "risk_off_trend" })).toEqual([])
  })
})

describe("setups the AI is asked about", () => {
  const db = useTestDb()
  const base = featureSet(uptrend(24 * 45))!
  const range = { label: "range" as const, btc_trend: "up" as const, btc_vol_pct: 30, breadth_pct: 40, notes: [] }
  const oversold = (ema20: number) => ({ ...base, price: 100, rsi14_1h: 22, bb_pct_b_1h: 0, trend_1d: "up" as const, move_zscore_24h: -2.5, ema20_1h: ema20, atr_pct_4h: 0.6 })
  const screen = (f: typeof base) => meanReversionStrategy.screen({ regime: range, features: [f], held: new Set(), settings: DEFAULT_SETTINGS })
  const k = DEFAULT_SETTINGS.kraken

  it("drops setups whose own levels can't pass reward:risk or beat the round-trip cost", () => {
    // The mean 0.5% away: the 1% minimum stop leaves the screen's 1.2R floor as the target, under the 1.3 minimum.
    const [near] = screen(oversold(100.5))
    expect(near.target_hint).toBeCloseTo(101.2)
    expect(viableSetup(near, 100, 87, k)).toBe(false)
    const [far] = screen(oversold(102))
    expect(far.target_hint).toBeCloseTo(102)
    expect(viableSetup(far, 100, 87, k)).toBe(true)
    // 1.5R either way; only the round trip decides whether a 1.5% target leaves the 25 bps minimum edge.
    expect(viableSetup({ stop_hint: 99, target_hint: 101.5 }, 100, 130, k)).toBe(false)
    expect(viableSetup({ stop_hint: 99, target_hint: 101.5 }, 100, 100, k)).toBe(true)
    expect(viableSetup({ stop_hint: 95, target_hint: 115 }, 100, 87, k)).toBe(true) // a daily-trend 3R setup
  })

  it("doesn't re-ask about a setup the AI ruled on: daily-trend for a day, the others for 2 hours", async () => {
    const now = Date.UTC(2026, 9, 27, 12)
    const decision = (symbol: string, strategy_id: DecisionDoc["strategy_id"], minutesAgo: number) =>
      ({ _id: `${symbol}-${strategy_id}`, symbol, strategy_id, created_at: new Date(now - minutesAgo * 60_000) }) as unknown as DecisionDoc
    await db.col.decisions.insertMany([
      decision("TRX/USD", "mean_reversion", 90),
      decision("SOL/USD", "mean_reversion", 150),
      decision("BTC/USD", "daily_trend", 20 * 60),
      decision("ETH/USD", "daily_trend", 25 * 60),
      decision("XRP/USD", "discretionary", 10), // the owner's requests are always asked
    ])
    expect([...(await recentlyJudged(db.col, now))].sort()).toEqual(["BTC/USD daily_trend", "TRX/USD mean_reversion"])
  })
})

describe("position reviews", () => {
  const now = Date.now()
  const f = { ...featureSet(uptrend(24 * 45))!, price: 101.5, atr_1h: 0.5, atr_pct_1d: 3 }
  const position = (strategy_id: "trend" | "daily_trend", ageHours: number) =>
    ({ symbol: "BTC/USD", strategy_id, opened_at: new Date(now - ageHours * HOUR), last_reviewed_at: null, last_review_price: null, avg_price: 100, horizon_hours: 336 }) as unknown as PositionDoc
  const due = (p: PositionDoc) => reviewsDue([p], new Map([["BTC/USD", f]]), new Set(), 240, 1.5, now)

  it("reviews long-term holds daily and on daily-ATR moves, not hourly ones", () => {
    expect(due(position("trend", 1))).toHaveLength(1) // 1.5% ≥ 1.5 × hourly ATR
    expect(due(position("daily_trend", 5))).toEqual([]) // same move is noise on the daily chart
    expect(due(position("daily_trend", 25))[0].reason).toMatch(/scheduled review/)
  })
})
