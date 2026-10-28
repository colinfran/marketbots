import { atr, ema, rsi, sma } from "@mb/core/indicators"
import type { Bar, Snapshot } from "@mb/stock-core/alpaca"
import type { DailyTechnicals, IntradayTechnicals } from "@mb/stock-core/context"

export type { DailyTechnicals, IntradayTechnicals }

/**
 * Technical indicators computed in code. LLMs are unreliable at arithmetic, so the bot hands
 * the AI finished numbers instead of raw bars.
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

// The shared indicators (@mb/core/indicators) with stock's own settings, which keep its values from
// before the move: a flat RSI window reads 100 (not 50), and ATR is the plain mean of the last 14
// true ranges (not Wilder's smoothing). Switching changes the indicator values in stock prompts.

/** 14-period RSI; a window without losses reads 100, a flat one included. */
const stockRsi = (closes: number[]) => rsi(closes, 14, { flat: 100 })

/** 14-period ATR: the mean of the last 14 true ranges. */
const stockAtr = (bars: Bar[]) => atr(bars.map((b) => ({ high: b.h, low: b.l, close: b.c })), 14, { smoothing: "sma" })

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
    rsi14_5m: round(stockRsi(closes), 1),
    ema9_5m: round(ema9),
    ema21_5m: round(ema21),
    trend_5m: trend,
    change_30m_pct: pctChange(thirtyAgo, last),
  }
}

/** Sessions in a year; a 52-week high needs nearly all of them (a few holidays' slack). */
const YEAR_SESSIONS = 252
const MIN_YEAR_SESSIONS = 250

/** Summarises completed daily bars (oldest first). `price` is the latest price. */
export const dailyTechnicals = (bars: Bar[], price: number | null): DailyTechnicals | null => {
  if (bars.length < 6) return null
  const closes = bars.map((b) => b.c)
  const last = price ?? closes[closes.length - 1]
  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)
  const high52w = bars.length >= MIN_YEAR_SESSIONS ? Math.max(...bars.slice(-YEAR_SESSIONS).map((b) => b.h)) : null
  const atr14 = stockAtr(bars)
  const recent = bars.slice(-20)
  return {
    sma20: round(sma20),
    pct_from_sma20: pctChange(sma20, last),
    sma50: round(sma50),
    pct_from_sma50: pctChange(sma50, last),
    sma200: round(sma200),
    pct_from_sma200: pctChange(sma200, last),
    high_52w: round(high52w),
    pct_from_high_52w: pctChange(high52w, last),
    return_5d_pct: pctChange(closes[closes.length - 6], last),
    return_20d_pct: closes.length > 20 ? pctChange(closes[closes.length - 21], last) : null,
    atr14: round(atr14),
    atr_pct: atr14 && last ? round((atr14 / last) * 100) : null,
    high_20d: round(Math.max(...recent.map((b) => b.h))),
    low_20d: round(Math.min(...recent.map((b) => b.l))),
    rsi14_daily: round(stockRsi(closes), 1),
  }
}
