import type { AlpacaAccount, AlpacaClock, AlpacaPosition, AssetClass, Bar, PortfolioHistory } from "./alpaca"
import type { Command, CommandType } from "./commands"
import type { MarketContext } from "./context"
import type { CycleState, EngineEvent, EngineRunStatus, RiskCheck } from "./events"
import type { OptionRight, OptionStrategy } from "./options"
import type { Action, BotReport, Decision, Horizon } from "./report"
import type { Phase, Settings } from "./settings"
import type { DossierRow, WireStatus } from "./wire"

/**
 * MongoDB document types and indexes, shared by the engine (the only writer of trading state) and
 * the web app (reads everything; writes only commands, audit entries and owner sign-in records).
 *
 * Everything the bot sees, thinks and does is persisted: cycles (each phase run, step by step),
 * reports (research + structured output + the exact data Grok saw), decisions (each requested
 * action and what the risk engine did with it), orders (every Alpaca order, synced), position
 * plans (stop/target per stock), options positions, daily stats and the event stream.
 */

export const COLLECTIONS = {
  settings: "settings",
  engineState: "engine_state",
  engineStatus: "engine_status",
  lease: "engine_lease",
  events: "events",
  commands: "commands",
  audit: "audit_log",
  notifications: "notifications",
  seedRuns: "seed_runs",
  wireItems: "wire_items",
  wireTriggers: "wire_triggers",
  aiCalls: "ai_calls",
  cycles: "cycles",
  reports: "reports",
  decisions: "decisions",
  orders: "orders",
  plans: "position_plans",
  optionPositions: "option_positions",
  dailyStats: "daily_stats",
  cache: "cache",
  loginAttempts: "login_attempts",
  // Owner sign-in (Better Auth magic links), written only by the dashboard.
  authUsers: "auth_users",
  authSessions: "auth_sessions",
  authAccounts: "auth_accounts",
  authVerifications: "auth_verifications",
} as const

export type TokenUsage = { input: number; output: number; total: number }

export type SettingsDoc = { _id: "current"; settings: Settings; version: number; updated_at: Date; updated_by: string }

/** Desired state, changed only by commands (or the engine's own loss limit). Survives restarts. */
export type EngineStateDoc = {
  _id: "engine"
  status: "running" | "paused" | "halted"
  pause_reason: string | null
  kill_switch: { engaged: boolean; reason: string | null; at: Date | null; by: string | null; liquidate: boolean }
  updated_at: Date
}

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

/** Observed state: the engine's heartbeat, written every few seconds. */
export type EngineStatusDoc = {
  _id: "engine"
  at: Date
  instance: string
  version: string
  started_at: Date
  status: EngineRunStatus
  cycle_state: CycleState
  current_task: string | null
  current_phase: Phase | null
  kill_switch: boolean
  ws_clients: number
  event_seq: number
  broker: {
    rest: "ok" | "degraded" | "down" | "unknown"
    last_ok_at: Date | null
    last_error: string | null
    options_level: number | null
    trade_stream: StreamHealth
    data_stream: StreamHealth & { symbols: string[] }
  }
  market: MarketSessionInfo | null
  /** What the scheduler would run now, and why. */
  schedule: { phase: Phase | null; reason: string }
  quotes: { symbol: string; price: number; change_pct: number | null; age_s: number }[]
  ai: {
    models: Settings["ai"]["models"]
    spend_today_usd: number
    budget_usd: number
    calls_today: number
    last_call_at: Date | null
    last_error: string | null
    enabled: boolean
  }
  system: { cpu_pct: number; rss_mb: number; heap_mb: number; load_avg: number[]; uptime_s: number }
  last_cycle: { id: string; phase: Phase; at: Date; status: CycleStatus; headline: string | null } | null
  errors_last_hour: number
  /** The news engine (absent before it shipped). */
  wire?: WireStatus
}

export type LeaseDoc = { _id: "engine"; holder: string; acquired_at: Date; expires_at: Date }

export type EventDoc = EngineEvent & { _id: number; expires_at: Date }

export type CommandStatus = "pending" | "processing" | "done" | "failed" | "rejected"

export type CommandDoc = {
  _id: string
  type: CommandType
  command: Command
  status: CommandStatus
  created_at: Date
  created_by: string
  processed_at: Date | null
  result: string | null
  error: string | null
}

export type AuditDoc = { _id: string; at: Date; actor: string; action: string; target: string | null; details: Record<string, unknown> }

export type NotificationDoc = { _id: string; at: Date; level: "info" | "warning" | "error" | "critical"; title: string; message: string; expires_at: Date }

/** research_gap = the short Grok research that only fills gaps the wire dossier leaves. */
export type AiTask = "research" | "decision" | "research_gap"

export type AiCallDoc = {
  _id: string
  at: Date
  /** New York trading day; the AI budget resets at midnight ET. */
  day: string
  task: AiTask
  model: string
  cycle_id: string | null
  input_tokens: number
  output_tokens: number
  cost_usd: number
  cost_source: "gateway" | "estimate"
  duration_ms: number
  ok: boolean
  error: string | null
}

export type CycleStatus = "running" | "succeeded" | "failed" | "skipped" | "timed_out"

export type CycleStep = { name: string; at: Date; ok: boolean; detail: string | null }

/** What started a cycle (absent on cycles from before it was recorded). */
export type CycleKind = "scheduled" | "price_move" | "manual" | "event" | "seed"

