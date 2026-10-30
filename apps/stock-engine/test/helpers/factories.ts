import type { AlpacaAccount, AlpacaOrder, AlpacaPosition, Bar } from "@mb/stock-core/alpaca"
import type { DecisionDoc, OptionPositionDoc, OrderDoc, PositionPlanDoc } from "@mb/stock-core/db"
import type { BotReport, Decision } from "@mb/stock-core/report"
import { marketTime } from "@mb/stock-core/time"
import type { Session } from "../../src/bot/session"

/** Typed builders for every domain object, with realistic defaults. */

/** A normal Monday session in EDT: 09:30–16:00 ET = 13:30–20:00 UTC. */
export const DAY = "2026-10-26"
export const OPEN = new Date("2026-10-26T13:30:00.000Z")
export const CLOSE = new Date("2026-10-26T20:00:00.000Z")

/** An instant `minutes` after the 09:30 open of DAY (negative = before). */
export const afterOpen = (minutes: number) => new Date(OPEN.getTime() + minutes * 60_000)
/** An instant `minutes` before the 16:00 close of DAY (negative = after). */
export const beforeClose = (minutes: number) => new Date(CLOSE.getTime() - minutes * 60_000)

export const session = (overrides: Partial<Session> = {}): Session => ({
  day: DAY,
  is_trading_day: true,
  open: OPEN,
  close: CLOSE,
  open_et: "09:30",
  close_et: "16:00",
  early_close: false,
  ...overrides,
})

export const closedSession = (day = "2026-10-25"): Session => ({
  day,
  is_trading_day: false,
  open: null,
  close: null,
  open_et: null,
  close_et: null,
  early_close: false,
})

export const decision = (overrides: Partial<Decision> = {}): Decision => ({
  symbol: "AAPL",
  action: "buy",
  allocation_pct: 10,
  sell_pct: null,
  stop_loss: null,
  take_profit: null,
  horizon: "intraday",
  setup: "momentum",
  conviction: 7,
  rationale: "Holding VWAP with SPY green.",
  evidence: ["Above VWAP 201.10", "RSI 58"],
  invalidation: "Loses VWAP.",
  structure_id: null,
  option: null,
  ...overrides,
})

export const report = (overrides: Partial<BotReport> = {}): BotReport => ({
  headline: "Tech leads a quiet open",
  summary: "Futures are flat. The bot waits for confirmation.",
  market: { sentiment: "neutral", regime: "range_bound", stance: "normal", confidence: 60, key_drivers: ["CPI at 8:30"] },
  catalysts: [],
  watchlist: [],
  decisions: [],
  risks: [{ risk: "CPI surprise", severity: "medium", mitigation: "Small size" }],
  lessons: [],
  next_focus: "Watch SPY 580.",
  notification: "Quiet open; watching tech.",
  sources: [{ title: "Reuters", url: "https://reuters.com/markets" }],
  ...overrides,
})

export const watchItem = (symbol: string, overrides: Partial<BotReport["watchlist"][number]> = {}): BotReport["watchlist"][number] => ({
  symbol,
  setup: "breakout",
  thesis: `${symbol} is in play.`,
  trigger: "Breaks the opening range high.",
  entry_low: 100,
  entry_high: 101,
  stop_loss: 98,
  take_profit: 105,
  conviction: 7,
  ...overrides,
})

export const account = (overrides: Partial<AlpacaAccount> = {}): AlpacaAccount => ({
  id: "acct",
  status: "ACTIVE",
  currency: "USD",
  cash: "10000",
  equity: "10000",
  last_equity: "10000",
  buying_power: "20000",
  long_market_value: "0",
  portfolio_value: "10000",
  trading_blocked: false,
  account_blocked: false,
  ...overrides,
})

export const position = (symbol: string, qty: number, price: number, overrides: Partial<AlpacaPosition> = {}): AlpacaPosition => ({
  symbol,
  qty: String(qty),
  qty_available: String(qty),
  avg_entry_price: String(price),
  current_price: String(price),
  lastday_price: String(price),
  market_value: String(qty * price),
  cost_basis: String(qty * price),
  unrealized_pl: "0",
  unrealized_plpc: "0",
  unrealized_intraday_pl: "0",
  unrealized_intraday_plpc: "0",
  change_today: "0",
  side: "long",
  ...overrides,
})

let orderSeq = 0
export const alpacaOrder = (overrides: Partial<AlpacaOrder> = {}): AlpacaOrder => {
  orderSeq += 1
  return {
    id: `order-${orderSeq}`,
    client_order_id: `client-${orderSeq}`,
    created_at: "2026-10-26T14:00:00.000Z",
    updated_at: null,
    submitted_at: "2026-10-26T14:00:00.000Z",
    filled_at: null,
    canceled_at: null,
    expired_at: null,
    failed_at: null,
    symbol: "AAPL",
    qty: "10",
    notional: null,
    filled_qty: "0",
    filled_avg_price: null,
    order_class: "simple",
    type: "market",
    side: "buy",
    time_in_force: "day",
    limit_price: null,
    stop_price: null,
    status: "new",
    legs: null,
    ...overrides,
  }
}

