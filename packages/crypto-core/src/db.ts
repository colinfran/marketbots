import type { BacktestParams, Command, CommandType } from "./commands"
import type { CycleState, EngineEvent, EngineRunStatus, EvidenceKind } from "./events"
import type { PerformanceMetrics, TradeStats } from "./metrics"
import type { Settings } from "./settings"
import type { StrategyId } from "./strategies"
import type { DossierRow, WireStatus } from "./wire"
import type { AccountId, Mode, Venue } from "./venues"

/**
 * MongoDB document types and indexes, shared by the engine (the only writer of trading state) and
 * the web app (reads everything; writes only commands, audit entries and owner sign-in records).
 *
 * Raw market data is not stored: candles come from Kraken on demand and only compact snapshots,
 * decisions and fills are kept. High-volume collections expire automatically (TTL indexes).
 */

export const COLLECTIONS = {
  settings: "settings",
  engineState: "engine_state",
  engineStatus: "engine_status",
  lease: "engine_lease",
  events: "events",
  commands: "commands",
  audit: "audit_log",
  accounts: "accounts",
  positions: "positions",
  orders: "orders",
  fills: "fills",
  cycles: "cycles",
  research: "research",
  decisions: "decisions",
  snapshots: "portfolio_snapshots",
  dailyStats: "daily_stats",
  aiCalls: "ai_calls",
  backtests: "backtests",
  notifications: "notifications",
  seedRuns: "seed_runs",
  wireItems: "wire_items",
  wireTriggers: "wire_triggers",
  loginAttempts: "login_attempts",
  // Owner sign-in (Better Auth magic links), written only by the dashboard.
  authUsers: "auth_users",
  authSessions: "auth_sessions",
  authAccounts: "auth_accounts",
  authVerifications: "auth_verifications",
} as const

export type TokenUsage = { input: number; output: number; total: number }

export type SettingsDoc = { _id: "current"; settings: Settings; version: number; updated_at: Date; updated_by: string }

/** Desired state, changed only by commands (or the engine's own drawdown halt). Survives restarts. */
export type EngineStateDoc = {
  _id: "engine"
  status: "running" | "paused" | "halted"
  pause_reason: string | null
  kill_switch: { engaged: boolean; reason: string | null; at: Date | null; by: string | null; liquidate: boolean }
  updated_at: Date
}

export type VenueHealth = {
  rest: "ok" | "degraded" | "down" | "unknown"
  ws: "connected" | "connecting" | "disconnected"
  last_message_at: Date | null
  last_error: string | null
  /** Kraken's system status (online / maintenance / cancel_only / post_only). */
  status_text: string | null
}

/** The Kraken CLI paper wallet that executes every order. */
export type PaperWalletHealth = {
  ok: boolean
  cli_version: string | null
  workspace: string
  fee_bps: number | null
  slippage_bps: number | null
  last_error: string | null
  last_checked_at: Date | null
}

/** Indicator summary from the latest cycle, for the Markets page. */
export type SymbolFeatures = {
  ret_24h_pct: number | null
  ret_7d_pct: number | null
  ret_30d_pct: number | null
  rsi14_1h: number | null
  trend_4h: "up" | "down" | "flat" | null
  trend_1d: "up" | "down" | "flat" | null
  vol_30d_pct: number | null
  atr_pct_1h: number | null
  volume_ratio_24h: number | null
  as_of: Date
}