/** One run of a phase of the trading day. */
export type CycleDoc = {
  _id: string
  phase: Phase
  trading_day: string
  /** "schedule", "manual", "price move on NVDA", … */
  trigger: string
  kind?: CycleKind
  status: CycleStatus
  started_at: Date
  finished_at: Date | null
  duration_ms: number | null
  error: string | null
  report_id: string | null
  steps: CycleStep[]
  ai_cost_usd: number
  settings_version: number
  /** Event cycles: the trigger and the wire items that started it. */
  wire_trigger_id?: string | null
  wire_item_ids?: string[]
  /** Why Grok research was skipped (research_mode auto), when it was. */
  research_skip_reason?: string | null
}

export type ResearchSource = { title: string | null; url: string; domain?: string }

export type ResearchResult = {
  memo: string
  sources: ResearchSource[]
  queries: string[]
  model: string
  x_search: boolean
  duration_ms: number
  error: string | null
  usage: TokenUsage
  cost_usd?: number
  /** full = the usual research; gap_fill = only what the wire dossier lacks; skipped = the wire covered it (absent on older docs). */
  mode?: "full" | "gap_fill" | "skipped"
  /** The wire items the AI was given alongside the research (top rows). */
  dossier?: DossierRow[]
}

export type ExecutionSummary = { executed: number; rejected: number; failed: number; noop: number; notes: string[] }

export type ReportDoc = {
  _id: string
  cycle_id: string
  phase: Phase
  trading_day: string
  created_at: Date
  model: string
  attempts: number
  /** True when Grok's output failed the schema and was salvaged in code. */
  repaired: boolean
  research: ResearchResult
  report: BotReport
  context: MarketContext
  execution: ExecutionSummary
  usage: TokenUsage
  cost_usd: number
  settings_version: number
}

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
}

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

export type SeedRunStatus = "scheduled" | "running" | "done" | "failed" | "canceled"

export type SeedAllocation = { symbol: string; weight_pct: number; notional_usd: number; thesis: string }

export type SeedOrder = { symbol: string; decision_id: string | null; status: string; qty: number | null; notional_usd: number | null; reason: string | null }

/**
 * A one-time seed buy, scheduled by the owner. The engine refuses a new one while any run is
 * `done` unless the command sets `force`, so it happens once unless explicitly asked again. A run
 * is a single attempt: a failure is recorded and alerted, never retried automatically.
 */
export type SeedRunDoc = {
  _id: string
  status: SeedRunStatus
  amount_usd: number
  /** When it should run. */
  at: Date
  created_at: Date
  created_by: string
  force: boolean
  started_at: Date | null
  cycle_id: string | null
  result: { allocations: SeedAllocation[]; orders: SeedOrder[]; notes: string[]; rationale: string | null } | null
  error: string | null
  done_at: Date | null
}

/** Rate-limit counter for the dashboard's sign-in endpoints, keyed by a hash of client IP + path. */
export type LoginAttemptDoc = { _id: string; count: number; first_at: Date; expires_at: Date }

/** Minimal index spec (mirrors the driver's IndexDescription so core needs no driver dependency). */
export type IndexSpec = {
  key: Record<string, 1 | -1>
  name?: string
  unique?: boolean
  sparse?: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: Record<string, unknown>
}

export const INDEXES: Partial<Record<(typeof COLLECTIONS)[keyof typeof COLLECTIONS], IndexSpec[]>> = {
  events: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }, { key: { type: 1, _id: -1 } }, { key: { cycle_id: 1 }, sparse: true }],
  commands: [{ key: { status: 1, created_at: 1 } }, { key: { created_at: -1 } }],
  audit_log: [{ key: { at: -1 } }],
  notifications: [{ key: { at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  ai_calls: [{ key: { day: 1 } }, { key: { at: -1 } }],
  cycles: [{ key: { started_at: -1 } }, { key: { trading_day: 1, phase: 1 } }],
  reports: [{ key: { created_at: -1 } }, { key: { trading_day: 1, phase: 1 } }, { key: { cycle_id: 1 } }],
  decisions: [{ key: { created_at: -1 } }, { key: { trading_day: 1 } }, { key: { report_id: 1 } }, { key: { symbol: 1, created_at: -1 } }],
  orders: [{ key: { trading_day: 1 } }, { key: { filled_at: -1 } }, { key: { status: 1 } }, { key: { symbol: 1 } }, { key: { underlying: 1 } }, { key: { structure_id: 1 }, sparse: true }],
  option_positions: [{ key: { status: 1 } }, { key: { underlying: 1, opened_at: -1 } }, { key: { closed_at: -1 } }],
  cache: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  seed_runs: [{ key: { status: 1, at: 1 } }, { key: { created_at: -1 } }],
  wire_items: [
    { key: { first_seen_at: -1 } },
    { key: { symbols: 1, first_seen_at: -1 } },
    { key: { cluster_id: 1 } },
    { key: { severity: -1, first_seen_at: -1 } },
    { key: { source: 1, first_seen_at: -1 } },
    { key: { notable: 1, first_seen_at: -1 } },
    { key: { expires_at: 1 }, expireAfterSeconds: 0 },
  ],
  wire_triggers: [{ key: { at: -1 } }, { key: { status: 1, at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  login_attempts: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  // Better Auth's own field names (camelCase).
  auth_sessions: [{ key: { token: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  auth_verifications: [{ key: { identifier: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
}

/** UTC calendar day, e.g. "2026-10-25" (the news engine's trigger caps reset at 00:00 UTC in both bots). */
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10)
