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
import type { Command } from "./commands"
import type { CycleState, EngineEvent, EngineRunStatus, EvidenceKind } from "./events"
import type { Settings } from "./settings"
import type { StrategyId } from "./strategies"
import type { AccountId, Mode, Venue } from "./venues"

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
 * crypto's settings, commands and events and adds crypto's own.
 *
 * Raw market data is not stored: candles come from Kraken on demand and only compact snapshots,
 * decisions and fills are kept. High-volume collections expire automatically (TTL indexes).
 */

export const COLLECTIONS = {
  settings: "settings",
  engineState: "engine_state",
  lease: "engine_lease",
  events: "events",
  commands: "commands",
  audit: "audit_log",
  accounts: "accounts",
  positions: "positions",
  orders: "orders",
  fills: "fills",
  decisions: "decisions",
  snapshots: "portfolio_snapshots",
  dailyStats: "daily_stats",
  aiCalls: "ai_calls",
  searchUsage: "search_usage",
  notifications: "notifications",
  wireItems: "wire_items",
  wireTriggers: "wire_triggers",
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

/** Observed state: the engine's heartbeat, written every few seconds. The wire block is absent while the wire is off. */
export type EngineStatusDoc = EngineStatusBase<EngineRunStatus, CycleState> & {
  kraken: VenueHealth
  paper_wallet: PaperWalletHealth
  symbols: SymbolHealth[]
  reconciliation: { ok: boolean; at: Date; issues: string[] } | null
}

export type EventDoc = EventDocOf<EngineEvent>

export type CommandDoc = CommandDocOf<Command>

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

export type RegimeSnapshot = {
  label: "risk_on_trend" | "risk_off_trend" | "range" | "high_volatility" | "unknown"
  btc_trend: "up" | "down" | "flat" | null
  btc_vol_pct: number | null
  breadth_pct: number | null
  notes: string[]
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
  /** The agent episode that made the decision; absent on decisions from before the agent. */
  agent_episode_id?: string
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

/** The shared indexes (@mb/core/db) and crypto's own, in this order. */
export const INDEXES: Partial<Record<(typeof COLLECTIONS)[keyof typeof COLLECTIONS], IndexSpec[]>> = {
  events: BASE_INDEXES.events,
  commands: BASE_INDEXES.commands,
  audit_log: BASE_INDEXES.audit_log,
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
  decisions: [
    { key: { created_at: -1 } },
    { key: { cycle_id: 1 } },
    { key: { instrument: 1, created_at: -1 } },
    { key: { outcome_due_at: 1 }, name: "outcome_pending", partialFilterExpression: { outcome: null } },
  ],
  portfolio_snapshots: [{ key: { account_id: 1, at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  daily_stats: [{ key: { account_id: 1, day: -1 } }],
  ai_calls: BASE_INDEXES.ai_calls,
  notifications: BASE_INDEXES.notifications,
  wire_items: BASE_INDEXES.wire_items,
  wire_triggers: BASE_INDEXES.wire_triggers,
  login_attempts: BASE_INDEXES.login_attempts,
  agent_episodes: BASE_INDEXES.agent_episodes,
  agent_watches: BASE_INDEXES.agent_watches,
  agent_notes: BASE_INDEXES.agent_notes,
  auth_sessions: BASE_INDEXES.auth_sessions,
  auth_verifications: BASE_INDEXES.auth_verifications,
}
