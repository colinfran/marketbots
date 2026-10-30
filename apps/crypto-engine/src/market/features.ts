import { atr, bollinger, ema, highest, lowest, pctReturn, realizedVol, rsi, sma, trendOf } from "@mb/core/indicators"
import type { RegimeSnapshot, SymbolFeatures } from "@mb/crypto-core/db"
import { round } from "@mb/crypto-core/math"
import type { Candle } from "../venues/kraken/rest"
import type { Quote } from "./hub"

/**
 * Per-asset features computed from closed candles (1h / 4h / 1d) plus the live quote. These are
 * the numbers strategies screen on and the AI reasons with.
 */

export type CandleSet = { h1: Candle[]; h4: Candle[]; d1: Candle[] }

export type Features = {
  symbol: string
  price: number
  bid: number
  ask: number
  spread_bps: number
  quote_age_s: number
  as_of: number
  ret_1h_pct: number | null
  ret_4h_pct: number | null
  ret_24h_pct: number | null
  ret_7d_pct: number | null
  ret_30d_pct: number | null
  ema20_1h: number | null
  ema50_1h: number | null
  ema20_4h: number | null
  ema50_4h: number | null
  sma50_1d: number | null
  sma200_1d: number | null
  trend_1h: "up" | "down" | "flat" | null
  trend_4h: "up" | "down" | "flat" | null
  trend_1d: "up" | "down" | "flat" | null
  rsi14_1h: number | null
  rsi14_4h: number | null
  rsi14_1d: number | null
  atr_1h: number | null
  atr_pct_1h: number | null
  atr_pct_4h: number | null
  atr_pct_1d: number | null
  bb_lower_1h: number | null
  bb_upper_1h: number | null
  /** Position within the 1h Bollinger band: 0 = lower band, 1 = upper band. */
  bb_pct_b_1h: number | null
  high_20x4h: number | null
  low_20x4h: number | null
  /** Price above the high of the previous 20 4h candles. */
  breakout_4h: boolean
  vol_7d_pct: number | null
  vol_30d_pct: number | null
  /** Last 24h volume relative to the 30-day average daily volume. */
  volume_ratio_24h: number | null
  /** 24h return divided by the typical daily move: how unusual today's move is. */
  move_zscore_24h: number | null
  /** 1h closes for correlation; not sent to the AI. */
  closes_1h: number[]
}

const closes = (c: Candle[]) => c.map((x) => x.close)

