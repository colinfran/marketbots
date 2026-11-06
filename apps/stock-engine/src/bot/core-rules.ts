import { atr, rsi, sma } from "@mb/core/indicators"
import type { Bar } from "@mb/stock-core/alpaca"
import type { Settings } from "@mb/stock-core/settings"
import { round } from "../market/indicators"

/**
 * The trend core's rules (docs/STOCK.md, "The trend core"), from completed daily bars. Pure:
 *
 *   regime  new entries only while SPY closes above its 200-day average;
 *   entry   a stock above a 50-day average that is above the 200-day, up over 6 months (126
 *           sessions), within 25% of its 52-week high, with a daily ATR of at most 6% and a daily
 *           RSI under 80, ranked by its 6-month return per unit of daily volatility (6-month % ÷
 *           daily ATR %);
 *   stop    `core.stop_atr` daily ATRs below the price, inside risk.min_stop_pct–max_stop_pct; it
 *           then trails at that distance (maintenance);
 *   exit    the trailing stop, or the trend breaking: a close below the 50-day average.
 *
 * Leveraged, inverse and volatility products are left out by name: they decay and don't trend like
 * what they track.
 */

/** Sessions of history a stock needs (the 200-day average, with room). */
const MIN_SESSIONS = 210
const MOMENTUM_SESSIONS = 126
const MAX_ATR_PCT = 6
const MAX_RSI = 80
/** At least this share of the 52-week high. */
const NEAR_HIGH = 0.75

/** Fund names of leveraged, inverse and volatility products. */
export const GEARED_NAME = /\b(\d+(\.\d+)?x|ultra|ultrapro|leveraged|inverse|bear|bull|daily|vix|volatility)\b/i

export type CoreStats = { symbol: string; close: number; sma50: number; sma200: number; high252: number; ret126Pct: number; atrPct: number; rsi: number; strength: number }

export type CorePick = { symbol: string; close: number; stop_pct: number; strength: number; signal: string }

/** A stock's daily stats for the core, from its completed daily bars (oldest first), or null without enough history. */
export const coreStats = (symbol: string, bars: Bar[]): CoreStats | null => {
  if (bars.length < MIN_SESSIONS) return null
  const closes = bars.map((b) => b.c)
  const close = closes.at(-1)!
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)
  const atr14 = atr(bars.map((b) => ({ high: b.h, low: b.l, close: b.c })), 14)
  const rsi14 = rsi(closes, 14)
  const back = closes.at(-(MOMENTUM_SESSIONS + 1)) ?? closes[0]
  if (sma50 === null || sma200 === null || atr14 === null || rsi14 === null || !(close > 0) || !(back > 0)) return null
  const atrPct = (atr14 / close) * 100
  const ret126Pct = (close / back - 1) * 100
  return {
    symbol,
    close,
    sma50,
    sma200,
    high252: Math.max(...bars.slice(-252).map((b) => b.h)),
    ret126Pct,
    atrPct,
    rsi: rsi14,
    strength: atrPct > 0 ? ret126Pct / atrPct : 0,
  }
}

/** Whether the core may open positions: SPY above its 200-day average. */
export const coreRegime = (spy: CoreStats | null): { on: boolean; detail: string } => {
  if (!spy) return { on: false, detail: "SPY's 200-day average is unknown" }
  const vs = round((spy.close / spy.sma200 - 1) * 100, 2)!
  return { on: spy.close > spy.sma200, detail: `SPY ${vs >= 0 ? "+" : ""}${vs}% vs its 200-day average` }
}

/** Every stock that qualifies for the core, strongest first, with its stop distance. */
export const coreCandidates = (stats: CoreStats[], settings: Settings): CorePick[] => {
  const r = settings.risk
  return stats
    .filter((s) => s.close >= r.min_price && s.close > s.sma50 && s.sma50 > s.sma200 && s.ret126Pct > 0 && s.close >= NEAR_HIGH * s.high252 && s.atrPct <= MAX_ATR_PCT && s.rsi < MAX_RSI)
    .sort((a, b) => b.strength - a.strength)
    .map((s) => {
      const stopPct = Math.min(r.max_stop_pct, Math.max(r.min_stop_pct, settings.core.stop_atr * s.atrPct))
      return {
        symbol: s.symbol,
        close: s.close,
        stop_pct: round(stopPct, 2)!,
        strength: round(s.strength, 3)!,
        signal: `Trend core: ${round((s.close / s.sma50 - 1) * 100, 1)}% above a 50-day average ${round((s.sma50 / s.sma200 - 1) * 100, 1)}% over the 200-day; 6-month ${round(s.ret126Pct, 1)}% at ${round(s.atrPct, 2)}% daily ATR (strength ${round(s.strength, 2)}); ${round((s.close / s.high252) * 100, 0)}% of its 52-week high`,
      }
    })
}

/** A core position's trend broke: its last close below its 50-day average. */
export const coreTrendBroken = (s: Pick<CoreStats, "close" | "sma50">) => s.close < s.sma50
