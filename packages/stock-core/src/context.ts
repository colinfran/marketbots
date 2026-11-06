/**
 * What the engine reads from Alpaca for the agent and the risk checks: technicals, the risk state
 * and option chain contracts.
 */

export type IntradayTechnicals = {
  vwap: number | null
  pct_from_vwap: number | null
  opening_range_high: number | null
  opening_range_low: number | null
  day_high: number | null
  day_low: number | null
  rsi14_5m: number | null
  ema9_5m: number | null
  ema21_5m: number | null
  trend_5m: "up" | "down" | "flat" | null
  change_30m_pct: number | null
}

export type DailyTechnicals = {
  sma20: number | null
  pct_from_sma20: number | null
  sma50: number | null
  pct_from_sma50: number | null
  sma200: number | null
  pct_from_sma200: number | null
  /** The highest high of the last 252 sessions (null with less than a year of bars). */
  high_52w: number | null
  pct_from_high_52w: number | null
  return_5d_pct: number | null
  return_20d_pct: number | null
  atr14: number | null
  atr_pct: number | null
  high_20d: number | null
  low_20d: number | null
  rsi14_daily: number | null
}

/** Deterministic risk state. The AI is told these numbers, and the execution engine enforces them. */
export type RiskState = {
  equity: number
  cash: number
  start_of_day_equity: number
  day_pnl: number
  day_pnl_pct: number
  total_return_pct: number
  deployable_cash: number
  max_position_pct: number
  max_position_usd: number
  open_positions: number
  max_open_positions: number
  trades_today: number
  trades_remaining: number
  circuit_breaker: boolean
  kill_switch: boolean
  new_buys_allowed: boolean
  notes: string[]
}

/** A liquid contract offered to the AI. Prices are per share (× 100 per contract). */
export type ChainContract = {
  symbol: string
  type: "call" | "put"
  expiration: string
  dte: number
  strike: number
  bid: number
  ask: number
  mid: number
  spread_pct: number
  delta: number | null
  iv: number | null
  open_interest: number | null
}

export type OptionChainContext = { underlying: string; price: number | null; contracts: ChainContract[] }
