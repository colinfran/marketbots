import {
  BASE_INDEXES,
  type CollectionMap,
  type CommandDoc as CommandDocOf,
  type CycleKind,
  type EngineStatusBase,
  type EventDoc as EventDocOf,
  type IndexSpec,
  type SettingsDoc as SettingsDocOf,
} from "@mb/core/db"
import type { AlpacaAccount, AlpacaClock, AlpacaPosition, AssetClass, Bar, PortfolioHistory } from "./alpaca"
import type { Command } from "./commands"
import type { CycleState, EngineEvent, EngineRunStatus, RiskCheck } from "./events"
import type { OptionRight, OptionStrategy } from "./options"
import type { Action, Decision, Horizon } from "./report"
import type { Phase, Settings } from "./settings"

export { utcDay } from "@mb/core/db"
export type { AgentEpisodeDoc, AgentNoteDoc, AgentWatchDoc } from "@mb/core/agent"
export type {
  AiCallDoc,
  AiTask,
  AuditDoc,
  CommandStatus,
  CycleKind,
  EngineStateDoc,
  IndexSpec,
  LeaseDoc,
  LoginAttemptDoc,
  NotificationDoc,
  TokenUsage,
} from "@mb/core/db"

/**
 * MongoDB document types and indexes, shared by the engine (the only writer of trading state) and
 * the web app (reads everything; writes only commands, audit entries and owner sign-in records).
 * The documents both bots keep the same way come from @mb/core/db; this file binds them to
 * stock's settings, commands and events and adds stock's own.
 *
 * Everything the bot sees, thinks and does is persisted: cycles (each phase run, step by step),
 * reports (research + structured output + the exact data the AI saw), decisions (each requested
 * action and what the risk engine did with it), orders (every Alpaca order, synced), position
 * plans (stop/target per stock), options positions, daily stats and the event stream.
 */

export const COLLECTIONS = {
  settings: "settings",
  engineState: "engine_state",
  lease: "engine_lease",
  events: "events",
  commands: "commands",
  audit: "audit_log",
  notifications: "notifications",
  wireItems: "wire_items",
  wireTriggers: "wire_triggers",
  aiCalls: "ai_calls",
  searchUsage: "search_usage",
  decisions: "decisions",
  orders: "orders",
  plans: "position_plans",
  optionPositions: "option_positions",
  dailyStats: "daily_stats",
  cache: "cache",
  loginAttempts: "login_attempts",
  // The agent (docs/plans/LOCAL-AI.md §8): its episodes, watches and notes.
  agentEpisodes: "agent_episodes",
  agentWatches: "agent_watches",
  agentNotes: "agent_notes",
  // Owner sign-in (Better Auth magic links), written only by the dashboard.
  authUsers: "auth_users",
  authSessions: "auth_sessions",
  authAccounts: "auth_accounts",
  authVerifications: "auth_verifications",
} as const satisfies CollectionMap

export type SettingsDoc = SettingsDocOf<Settings>

export type StreamHealth = { state: "connected" | "connecting" | "disconnected" | "disabled"; last_message_at: Date | null; last_error: string | null }

export type MarketSessionInfo = {
  day: string
  is_trading_day: boolean
  is_open: boolean
  open: Date | null
  close: Date | null
  early_close: boolean
  next_open: Date | null
}

/** Observed state: the engine's heartbeat, written every few seconds. AI calls today count the New York trading day. */
export type EngineStatusDoc = EngineStatusBase<EngineRunStatus, CycleState> & {
  broker: {
    rest: "ok" | "degraded" | "down" | "unknown"
    last_ok_at: Date | null
    last_error: string | null
    options_level: number | null
    trade_stream: StreamHealth
    data_stream: StreamHealth & { symbols: string[] }
  }
  market: MarketSessionInfo | null
  quotes: { symbol: string; price: number; change_pct: number | null; age_s: number }[]
}

export type EventDoc = EventDocOf<EngineEvent>

export type CommandDoc = CommandDocOf<Command>

export type DecisionStatus = "executed" | "rejected" | "failed" | "noop"

