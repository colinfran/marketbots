import type { OptionStrategy } from "./options"
import type { Phase } from "./settings"

/**
 * The factual snapshot handed to Grok on every cycle (built by the engine from Alpaca), stored
 * with each report so every decision can be audited against exactly what the bot saw.
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

/** Deterministic risk state. Grok is told these numbers, and the execution engine enforces them. */
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
  profit_lock: boolean
  kill_switch: boolean
  new_buys_allowed: boolean
  notes: string[]
}

export type Quote = {
  symbol: string
  price: number | null
  change_pct: number | null
  prev_close: number | null
  open: number | null
  high: number | null
  low: number | null
  day_vwap: number | null
  iex_volume: number | null
  last_trade_et: string | null
}

export type Instrument = {
  symbol: string
  tags: string[]
  quote: Quote | null
  intraday: IntradayTechnicals | null
  daily: DailyTechnicals | null
}

export type PositionContext = {
  symbol: string
  qty: number
  avg_entry: number
  price: number
  market_value: number
  unrealized_pl: number
  unrealized_pl_pct: number
  today_pl_pct: number
  stop_loss: number | null
  take_profit: number | null
  horizon: string | null
  thesis: string | null
  invalidation: string | null
  opened_at_et: string | null
  /** Trading day the position was opened, so multi-day holds show their age. */
  opened_on: string | null
  has_exit_orders: boolean
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

export type OptionPositionContext = {
  id: string
  underlying: string
  strategy: OptionStrategy
  legs: string[]
  contracts: number
  paid: number | null
  value: number | null
  pnl_usd: number | null
  pnl_pct: number | null
  dte: number
  underlying_price: number | null
  stop_loss_pct: number
  take_profit_pct: number
  underlying_stop: number | null
  underlying_target: number | null
  thesis: string | null
  opened_at_et: string
}

export type OptionsContext = {
  enabled: boolean
  new_positions_allowed: boolean
  premium_open_usd: number
  premium_open_pct: number
  max_total_premium_pct: number
  max_premium_per_trade_pct: number
  max_premium_per_trade_usd: number
  open_positions: number
  max_open_positions: number
  min_conviction: number
  allow_spreads: boolean
  dte_range: [number, number]
  delta_range: [number, number]
  default_stop_loss_pct: number
  default_take_profit_pct: number
  positions: OptionPositionContext[]
  chains: OptionChainContext[]
  notes: string[]
}

/** A core book holding as the trading cycles see it: read-only, the weekly core review manages it. */
export type CoreLineContext = { symbol: string; qty: number; market_value: number; weight_pct: number; unrealized_pl_pct: number; stop: number | null; theme: string | null }

export type MarketContext = {
  generated_at: string
  now_et: string
  trading_day: string
  phase: Phase
  session: {
    open_et: string | null
    close_et: string | null
    is_open: boolean
    early_close: boolean
    minutes_to_open: number | null
    minutes_to_close: number | null
  }
  risk: RiskState & { min_conviction: number; max_new_buys_this_cycle: number; rebuy_cooldown_minutes: number }
  /** Trading positions only, while the core book is on. */
  positions: PositionContext[]
  /** The core book, while it is on (absent otherwise and on older reports). Trading stays under `trading_cap_pct` of equity. */
  core?: { target_pct: number; value: number; pct: number; trading_cap_pct: number; holdings: CoreLineContext[] }
  open_orders: { symbol: string; side: string; type: string; qty: number | null; limit_price: number | null; stop_price: number | null; status: string }[]
  benchmarks: Quote[]
  instruments: Instrument[]
  movers: {
    gainers: { symbol: string; price: number; change_pct: number }[]
    losers: { symbol: string; price: number; change_pct: number }[]
    most_active: { symbol: string; price: number | null; change_pct: number | null; iex_volume: number }[]
  }
  news: { at_et: string; symbols: string[]; headline: string; source: string; url: string }[]
  options: OptionsContext
  briefing: {
    headline: string
    summary: string
    stance: string
    watchlist: { symbol: string; setup: string; trigger: string; stop_loss: number | null; take_profit: number | null; conviction: number }[]
  } | null
  previous_cycle: { at_et: string; phase: Phase; headline: string; next_focus: string } | null
  /** Owner-requested tickers for this cycle (Admin → "Ask the AI"). */
  requested: string[]
  today: {
    decisions: { at_et: string; symbol: string; action: string; status: string; reason: string | null }[]
    fills: { at_et: string; symbol: string; side: string; qty: number; price: number; role: string; realized_pnl: number | null }[]
    realized_pnl: number
  }
  memory: {
    recent_days: { day: string; pnl: number; pnl_pct: number; spy_pct: number | null; lessons: string[] }[]
    profitable_days: number
    total_days: number
  }
}
