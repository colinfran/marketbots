import { mean, median, round, stdev, sum } from "./math"

/**
 * Performance and forecast-quality metrics, shared by backtests, the paper/live analytics page and
 * the AI evaluation views, so the same trade is never scored two different ways.
 *
 * Annualization uses calendar time (365 days, right for a market that trades 24/7), not 252
 * trading days. Sharpe and Sortino use a 0% risk-free rate.
 */

export type EquityPoint = { t: number; equity: number }

export type TradeResult = { pnl_usd: number; return_pct: number; holding_hours?: number }

export type TradeStats = {
  trades: number
  wins: number
  losses: number
  win_rate_pct: number | null
  profit_factor: number | null
  avg_return_pct: number | null
  avg_win_pct: number | null
  avg_loss_pct: number | null
  total_pnl_usd: number
  expectancy_usd: number | null
}

export type PerformanceMetrics = TradeStats & {
  start_equity: number
  end_equity: number
  total_return_pct: number | null
  annualized_return_pct: number | null
  volatility_pct: number | null
  sharpe: number | null
  sortino: number | null
  max_drawdown_pct: number | null
  /** Longest stretch below a previous peak, in hours. */
  max_drawdown_hours: number | null
  exposure_pct: number | null
  turnover: number | null
  days: number
}

const HOUR = 3_600_000
const YEAR_MS = 365 * 24 * HOUR
const EPSILON = 1e-12

export const tradeStats = (trades: TradeResult[]): TradeStats => {
  const wins = trades.filter((t) => t.pnl_usd > 0)
  const losses = trades.filter((t) => t.pnl_usd < 0)
  const grossProfit = sum(wins.map((t) => t.pnl_usd))
  const grossLoss = -sum(losses.map((t) => t.pnl_usd))
  const total = sum(trades.map((t) => t.pnl_usd))
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: trades.length ? round((wins.length / trades.length) * 100) : null,
    // No losing trades means an infinite profit factor; report null rather than a fake number.
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss) : null,
    avg_return_pct: trades.length ? round(mean(trades.map((t) => t.return_pct)), 3) : null,
    avg_win_pct: wins.length ? round(mean(wins.map((t) => t.return_pct)), 3) : null,
    avg_loss_pct: losses.length ? round(mean(losses.map((t) => t.return_pct)), 3) : null,
    total_pnl_usd: round(total) ?? 0,
    expectancy_usd: trades.length ? round(total / trades.length) : null,
  }
}

/** Drawdown from the running peak at each point, as a negative percentage (0 at new highs). */
export const drawdownSeries = (points: EquityPoint[]): { t: number; dd_pct: number }[] => {
  let peak = -Infinity
  return points.map((p) => {
    peak = Math.max(peak, p.equity)
    return { t: p.t, dd_pct: peak > 0 ? ((p.equity - peak) / peak) * 100 : 0 }
  })
}

export const maxDrawdown = (points: EquityPoint[]): { pct: number; hours: number } => {
  let peak = -Infinity
  let peakT = points[0]?.t ?? 0
  let worst = 0
  let longest = 0
  for (const p of points) {
    if (p.equity >= peak) {
      peak = p.equity
      peakT = p.t
    } else {
      longest = Math.max(longest, p.t - peakT)
    }
    if (peak > 0) worst = Math.min(worst, ((p.equity - peak) / peak) * 100)
  }
  return { pct: worst, hours: longest / HOUR }
}

/** Simple returns between consecutive equity points. */
export const periodReturns = (points: EquityPoint[]) =>
  points.slice(1).map((p, i) => (points[i].equity > 0 ? p.equity / points[i].equity - 1 : 0))

/** Periods per year implied by the median sampling interval of the series. */
const periodsPerYear = (points: EquityPoint[]) => {
  const gaps = points.slice(1).map((p, i) => p.t - points[i].t).filter((g) => g > 0)
  const gap = median(gaps)
  return gap > 0 ? YEAR_MS / gap : 0
}

