import type { Bar, Snapshot } from "@mb/stock-core/alpaca"
import type { DailyTechnicals, IntradayTechnicals } from "@mb/stock-core/context"

export type { DailyTechnicals, IntradayTechnicals }

/**
 * Technical indicators computed in code. LLMs are unreliable at arithmetic, so the bot hands
 * Grok finished numbers instead of raw bars.
 */

export const round = (value: number | null | undefined, digits = 2): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export const pctChange = (from: number | null | undefined, to: number | null | undefined) =>
  from && to ? round(((to - from) / from) * 100) : null

/** Widest quote spread, as a % of the midpoint, at which the quote is trusted over the last trade. */
const MAX_QUOTE_SPREAD_PCT = 0.5

/**
 * The best current price in an IEX snapshot. IEX sees only a slice of trading, so on quieter names
 * its last trade can be minutes old while its quote is live. The quote midpoint is used when the
 * quote is two-sided, tight and newer than the last trade; otherwise the last trade.
 */
export const snapshotPrice = (snap: Snapshot | undefined): number | null => {
  const trade = snap?.latestTrade
  const quote = snap?.latestQuote
  if (quote && quote.bp > 0 && quote.ap >= quote.bp) {
    const mid = (quote.ap + quote.bp) / 2
    const tight = ((quote.ap - quote.bp) / mid) * 100 <= MAX_QUOTE_SPREAD_PCT
    const newer = !trade || new Date(quote.t).getTime() > new Date(trade.t).getTime()
    if (tight && newer) return round(mid, 4)
  }
  return trade?.p ?? null
}

const ema = (values: number[], period: number): number | null => {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (const v of values.slice(period)) value = v * k + value * (1 - k)
  return value
}

const sma = (values: number[], period: number): number | null =>
  values.length < period ? null : values.slice(-period).reduce((a, b) => a + b, 0) / period

/** Wilder's RSI. */
const rsi = (closes: number[], period = 14): number | null => {
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
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

const atr = (bars: Bar[], period = 14): number | null => {
  if (bars.length <= period) return null
  const ranges = bars.slice(1).map((bar, i) => {
    const prevClose = bars[i].c
    return Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose))
  })
  return sma(ranges, period)
}

/** Summarises today's regular-session 5-minute bars. */
export const intradayTechnicals = (bars: Bar[]): IntradayTechnicals | null => {
  if (bars.length === 0) return null
  const closes = bars.map((b) => b.c)
  const last = closes[closes.length - 1]
  const volume = bars.reduce((sum, b) => sum + b.v, 0)
  const vwap = volume > 0 ? bars.reduce((sum, b) => sum + (b.vw || (b.h + b.l + b.c) / 3) * b.v, 0) / volume : null
  const openingRange = bars.slice(0, 6) // first 30 minutes
  const ema9 = ema(closes, 9)
  const ema21 = ema(closes, 21)
  const trend =
    ema9 === null || ema21 === null
      ? null
      : Math.abs(ema9 - ema21) / last < 0.0005
        ? "flat"
        : ema9 > ema21
          ? "up"
          : "down"
  const thirtyAgo = closes.length > 6 ? closes[closes.length - 7] : closes[0]

  return {
    vwap: round(vwap),
    pct_from_vwap: pctChange(vwap, last),
    opening_range_high: round(Math.max(...openingRange.map((b) => b.h))),
    opening_range_low: round(Math.min(...openingRange.map((b) => b.l))),
    day_high: round(Math.max(...bars.map((b) => b.h))),
    day_low: round(Math.min(...bars.map((b) => b.l))),
    rsi14_5m: round(rsi(closes), 1),
    ema9_5m: round(ema9),
    ema21_5m: round(ema21),
    trend_5m: trend,
    change_30m_pct: pctChange(thirtyAgo, last),
  }
}

/** Summarises completed daily bars (oldest first). `price` is the latest price. */
export const dailyTechnicals = (bars: Bar[], price: number | null): DailyTechnicals | null => {
  if (bars.length < 6) return null
  const closes = bars.map((b) => b.c)
  const last = price ?? closes[closes.length - 1]
  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const atr14 = atr(bars)
  const recent = bars.slice(-20)
  return {
    sma20: round(sma20),
    pct_from_sma20: pctChange(sma20, last),
    sma50: round(sma50),
    pct_from_sma50: pctChange(sma50, last),
    return_5d_pct: pctChange(closes[closes.length - 6], last),
    return_20d_pct: closes.length > 20 ? pctChange(closes[closes.length - 21], last) : null,
    atr14: round(atr14),
    atr_pct: atr14 && last ? round((atr14 / last) * 100) : null,
    high_20d: round(Math.max(...recent.map((b) => b.h))),
    low_20d: round(Math.min(...recent.map((b) => b.l))),
    rsi14_daily: round(rsi(closes), 1),
  }
}
