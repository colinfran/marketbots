import { mean, stdev } from "./math"

/**
 * Technical indicators computed in code. LLMs are unreliable at arithmetic, so the AI is handed
 * finished numbers. All functions take oldest-first arrays and return null when there isn't enough
 * history.
 */

/** What the range-based indicators need from a bar or candle. */
export type HighLowClose = { high: number; low: number; close: number }

export const emaSeries = (values: number[], period: number): number[] => {
  if (values.length < period) return []
  const k = 2 / (period + 1)
  let value = mean(values.slice(0, period))
  const out = [value]
  for (const v of values.slice(period)) {
    value = v * k + value * (1 - k)
    out.push(value)
  }
  return out
}

export const ema = (values: number[], period: number): number | null => emaSeries(values, period).at(-1) ?? null

export const sma = (values: number[], period: number): number | null => (values.length < period ? null : mean(values.slice(-period)))

/** Wilder's RSI. A window with neither gains nor losses reads `flat` (50 by default: no momentum either way). */
export const rsi = (closes: number[], period = 14, { flat = 50 }: { flat?: number } = {}): number | null => {
  if (closes.length <= period) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
  }
  if (avgLoss === 0) return avgGain === 0 ? flat : 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

/**
 * Average true range: Wilder's smoothing by default. `smoothing: "sma"` is instead the plain mean
 * of the last `period` true ranges.
 */
export const atr = (candles: HighLowClose[], period = 14, { smoothing = "wilder" }: { smoothing?: "wilder" | "sma" } = {}): number | null => {
  if (candles.length <= period) return null
  const tr = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)))
  if (smoothing === "sma") return sma(tr, period)
  let value = mean(tr.slice(0, period))
  for (const t of tr.slice(period)) value = (value * (period - 1) + t) / period
  return value
}

export const bollinger = (closes: number[], period = 20, k = 2): { mid: number; upper: number; lower: number } | null => {
  if (closes.length < period) return null
  const window = closes.slice(-period)
  const mid = mean(window)
  // Bollinger bands use the population standard deviation.
  const sd = Math.sqrt(mean(window.map((v) => (v - mid) ** 2)))
  return { mid, upper: mid + k * sd, lower: mid - k * sd }
}

/** % change from `n` bars ago to the last value. */
export const pctReturn = (closes: number[], n: number): number | null => {
  if (closes.length <= n) return null
  const from = closes[closes.length - 1 - n]
  return from > 0 ? (closes[closes.length - 1] / from - 1) * 100 : null
}

export const logReturns = (closes: number[]) => closes.slice(1).map((c, i) => (closes[i] > 0 && c > 0 ? Math.log(c / closes[i]) : 0))

/** Annualized realized volatility (%) of the last `n` bars, for bars of `barHours` hours, over calendar time (365 × 24 hours a year). */
export const realizedVol = (closes: number[], n: number, barHours: number): number | null => {
  if (closes.length <= n) return null
  const r = logReturns(closes.slice(-(n + 1)))
  return stdev(r) * Math.sqrt((365 * 24) / barHours) * 100
}

export const highest = (values: number[], n: number) => (values.length < n ? null : Math.max(...values.slice(-n)))
export const lowest = (values: number[], n: number) => (values.length < n ? null : Math.min(...values.slice(-n)))

/** Pearson correlation of two equally long series. */
export const correlation = (a: number[], b: number[]): number | null => {
  const n = Math.min(a.length, b.length)
  if (n < 10) return null
  const x = a.slice(-n)
  const y = b.slice(-n)
  const mx = mean(x)
  const my = mean(y)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my)
    dx += (x[i] - mx) ** 2
    dy += (y[i] - my) ** 2
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null
}

/** Direction from a fast/slow EMA pair, with a dead band so tiny gaps read as flat. */
export const trendOf = (fast: number | null, slow: number | null, price: number, deadBandPct = 0.15): "up" | "down" | "flat" | null => {
  if (fast === null || slow === null || price <= 0) return null
  const gapPct = ((fast - slow) / price) * 100
  if (Math.abs(gapPct) < deadBandPct) return "flat"
  return gapPct > 0 ? "up" : "down"
}