export type DecisionOptionDetail = {
  structure_id: string | null
  strategy: OptionStrategy
  legs: { symbol: string; side: "long" | "short" }[]
  contracts: number | null
  /** Net debit per share at the limit (× 100 per contract). */
  limit_price: number | null
  cost_usd: number | null
  max_loss_usd: number | null
  max_profit_usd: number | null
}

export type DecisionDoc = {
  _id: string
  cycle_id: string
  report_id: string
  phase: Phase
  trading_day: string
  created_at: Date
  /** The stock, or the option's underlying. */
  symbol: string
  instrument: "stock" | "option"
  action: Action
  /** The kind of cycle that produced the decision (absent on older decisions). */
  trigger_kind?: CycleKind
  /** Wire items behind an event decision. */
  wire_item_ids?: string[]
  /** The agent episode that made the decision; absent on decisions from before the agent. */
  agent_episode_id?: string
  request: Decision
  status: DecisionStatus
  reason: string | null
  /** Every rule the risk engine evaluated, in order. */
  checks: RiskCheck[]
  price: number | null
  qty: number | null
  notional: number | null
  stop_loss: number | null
  take_profit: number | null
  order_ids: string[]
  option: DecisionOptionDetail | null
}

export type OrderRole = "entry" | "exit" | "take_profit" | "stop_loss" | "spread"

export type OrderDoc = {
  _id: string
  client_order_id: string
  /** Contract symbol for option legs; "" for multi-leg parents. */
  symbol: string
  asset_class: AssetClass
  /** The stock a contract is on (null for stocks). */
  underlying: string | null
  side: "buy" | "sell" | ""
  type: string
  order_class: string
  role: OrderRole
  position_intent: string | null
  parent_id: string | null
  qty: number | null
  filled_qty: number
  filled_avg_price: number | null
  limit_price: number | null
  stop_price: number | null
  status: string
  created_at: Date
  submitted_at: Date | null
  filled_at: Date | null
  canceled_at: Date | null
  trading_day: string
  decision_id: string | null
  structure_id: string | null
  synced_at: Date
}

/** A core review's word on a holding, kept with its plan. */
export type CorePlanNote = { at: Date; review_id: string; action: string; text: string }

/** The core book keeps this many notes per holding (newest last). */
export const CORE_PLAN_NOTES = 12

/** Which book a stock position belongs to. */
export type Book = "core" | "trading"

/** The live plan for a stock position (options positions carry their own). */
export type PositionPlanDoc = {
  _id: string // symbol
  decision_id: string | null
  stop_loss: number | null
  take_profit: number | null
  horizon: Horizon
  setup: string
  thesis: string
  invalidation: string
  opened_at: Date
  updated_at: Date
  /** Absent on plans from before the core book: "trading". Core holdings have a stop and no take-profit. */
  book?: Book
  /** Core: the owner theme the holding serves. */
  theme?: string | null
  /** Core: when a review last looked at it (null until the first). */
  last_reviewed_at?: Date | null
  /** Core: each review's verdict, newest last (at most CORE_PLAN_NOTES). */
  notes?: CorePlanNote[]
}

/** A plan's book: plans from before the core book are trading plans. */
export const bookOf = (plan: Pick<PositionPlanDoc, "book"> | null | undefined): Book => plan?.book ?? "trading"

export type OptionLeg = {
  symbol: string
  type: OptionRight
  strike: number
  expiration: string
  side: "long" | "short"
  /** Filled price per share. */
  fill_price: number | null
}

export type OptionMark = {
  /** Net midpoint value per share (long legs minus short legs). */
  value: number
  /** What closing at the bid (and buying back short legs at the ask) would get, per share. */
  exit_value: number
  pnl_usd: number
  pnl_pct: number
  underlying_price: number | null
  /** Net delta per share. */
  delta: number | null
  at: Date
}