export type SymbolHealth = {
  symbol: string
  bid: number | null
  ask: number | null
  last: number | null
  change_pct: number | null
  age_s: number | null
  stale: boolean
  features: SymbolFeatures | null
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
  kill_switch: boolean
  ws_clients: number
  event_seq: number
  kraken: VenueHealth
  paper_wallet: PaperWalletHealth
  symbols: SymbolHealth[]
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
  last_cycle: { id: string; at: Date; status: string; summary: string | null } | null
  next_cycle_at: Date | null
  reconciliation: { ok: boolean; at: Date; issues: string[] } | null
  errors_last_hour: number
  /** The news engine (absent before it shipped, or while it is off). */
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

export type AuditDoc = {
  _id: string
  at: Date
  actor: string
  action: string
  target: string | null
  details: Record<string, unknown>
}

export type AccountDoc = {
  _id: AccountId
  venue: Venue
  mode: Mode
  cash_usd: number
  starting_usd: number
  realized_pnl_usd: number
  fees_usd: number
  /** Last marked equity (cash + positions at mid). */
  equity_usd: number
  exposure_usd: number
  peak_equity_usd: number
  /** UTC day the day-start equity refers to. */
  day: string
  day_start_equity_usd: number
  created_at: Date
  updated_at: Date
  resets: number
  last_reset_at: Date | null
}

export type PositionDoc = {
  _id: string
  account_id: AccountId
  venue: Venue
  mode: Mode
  /** The pair, e.g. "BTC/USD" (instrument and symbol are the same for spot). */
  instrument: string
  symbol: string
  side: "long"
  status: "open" | "closed"
  qty: number
  avg_price: number
  /** Total paid including entry fees, for the coins still held. */
  cost_basis_usd: number
  fees_usd: number
  realized_pnl_usd: number
  opened_at: Date
  updated_at: Date
  closed_at: Date | null
  strategy_id: StrategyId | null
  decision_id: string | null
  thesis: string | null
  invalidation: string | null
  stop_price: number | null
  take_profit_price: number | null
  horizon_hours: number | null
  last_reviewed_at: Date | null
  last_review_price: number | null
  mark_price: number | null
  marked_at: Date | null
  exit_reason: string | null
}

export type OrderStatus = "pending_submit" | "submitted" | "filled" | "canceled" | "rejected" | "unknown"

export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(["filled", "canceled", "rejected"])

export type OrderPurpose = "entry" | "reduce" | "exit" | "stop_loss" | "take_profit" | "liquidation" | "manual_close" | "reconciliation"

export type OrderDoc = {
  _id: string
  account_id: AccountId
  venue: Venue
  mode: Mode
  instrument: string
  symbol: string
  side: "buy" | "sell"
  /** Paper wallet orders are market orders; `limit_price` is the engine's pre-trade price guard. */
  type: "market"
  qty: number
  limit_price: number | null
  /** Mid price when the order was created; slippage is measured against it. */
  reference_price: number | null
  status: OrderStatus
  /** The paper wallet's order id. */
  venue_order_id: string | null
  filled_qty: number
  avg_fill_price: number | null
  fees_usd: number
  decision_id: string | null
  position_id: string | null
  purpose: OrderPurpose
  created_at: Date
  submitted_at: Date | null
  updated_at: Date
  reason: string | null
  history: { at: Date; status: OrderStatus; note: string | null }[]
}

export type FillDoc = {
  _id: string
  order_id: string
  account_id: AccountId
  venue: Venue
  mode: Mode
  instrument: string
  symbol: string
  side: "buy" | "sell"
  qty: number
  price: number
  fee_usd: number
  at: Date
  reference_price: number | null
  slippage_bps: number | null
  position_id: string | null
  /** Set on fills that reduce a position. Net of the fees of both legs. */
  realized_pnl_usd: number | null
  /** The paper wallet's trade id: the link reconciliation uses. */
  venue_trade_id: string | null
  decision_id: string | null
  purpose: OrderPurpose
}

export type CandidateRecord = {
  instrument: string
  strategy: StrategyId
  score: number
  signal: string
  features: Record<string, number | string | null>
}

export type RegimeSnapshot = {
  label: "risk_on_trend" | "risk_off_trend" | "range" | "high_volatility" | "unknown"
  btc_trend: "up" | "down" | "flat" | null
  btc_vol_pct: number | null
  breadth_pct: number | null
  notes: string[]
}

/** What started a cycle (absent on cycles from before it was recorded). */
export type CycleKind = "scheduled" | "price_move" | "manual" | "event" | "seed"

export type CycleDoc = {
  _id: string
  trigger: string
  kind?: CycleKind
  status: "running" | "completed" | "skipped" | "failed"
  state: CycleState
  started_at: Date
  finished_at: Date | null
  duration_ms: number | null
  regime: RegimeSnapshot | null
  candidates: CandidateRecord[]
  reviews: string[]
  research_id: string | null
  decision_ids: string[]
  steps: { at: Date; name: string; ok: boolean; detail: string | null }[]
  summary: string | null
  error: string | null
  ai_cost_usd: number
  settings_version: number
  prompt_version: string
  /** Event cycles: the trigger and the wire items that started it. */
  wire_trigger_id?: string | null
  wire_item_ids?: string[]
  /** Why Grok research was skipped (research_mode auto), when it was. */
  research_skip_reason?: string | null
}

export type ResearchSource = { title: string; url: string; domain: string }

export type ResearchDoc = {
  _id: string
  cycle_id: string
  subjects: string[]
  memo: string
  sources: ResearchSource[]
  queries: string[]
  model: string
  prompt_version: string
  x_search: boolean
  started_at: Date
  duration_ms: number
  usage: TokenUsage
  cost_usd: number
  error: string | null
  /** full = the usual research; gap_fill = only what the wire dossier lacks; skipped = the wire covered it (absent on older docs). */
  mode?: "full" | "gap_fill" | "skipped"
  /** The wire items the AI was given alongside the research (top rows). */
  dossier?: DossierRow[]
}

export type EvidenceItem = {
  claim: string
  kind: EvidenceKind
  source_url: string | null
  as_of: string | null
  /** True only if source_url is one of the URLs research actually retrieved. */
  verified_source: boolean
}

export type DecisionAction = "buy" | "hold" | "reduce" | "close" | "no_trade"

export type RiskCheck = { name: string; ok: boolean; detail: string }

export type DecisionOutcome = {
  evaluated_at: Date
  horizon_hours: number
  price_at_decision: number | null
  price_at_horizon: number | null
  forward_return_pct: number | null
  /** Which exit level the price touched first within the horizon. */
  hit: "target" | "stop" | "neither" | null
  /** Did the decision turn out right, net of round-trip costs? null when it can't be judged. */
  correct: boolean | null
}

export type DecisionDoc = {
  _id: string
  cycle_id: string
  research_id: string | null
  account_id: AccountId
  mode: Mode
  instrument: string
  symbol: string
  strategy_id: StrategyId | null
  created_at: Date
  /** Timestamp of the market data the decision used, and its age when the AI answered. */
  data_as_of: Date | null
  data_age_s: number | null
  action: DecisionAction
  held: boolean
  /** The kind of cycle that produced the decision (absent on older decisions). */
  trigger_kind?: CycleKind
  /** Wire items behind an event decision, and items it cited. */
  wire_item_ids?: string[]
  ai: {
    conviction: number
    uncertainty: "low" | "medium" | "high"
    thesis: string
    bull_evidence: EvidenceItem[]
    bear_evidence: EvidenceItem[]
    risks: string[]
    invalidation: string
    horizon_hours: number
    priced_in: "not_priced" | "partially" | "fully" | "unknown"
    stop_loss: number | null
    take_profit: number | null
    size_pct_of_max: number | null
    reduce_pct: number | null
    p_target_first: number | null
    /** Adjustments normalization made to the AI's answer (e.g. an impossible action). */
    notes: string[]
  }
  quant: {
    price: number | null
    bid: number | null
    ask: number | null
    spread_bps: number | null
    atr_pct: number | null
    signal: string | null
    score: number | null
    features: Record<string, number | string | null>
    /** What the deterministic screen alone would have done (the no-AI baseline). */
    baseline_action: DecisionAction
  }
  costs: {
    fee_bps: number | null
    spread_bps: number | null
    slippage_bps: number | null
    round_trip_bps: number | null
    fee_usd_est: number | null
  }
  ev: {
    p_prior: number | null
    p_adjusted: number | null
    gross_edge_bps: number | null
    net_edge_bps: number | null
  }
  sizing: {
    qty: number | null
    notional_usd: number | null
    risk_usd: number | null
    limit_price: number | null
    stop_price: number | null
    take_profit_price: number | null
    notes: string[]
  }
  risk: { approved: boolean; resized: boolean; checks: RiskCheck[]; reasons: string[] } | null
  execution: {
    status: "not_applicable" | "skipped" | "filled" | "partial" | "failed" | "rejected"
    order_ids: string[]
    filled_qty: number
    avg_price: number | null
    notes: string[]
  }
  model: string
  prompt_version: string
  settings_version: number
  /** When the decision's horizon ends and its outcome can be scored. */
  outcome_due_at: Date
  outcome: DecisionOutcome | null
}

export type SnapshotDoc = {
  _id: string
  account_id: AccountId
  at: Date
  equity_usd: number
  cash_usd: number
  exposure_usd: number
  positions: number
  expires_at: Date
}

export type DailyStatsDoc = {
  _id: string
  account_id: AccountId
  day: string
  start_equity_usd: number
  end_equity_usd: number
  pnl_usd: number
  pnl_pct: number
  trades: number
  wins: number
  losses: number
  fees_usd: number
  updated_at: Date
}

/** research_gap = the short Grok research that only fills gaps the wire dossier leaves. */
export type AiTask = "research" | "decision" | "research_gap"

export type AiCallDoc = {
  _id: string
  at: Date
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

export type BacktestTrade = {
  symbol: string
  strategy: StrategyId
  entry_at: Date
  exit_at: Date
  entry_price: number
  exit_price: number
  qty: number
  pnl_usd: number
  return_pct: number
  exit_reason: string
  regime: string
}

export type BacktestDoc = {
  _id: string
  created_at: Date
  finished_at: Date | null
  status: "running" | "completed" | "failed"
  params: BacktestParams
  metrics: PerformanceMetrics | null
  in_sample: PerformanceMetrics | null
  out_of_sample: PerformanceMetrics | null
  by_strategy: Record<string, TradeStats>
  by_symbol: Record<string, TradeStats>
  by_regime: Record<string, TradeStats>
  benchmarks: { buy_hold_btc_pct: number | null; equal_weight_pct: number | null }
  equity_curve: { t: number; equity: number }[]
  trades: BacktestTrade[]
  notes: string[]
  error: string | null
}

export type NotificationDoc = {
  _id: string
  at: Date
  level: "info" | "warning" | "error" | "critical"
  title: string
  message: string
  expires_at: Date
}

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
  events: [
    { key: { expires_at: 1 }, expireAfterSeconds: 0 },
    { key: { type: 1, _id: -1 } },
    { key: { cycle_id: 1 }, sparse: true },
  ],
  commands: [{ key: { status: 1, created_at: 1 } }, { key: { created_at: -1 } }],
  audit_log: [{ key: { at: -1 } }],
  positions: [
    { key: { account_id: 1, status: 1 } },
    {
      key: { account_id: 1, instrument: 1 },
      name: "one_open_position_per_instrument",
      unique: true,
      partialFilterExpression: { status: "open" },
    },
    { key: { closed_at: -1 } },
  ],
  orders: [{ key: { account_id: 1, status: 1 } }, { key: { created_at: -1 } }, { key: { decision_id: 1 } }],
  fills: [
    { key: { at: -1 } },
    { key: { account_id: 1, at: -1 } },
    { key: { order_id: 1 } },
    { key: { decision_id: 1 } },
    { key: { venue_trade_id: 1 }, sparse: true },
  ],
  cycles: [{ key: { started_at: -1 } }],
  research: [{ key: { started_at: -1 } }, { key: { cycle_id: 1 } }],
  decisions: [
    { key: { created_at: -1 } },
    { key: { cycle_id: 1 } },
    { key: { instrument: 1, created_at: -1 } },
    { key: { outcome_due_at: 1 }, name: "outcome_pending", partialFilterExpression: { outcome: null } },
  ],
  portfolio_snapshots: [{ key: { account_id: 1, at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  daily_stats: [{ key: { account_id: 1, day: -1 } }],
  ai_calls: [{ key: { day: 1 } }, { key: { at: -1 } }],
  backtests: [{ key: { created_at: -1 } }],
  notifications: [{ key: { at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
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

/** UTC calendar day, e.g. "2026-10-25". Daily limits and budgets reset at 00:00 UTC. */
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10)