export const orderDoc = (overrides: Partial<OrderDoc> = {}): OrderDoc => {
  orderSeq += 1
  return {
    _id: `doc-${orderSeq}`,
    client_order_id: `client-${orderSeq}`,
    symbol: "AAPL",
    asset_class: "us_equity",
    underlying: null,
    position_intent: null,
    structure_id: null,
    side: "buy",
    type: "market",
    order_class: "simple",
    role: "entry",
    parent_id: null,
    qty: 10,
    filled_qty: 10,
    filled_avg_price: 100,
    limit_price: null,
    stop_price: null,
    status: "filled",
    created_at: new Date("2026-10-26T14:00:00.000Z"),
    submitted_at: new Date("2026-10-26T14:00:00.000Z"),
    filled_at: new Date("2026-10-26T14:00:01.000Z"),
    canceled_at: null,
    trading_day: DAY,
    decision_id: null,
    synced_at: new Date("2026-10-26T14:00:02.000Z"),
    ...overrides,
  }
}

/** A filled order document; `at` is an ISO string or Date. */
export const fill = (symbol: string, side: "buy" | "sell", qty: number, price: number, at: string | Date, overrides: Partial<OrderDoc> = {}) =>
  orderDoc({
    symbol,
    side,
    qty,
    filled_qty: qty,
    filled_avg_price: price,
    role: side === "buy" ? "entry" : "exit",
    created_at: new Date(at),
    filled_at: new Date(at),
    ...overrides,
  })

export const planDoc = (symbol: string, overrides: Partial<PositionPlanDoc> = {}): PositionPlanDoc => ({
  _id: symbol,
  decision_id: "dec-1",
  stop_loss: 95,
  take_profit: 110,
  horizon: "intraday",
  setup: "momentum",
  thesis: `${symbol} momentum thesis`,
  invalidation: "Loses VWAP.",
  opened_at: afterOpen(20),
  updated_at: afterOpen(20),
  ...overrides,
})

export const decisionDoc = (overrides: Partial<DecisionDoc> = {}): DecisionDoc => {
  const request = decision(overrides.request ?? {})
  return {
    _id: `dec-${++orderSeq}`,
    cycle_id: "cycle-1",
    report_id: "rep-1",
    phase: "intraday",
    trading_day: DAY,
    created_at: afterOpen(30),
    symbol: request.symbol,
    instrument: "stock",
    action: request.action,
    request,
    status: "executed",
    reason: "bought 10 shares",
    checks: [],
    option: null,
    price: 100,
    qty: 10,
    notional: 1000,
    stop_loss: 98,
    take_profit: 104,
    order_ids: [],
    ...overrides,
  }
}

/** A price bar. `t` may be an ISO string or a NY wall-clock "HH:MM" on DAY. */
export const bar = (t: string, c: number, overrides: Partial<Bar> = {}): Bar => ({
  t: /^\d\d:\d\d$/.test(t) ? marketTime(DAY, t).toISOString() : t,
  o: c,
  h: c,
  l: c,
  c,
  v: 1_000,
  vw: c,
  n: 10,
  ...overrides,
})

/** NVDA calls/puts expiring 2026-11-20 (25 days after DAY). */
export const NVDA_CALL_140 = "NVDA261120C00140000"
export const NVDA_CALL_150 = "NVDA261120C00150000"
export const NVDA_PUT_130 = "NVDA261120P00130000"
export const NVDA_PUT_120 = "NVDA261120P00120000"

export const optionPositionDoc = (overrides: Partial<OptionPositionDoc> = {}): OptionPositionDoc => ({
  _id: `opt-${++orderSeq}`,
  underlying: "NVDA",
  strategy: "long_call",
  legs: [{ symbol: NVDA_CALL_140, type: "call", strike: 140, expiration: "2026-11-20", side: "long", fill_price: 5 }],
  qty: 1,
  status: "open",
  entry_price: 5,
  cost_usd: 500,
  max_loss_usd: 500,
  max_profit_usd: null,
  stop_loss_pct: 50,
  take_profit_pct: 100,
  underlying_stop: null,
  underlying_target: null,
  expiration: "2026-11-20",
  thesis: "NVDA breakout into earnings.",
  invalidation: "Loses 135.",
  decision_id: "dec-1",
  entry_order_id: "ord-entry",
  exit_order_id: null,
  opened_at: afterOpen(20),
  updated_at: afterOpen(20),
  closed_at: null,
  exit_price: null,
  exit_reason: null,
  realized_pnl_usd: null,
  mark: null,
  ...overrides,
})
