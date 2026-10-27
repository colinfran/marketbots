import {
  BASE_INDEXES,
  type CollectionMap,
  type CommandDoc as CommandDocOf,
  type CycleDocBase,
  type CycleKind,
  type EngineStatusBase,
  type EventDoc as EventDocOf,
  type IndexSpec,
  type SettingsDoc as SettingsDocOf,
  type TokenUsage,
} from "@mb/core/db"
import type { AlpacaAccount, AlpacaClock, AlpacaPosition, AssetClass, Bar, PortfolioHistory } from "./alpaca"
import type { Command } from "./commands"
import type { MarketContext } from "./context"
import type { CoreAction, CoreHoldingDecision, CoreReviewContext, CoreReviewOutput, CoreWatchItem } from "./core-book"
import type { CycleState, EngineEvent, EngineRunStatus, RiskCheck } from "./events"
import type { OptionRight, OptionStrategy } from "./options"
import type { Action, BotReport, Decision, Horizon } from "./report"
import type { Phase, Settings } from "./settings"
import type { DossierRow } from "./wire"

export { utcDay } from "@mb/core/db"
export type {
  AiCallDoc,
  AiTask,
  AuditDoc,
  CommandStatus,
  CycleKind,
  CycleStep,
  EngineStateDoc,
  IndexSpec,
  LeaseDoc,
  LoginAttemptDoc,
  NotificationDoc,
  SeedAllocation,
  SeedOrder,
  SeedRunDoc,
  SeedRunStatus,
  TokenUsage,
} from "@mb/core/db"

/**
 * MongoDB document types and indexes, shared by the engine (the only writer of trading state) and
 * the web app (reads everything; writes only commands, audit entries and owner sign-in records).
 * The documents both bots keep the same way come from @mb/core/db; this file binds them to
 * stock's settings, commands and events and adds stock's own.
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
  coreReviews: "core_reviews",
  dailyStats: "daily_stats",
  cache: "cache",
  loginAttempts: "login_attempts",
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

/** Observed state: the engine's heartbeat, written every few seconds. The AI budget day is the New York trading day. */
export type EngineStatusDoc = EngineStatusBase<EngineRunStatus, CycleState> & {
  current_phase: Phase | null
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
  last_cycle: { id: string; phase: Phase; at: Date; status: CycleStatus; headline: string | null } | null
}

export type EventDoc = EventDocOf<EngineEvent>

export type CommandDoc = CommandDocOf<Command>

export type CycleStatus = "running" | "succeeded" | "failed" | "skipped" | "timed_out"

/** One run of a phase of the trading day. `trigger` is "schedule", "manual", "price move on NVDA", … */
export type CycleDoc = CycleDocBase<CycleStatus> & {
  phase: Phase
  trading_day: string
  report_id: string | null
  /** A failed cycle's research (no report holds it), and when it was done: the scheduler's retry of the phase reuses it while it's fresh. */
  research?: ResearchResult & { at: Date }
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
  /** The failed attempt (cycle id) whose research this retry reused; it was paid for there. */
  reused_from?: string
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

/** A core review's word on a holding, kept with its plan. */
export type CorePlanNote = { at: Date; review_id: string; action: CoreAction | "adopted"; text: string }

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

/** weekly: the scheduled review (or the owner's "Run core review now"). holding: one holding, after serious news about it. */
export type CoreReviewKind = "weekly" | "holding"

export type CoreReviewStatus = "running" | "done" | "failed" | "skipped"

/** planned: what a dry run would have done. */
export type CoreDecisionStatus = "executed" | "rejected" | "failed" | "noop" | "planned"

/** What code did with one of the review's decisions (or with a holding the review left out, kept by default). */
export type CoreDecisionRecord = {
  symbol: string
  action: CoreAction
  /** Grok's request as normalized; null for a holding it left out. */
  request: CoreHoldingDecision | null
  status: CoreDecisionStatus
  reason: string | null
  /** Every rule evaluated, in order. */
  checks: RiskCheck[]
  /** % of equity before and after (planned or done). */
  weight_before_pct: number | null
  weight_after_pct: number | null
  price: number | null
  /** Shares bought or sold. */
  qty: number | null
  notional: number | null
  /** The holding's stop after the review. */
  stop: number | null
  /** The `decisions` document of a trade, which its orders link to. */
  decision_id: string | null
  order_ids: string[]
}

/** The core book at a moment. Percentages are of equity. */
export type CoreBookState = { equity: number; cash: number; target_pct: number; core_value: number; core_pct: number; holdings: string[] }

/** One run of the core review: what Grok saw and said, and what code did about it. */
export type CoreReviewDoc = {
  _id: string
  cycle_id: string
  kind: CoreReviewKind
  /** "schedule", "manual", "news: …". */
  trigger: string
  /** Single-holding reviews: the holding. */
  symbol: string | null
  dry_run: boolean
  status: CoreReviewStatus
  trading_day: string
  created_at: Date
  finished_at: Date | null
  book_before: CoreBookState | null
  book_after: CoreBookState | null
  /** Seed holdings taken into the core book at the start of this review. */
  adopted: string[]
  /** The ranking the review was shown (its rows are in `context.candidates`). */
  ranking: { day: string; as_of: string | null } | null
  /** Everything the review was given, as Grok saw it. */
  context: CoreReviewContext | null
  research: ResearchResult | null
  /** Grok's answer, normalized. */
  output: CoreReviewOutput | null
  decisions: CoreDecisionRecord[]
  summary: string | null
  /** Names Grok likes but isn't buying; the next weekly review sees them. */
  watch: CoreWatchItem[]
  model: string | null
  cost_usd: number
  error: string | null
  settings_version: number
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

/** The shared indexes (@mb/core/db) and stock's own, in this order. */
export const INDEXES: Partial<Record<(typeof COLLECTIONS)[keyof typeof COLLECTIONS], IndexSpec[]>> = {
  events: BASE_INDEXES.events,
  commands: BASE_INDEXES.commands,
  audit_log: BASE_INDEXES.audit_log,
  notifications: BASE_INDEXES.notifications,
  ai_calls: BASE_INDEXES.ai_calls,
  cycles: [{ key: { started_at: -1 } }, { key: { trading_day: 1, phase: 1 } }],
  reports: [{ key: { created_at: -1 } }, { key: { trading_day: 1, phase: 1 } }, { key: { cycle_id: 1 } }],
  decisions: [{ key: { created_at: -1 } }, { key: { trading_day: 1 } }, { key: { report_id: 1 } }, { key: { symbol: 1, created_at: -1 } }],
  orders: [{ key: { trading_day: 1 } }, { key: { filled_at: -1 } }, { key: { status: 1 } }, { key: { symbol: 1 } }, { key: { underlying: 1 } }, { key: { structure_id: 1 }, sparse: true }],
  option_positions: [{ key: { status: 1 } }, { key: { underlying: 1, opened_at: -1 } }, { key: { closed_at: -1 } }],
  core_reviews: [{ key: { created_at: -1 } }, { key: { kind: 1, dry_run: 1, created_at: -1 } }, { key: { cycle_id: 1 } }],
  cache: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  seed_runs: BASE_INDEXES.seed_runs,
  wire_items: BASE_INDEXES.wire_items,
  wire_triggers: BASE_INDEXES.wire_triggers,
  login_attempts: BASE_INDEXES.login_attempts,
  auth_sessions: BASE_INDEXES.auth_sessions,
  auth_verifications: BASE_INDEXES.auth_verifications,
}