export const performanceMetrics = (
  points: EquityPoint[],
  trades: TradeResult[],
  extra: { exposure_pct?: number | null; traded_notional_usd?: number } = {},
): PerformanceMetrics => {
  const stats = tradeStats(trades)
  const start = points[0]?.equity ?? 0
  const end = points[points.length - 1]?.equity ?? start
  const elapsed = points.length > 1 ? points[points.length - 1].t - points[0].t : 0
  const returns = periodReturns(points)
  const ppy = periodsPerYear(points)
  const sd = stdev(returns)
  const downside = Math.sqrt(mean(returns.map((r) => Math.min(0, r) ** 2)))
  const avg = mean(returns)
  const dd = maxDrawdown(points)
  const totalReturn = start > 0 ? (end / start - 1) * 100 : null
  // Annualizing a few days of returns produces absurd numbers; require at least 30 days.
  const annualized = start > 0 && end > 0 && elapsed >= 30 * 24 * HOUR ? ((end / start) ** (YEAR_MS / elapsed) - 1) * 100 : null
  const avgEquity = mean(points.map((p) => p.equity))
  return {
    ...stats,
    start_equity: round(start) ?? 0,
    end_equity: round(end) ?? 0,
    total_return_pct: round(totalReturn),
    annualized_return_pct: round(annualized),
    volatility_pct: returns.length > 1 && ppy > 0 ? round(sd * Math.sqrt(ppy) * 100) : null,
    // A flat curve has float-noise volatility (~1e-17); treat it as zero instead of dividing by it.
    sharpe: returns.length > 1 && sd > EPSILON && ppy > 0 ? round((avg / sd) * Math.sqrt(ppy)) : null,
    sortino: returns.length > 1 && downside > EPSILON && ppy > 0 ? round((avg / downside) * Math.sqrt(ppy)) : null,
    max_drawdown_pct: points.length > 1 ? round(dd.pct) : null,
    max_drawdown_hours: points.length > 1 ? round(dd.hours, 1) : null,
    exposure_pct: extra.exposure_pct ?? null,
    turnover: extra.traded_notional_usd !== undefined && avgEquity > 0 ? round(extra.traded_notional_usd / avgEquity) : null,
    days: round(elapsed / (24 * HOUR), 1) ?? 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Forecast quality (AI calibration)
// ─────────────────────────────────────────────────────────────────────────────

export type Forecast = { p: number; outcome: 0 | 1 }

/** Mean squared error of probability forecasts. 0 is perfect, 0.25 is a coin flip at 50%. */
export const brierScore = (forecasts: Forecast[]): number | null =>
  forecasts.length ? mean(forecasts.map((f) => (f.p - f.outcome) ** 2)) : null

export const logLoss = (forecasts: Forecast[]): number | null => {
  if (!forecasts.length) return null
  const eps = 1e-6
  return -mean(forecasts.map((f) => {
    const p = Math.min(1 - eps, Math.max(eps, f.p))
    return f.outcome ? Math.log(p) : Math.log(1 - p)
  }))
}

export type CalibrationBucket = { lo: number; hi: number; n: number; avg_forecast: number | null; hit_rate: number | null }

/** Groups forecasts into probability buckets: a calibrated model's 70% calls come true ~70% of the time. */
export const calibrationTable = (forecasts: Forecast[], buckets = 5): CalibrationBucket[] =>
  Array.from({ length: buckets }, (_, i) => {
    const lo = i / buckets
    const hi = (i + 1) / buckets
    const inBucket = forecasts.filter((f) => f.p >= lo && (i === buckets - 1 ? f.p <= hi : f.p < hi))
    return {
      lo,
      hi,
      n: inBucket.length,
      avg_forecast: inBucket.length ? round(mean(inBucket.map((f) => f.p)), 3) : null,
      hit_rate: inBucket.length ? round(mean(inBucket.map((f) => f.outcome)), 3) : null,
    }
  })