/** An options position the bot opened: one contract, or a two-leg debit spread. */
export type OptionPositionDoc = {
  _id: string
  underlying: string
  strategy: OptionStrategy
  legs: OptionLeg[]
  /** Contracts (spreads: number of spreads). */
  qty: number
  status: "opening" | "open" | "closing" | "closed"
  /** Net debit paid per share. */
  entry_price: number | null
  cost_usd: number | null
  max_loss_usd: number | null
  /** null = unlimited (long calls). */
  max_profit_usd: number | null
  stop_loss_pct: number
  take_profit_pct: number
  underlying_stop: number | null
  underlying_target: number | null
  expiration: string
  thesis: string
  invalidation: string
  decision_id: string | null
  entry_order_id: string | null
  exit_order_id: string | null
  opened_at: Date
  updated_at: Date
  closed_at: Date | null
  exit_price: number | null
  exit_reason: string | null
  realized_pnl_usd: number | null
  mark: OptionMark | null
}

export type DailyStatsDoc = {
  _id: string // trading day
  trading_day: string
  start_equity: number
  end_equity: number
  pnl: number
  pnl_pct: number
  total_return_pct: number
  /** SPY's % change that day. */
  spy_pct?: number | null
  orders_filled: number
  buys: number
  sells: number
  realized_pnl: number
  wins: number
  losses: number
  best: { symbol: string; pnl: number } | null
  worst: { symbol: string; pnl: number } | null
  /**
   * Per book, once the core book holds or trades something (absent before). core: its holdings'
   * value at the close and the day's P&L on them (held shares from yesterday's close or today's buy,
   * shares sold today from yesterday's close to the sale); trading: the rest of the day's P&L.
   */
  books?: { core: { value: number; pnl: number; pnl_pct: number | null; realized: number; holdings: number }; trading: { pnl: number; realized: number } }
  updated_at: Date
}

/**
 * Alpaca data the engine copies into MongoDB for the dashboard, so the website never calls Alpaca
 * (and holds no broker keys). Keys: "alpaca:account", "alpaca:history:<range>", "chart:<SYMBOL>".
 */
export type CacheDoc = { _id: string; data: unknown; fetched_at: Date; expires_at: Date }

export type AccountSnapshot = { account: AlpacaAccount; positions: AlpacaPosition[]; clock: AlpacaClock; as_of: string }

export type HistoryRangeKey = "1D" | "1W" | "1M" | "1A"
export type CachedHistory = PortfolioHistory

/** Chart-ready bars per range (regular session only), written for every symbol the bot touched. */
export type ChartBars = { ranges: { "1D": Bar[]; "1W": Bar[]; "6M": Bar[] }; as_of: string }

/** The shared indexes (@mb/core/db) and stock's own, in this order. */
export const INDEXES: Partial<Record<(typeof COLLECTIONS)[keyof typeof COLLECTIONS], IndexSpec[]>> = {
  events: BASE_INDEXES.events,
  commands: BASE_INDEXES.commands,
  audit_log: BASE_INDEXES.audit_log,
  notifications: BASE_INDEXES.notifications,
  ai_calls: BASE_INDEXES.ai_calls,
  decisions: [{ key: { created_at: -1 } }, { key: { trading_day: 1 } }, { key: { report_id: 1 } }, { key: { symbol: 1, created_at: -1 } }],
  orders: [{ key: { trading_day: 1 } }, { key: { filled_at: -1 } }, { key: { status: 1 } }, { key: { symbol: 1 } }, { key: { underlying: 1 } }, { key: { structure_id: 1 }, sparse: true }],
  option_positions: [{ key: { status: 1 } }, { key: { underlying: 1, opened_at: -1 } }, { key: { closed_at: -1 } }],
  cache: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  wire_items: BASE_INDEXES.wire_items,
  wire_triggers: BASE_INDEXES.wire_triggers,
  login_attempts: BASE_INDEXES.login_attempts,
  agent_episodes: BASE_INDEXES.agent_episodes,
  agent_watches: BASE_INDEXES.agent_watches,
  agent_notes: BASE_INDEXES.agent_notes,
  auth_sessions: BASE_INDEXES.auth_sessions,
  auth_verifications: BASE_INDEXES.auth_verifications,
}