export const computeFeatures = (symbol: string, candles: CandleSet, quote: Quote): Features | null => {
  const h1 = closes(candles.h1)
  const h4 = closes(candles.h4)
  const d1 = closes(candles.d1)
  if (h1.length < 50 || h4.length < 30 || d1.length < 30) return null
  const price = quote.mid
  // Treat the live price as the newest point, so returns and bands reflect the current tape.
  const h1Live = [...h1, price]
  const d1Live = [...d1, price]
  const ema20_1h = ema(h1Live, 20)
  const ema50_1h = ema(h1Live, 50)
  const ema20_4h = ema([...h4, price], 20)
  const ema50_4h = ema([...h4, price], 50)
  const sma50 = sma(d1Live, 50)
  const sma200 = sma(d1Live, 200)
  const atr1h = atr(candles.h1)
  const atr4h = atr(candles.h4)
  const atr1d = atr(candles.d1)
  const bb = bollinger(h1Live, 20, 2)
  const high20 = highest(candles.h4.slice(-21, -1).map((c) => c.high), 20)
  const low20 = lowest(candles.h4.slice(-21, -1).map((c) => c.low), 20)
  const vol24 = candles.h1.slice(-24).reduce((s, c) => s + c.volume, 0)
  const avgDaily = candles.d1.slice(-30).reduce((s, c) => s + c.volume, 0) / Math.min(30, candles.d1.length)
  const dailyVol = realizedVol(d1, 30, 24)
  const ret24 = pctReturn(h1Live, 24)
  const typicalDailyMovePct = dailyVol !== null ? dailyVol / Math.sqrt(365) : null

  return {
    symbol,
    price,
    bid: quote.bid,
    ask: quote.ask,
    spread_bps: round(quote.spreadBps, 1)!,
    quote_age_s: round(quote.ageS, 1)!,
    as_of: quote.at,
    ret_1h_pct: round(pctReturn(h1Live, 1)),
    ret_4h_pct: round(pctReturn(h1Live, 4)),
    ret_24h_pct: round(ret24),
    ret_7d_pct: round(pctReturn(d1Live, 7)),
    ret_30d_pct: round(pctReturn(d1Live, 30)),
    ema20_1h: round(ema20_1h, 6),
    ema50_1h: round(ema50_1h, 6),
    ema20_4h: round(ema20_4h, 6),
    ema50_4h: round(ema50_4h, 6),
    sma50_1d: round(sma50, 6),
    sma200_1d: round(sma200, 6),
    trend_1h: trendOf(ema20_1h, ema50_1h, price),
    trend_4h: trendOf(ema20_4h, ema50_4h, price),
    trend_1d: sma200 !== null ? trendOf(sma50, sma200, price, 1) : trendOf(ema(d1Live, 10), sma50, price, 0.5),
    rsi14_1h: round(rsi(h1Live), 1),
    rsi14_4h: round(rsi([...h4, price]), 1),
    rsi14_1d: round(rsi(d1Live), 1),
    atr_1h: round(atr1h, 6),
    atr_pct_1h: atr1h ? round((atr1h / price) * 100, 3) : null,
    atr_pct_4h: atr4h ? round((atr4h / price) * 100, 3) : null,
    atr_pct_1d: atr1d ? round((atr1d / price) * 100, 3) : null,
    bb_lower_1h: bb ? round(bb.lower, 6) : null,
    bb_upper_1h: bb ? round(bb.upper, 6) : null,
    bb_pct_b_1h: bb && bb.upper > bb.lower ? round((price - bb.lower) / (bb.upper - bb.lower), 3) : null,
    high_20x4h: round(high20, 6),
    low_20x4h: round(low20, 6),
    breakout_4h: high20 !== null && price > high20,
    vol_7d_pct: round(realizedVol(h1, 24 * 7, 1), 1),
    vol_30d_pct: round(dailyVol, 1),
    volume_ratio_24h: avgDaily > 0 ? round(vol24 / avgDaily, 2) : null,
    move_zscore_24h: ret24 !== null && typicalDailyMovePct ? round(ret24 / typicalDailyMovePct, 2) : null,
    closes_1h: h1.slice(-24 * 30),
  }
}

/** The broad market regime, read from BTC and from breadth across the universe. */
export const classifyRegime = (all: Features[]): RegimeSnapshot => {
  const btc = all.find((f) => f.symbol === "BTC/USD") ?? all[0]
  if (!btc) return { label: "unknown", btc_trend: null, btc_vol_pct: null, breadth_pct: null, notes: ["no features available"] }
  const above = all.filter((f) => f.ema50_4h !== null && f.price > f.ema50_4h).length
  const breadth = all.length ? (above / all.length) * 100 : null
  const notes: string[] = []
  let label: RegimeSnapshot["label"]
  if (btc.vol_30d_pct !== null && btc.vol_30d_pct > 90) {
    label = "high_volatility"
    notes.push(`BTC 30d realized vol ${btc.vol_30d_pct}% is extreme`)
  } else if (btc.trend_1d === "up" && (breadth ?? 0) >= 50) {
    label = "risk_on_trend"
  } else if (btc.trend_1d === "down" && (breadth ?? 100) < 50) {
    label = "risk_off_trend"
  } else {
    label = "range"
  }
  if (breadth !== null) notes.push(`${Math.round(breadth)}% of the universe trades above its 4h EMA50`)
  return { label, btc_trend: btc.trend_1d, btc_vol_pct: btc.vol_30d_pct, breadth_pct: round(breadth, 1), notes }
}

/** The features the dashboard shows for a pair (the engine status's symbol health). */
export const symbolFeatures = (f: Features): SymbolFeatures => ({
  ret_24h_pct: f.ret_24h_pct,
  ret_7d_pct: f.ret_7d_pct,
  ret_30d_pct: f.ret_30d_pct,
  rsi14_1h: f.rsi14_1h,
  trend_4h: f.trend_4h,
  trend_1d: f.trend_1d,
  vol_30d_pct: f.vol_30d_pct,
  atr_pct_1h: f.atr_pct_1h,
  volume_ratio_24h: f.volume_ratio_24h,
  as_of: new Date(f.as_of),
})

/** The subset of features worth showing the AI (no raw series). */
export const featuresForPrompt = (f: Features) => {
  const { closes_1h, as_of, bid, ask, ...rest } = f
  return rest
}
