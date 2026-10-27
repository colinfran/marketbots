/** The subset of Alpaca REST API shapes this app relies on. Numbers arrive as strings. */

export type AssetClass = "us_equity" | "us_option" | "crypto"

export type AlpacaAccount = {
  id: string
  status: string
  currency: string
  cash: string
  equity: string
  last_equity: string
  buying_power: string
  long_market_value: string
  portfolio_value: string
  trading_blocked: boolean
  account_blocked: boolean
  options_buying_power?: string
  options_approved_level?: number
  options_trading_level?: number
}

export type AlpacaClock = {
  timestamp: string
  is_open: boolean
  next_open: string
  next_close: string
}

export type AlpacaCalendarDay = {
  date: string
  open: string
  close: string
}

export type AlpacaPosition = {
  symbol: string
  /** Missing on older payloads; treat as us_equity. */
  asset_class?: AssetClass
  qty: string
  qty_available: string
  /** Per share; for options, the premium per share (× 100 per contract). */
  avg_entry_price: string
  current_price: string
  lastday_price: string
  /** Dollars, including the 100× contract multiplier for options. */
  market_value: string
  cost_basis: string
  unrealized_pl: string
  unrealized_plpc: string
  unrealized_intraday_pl: string
  unrealized_intraday_plpc: string
  change_today: string
  side: "long" | "short"
}

export type AlpacaOrderStatus =
  | "new"
  | "partially_filled"
  | "filled"
  | "done_for_day"
  | "canceled"
  | "expired"
  | "replaced"
  | "pending_cancel"
  | "pending_replace"
  | "pending_new"
  | "accepted"
  | "accepted_for_bidding"
  | "held"
  | "stopped"
  | "rejected"
  | "suspended"
  | "calculated"

export type PositionIntent = "buy_to_open" | "buy_to_close" | "sell_to_open" | "sell_to_close"

export type AlpacaOrder = {
  id: string
  client_order_id: string
  created_at: string
  updated_at: string | null
  submitted_at: string | null
  filled_at: string | null
  canceled_at: string | null
  expired_at: string | null
  failed_at: string | null
  /** Empty for multi-leg (mleg) parents; the legs carry the contract symbols. */
  symbol: string
  asset_class?: AssetClass
  qty: string | null
  notional: string | null
  filled_qty: string
  filled_avg_price: string | null
  order_class: "" | "simple" | "bracket" | "oco" | "oto" | "mleg"
  type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop"
  side: "buy" | "sell" | ""
  time_in_force: string
  limit_price: string | null
  stop_price: string | null
  status: AlpacaOrderStatus
  position_intent?: PositionIntent | null
  ratio_qty?: string | null
  legs: AlpacaOrder[] | null
}

export type NewOrderLeg = { symbol: string; ratio_qty: string; side: "buy" | "sell"; position_intent: PositionIntent }

export type NewOrder = {
  /** Omitted for mleg orders. */
  symbol?: string
  side?: "buy" | "sell"
  type: "market" | "limit" | "stop"
  time_in_force: "day" | "gtc"
  qty: string
  /** For mleg orders: positive = net debit paid, negative = net credit received. */
  limit_price?: string
  order_class?: "simple" | "bracket" | "oco" | "mleg"
  take_profit?: { limit_price: string }
  stop_loss?: { stop_price: string }
  position_intent?: PositionIntent
  legs?: NewOrderLeg[]
  client_order_id?: string
}

export type AlpacaAsset = {
  symbol: string
  name: string
  class: string
  exchange: string
  status: "active" | "inactive"
  tradable: boolean
  fractionable: boolean
  options_enabled?: boolean
}

export type PortfolioHistory = {
  timestamp: number[]
  equity: (number | null)[]
  profit_loss: (number | null)[]
  profit_loss_pct: (number | null)[]
  base_value: number
  timeframe: string
}

export type Bar = {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
  vw: number
  n: number
}

export type Snapshot = {
  latestTrade?: { p: number; t: string }
  latestQuote?: { ap: number; bp: number; t: string }
  minuteBar?: Bar
  dailyBar?: Bar
  prevDailyBar?: Bar
}

export type Mover = { symbol: string; price: number; change: number; percent_change: number }

export type MostActive = { symbol: string; volume: number; trade_count: number }

export type NewsItem = {
  id: number
  headline: string
  summary: string
  source: string
  url: string
  symbols: string[]
  created_at: string
}

export type OptionContract = {
  id: string
  symbol: string
  name: string
  status: "active" | "inactive"
  tradable: boolean
  expiration_date: string
  root_symbol?: string
  underlying_symbol: string
  type: "call" | "put"
  style: "american" | "european"
  strike_price: string
  size?: string
  multiplier?: string
  open_interest?: string | null
  open_interest_date?: string | null
  close_price?: string | null
  close_price_date?: string | null
}

export type OptionSnapshot = {
  latestTrade?: { p: number; s?: number; t: string }
  latestQuote?: { ap: number; as?: number; bp: number; bs?: number; t: string }
  greeks?: { delta: number; gamma: number; theta: number; vega: number; rho: number }
  impliedVolatility?: number
  dailyBar?: Bar
  prevDailyBar?: Bar
}

/** One message on the trading API's trade_updates stream. */
export type TradeUpdate = {
  event: string
  order: AlpacaOrder
  price?: string
  qty?: string
  position_qty?: string
  timestamp?: string
  execution_id?: string
}
