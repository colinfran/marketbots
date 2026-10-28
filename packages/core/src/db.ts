import type { AiSettingsBase } from "./settings"
import type { WireStatus } from "./wire"

/**
 * MongoDB document types and indexes both bots share. The engine is the only writer of trading
 * state; the web app reads everything and writes only commands, audit entries and owner sign-in
 * records. Each bot adds its own collections, documents and indexes, and binds the generic types
 * below to its settings, commands and events.
 */

/** The collections both bots have, under the same names. */
export const BASE_COLLECTIONS = {
  settings: "settings",
  engineState: "engine_state",
  engineStatus: "engine_status",
  lease: "engine_lease",
  events: "events",
  commands: "commands",
  audit: "audit_log",
  cycles: "cycles",
  aiCalls: "ai_calls",
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

/** A bot's collection map: every base collection under its base name, plus the bot's own (in the bot's order). */
export type CollectionMap = typeof BASE_COLLECTIONS & Readonly<Record<string, string>>

export type BaseCollectionName = (typeof BASE_COLLECTIONS)[keyof typeof BASE_COLLECTIONS]

/** Minimal index spec (mirrors the driver's IndexDescription so core needs no driver dependency). */
export type IndexSpec = {
  key: Record<string, 1 | -1>
  name?: string
  unique?: boolean
  sparse?: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: Record<string, unknown>
}

/** Types index lists as IndexSpec[], keyed by collection names, without spelling the keys twice. */
const indexes = <K extends BaseCollectionName>(lists: Record<K, IndexSpec[]>) => lists

/** Indexes that are the same in both bots. A bot's `INDEXES` lists these and its own, in its own order. */
export const BASE_INDEXES = indexes({
  events: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }, { key: { type: 1, _id: -1 } }, { key: { cycle_id: 1 }, sparse: true }],
  commands: [{ key: { status: 1, created_at: 1 } }, { key: { created_at: -1 } }],
  audit_log: [{ key: { at: -1 } }],
  ai_calls: [{ key: { day: 1 } }, { key: { at: -1 } }],
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
})

export type TokenUsage = { input: number; output: number; total: number }

export type SettingsDoc<S> = { _id: "current"; settings: S; version: number; updated_at: Date; updated_by: string }

/** Desired state, changed only by commands (or the engine's own risk halt). Survives restarts. */
export type EngineStateDoc = {
  _id: "engine"
  status: "running" | "paused" | "halted"
  pause_reason: string | null
  kill_switch: { engaged: boolean; reason: string | null; at: Date | null; by: string | null; liquidate: boolean }
  updated_at: Date
}

/**
 * Observed state: the `engine_status` fields both bots write in their heartbeat every few seconds.
 * Each bot adds its own section (venue or broker health, market, last cycle…).
 */
export type EngineStatusBase<RunStatus extends string, CycleState extends string> = {
  _id: "engine"
  at: Date
  instance: string
  version: string
  started_at: Date
  status: RunStatus
  cycle_state: CycleState
  current_task: string | null
  kill_switch: boolean
  ws_clients: number
  event_seq: number
  ai: {
    models: AiSettingsBase["models"]
    spend_today_usd: number
    budget_usd: number
    calls_today: number
    last_call_at: Date | null
    last_error: string | null
    enabled: boolean
  }
  system: { cpu_pct: number; rss_mb: number; heap_mb: number; load_avg: number[]; uptime_s: number }
  errors_last_hour: number
  /** The news engine (absent before it shipped, and possibly while it is off). */
  wire?: WireStatus
  /** The history store (absent while HISTORY_URL is unset). */
  history?: HistoryStatus
}

/** The history store's health in the heartbeat (docs/plans/LOCAL-AI.md §6). */
export type HistoryStatus = {
  /** Reachable, migrated, and the last bar write and news copy worked. */
  ok: boolean
  /** Connected and migrated at least once since the engine started. */
  ready: boolean
  last_error: string | null
  checked_at: Date
  /** Closed 1-minute bars written since the engine started, dropped (the store was down too long) and waiting. */
  bars: { written: number; dropped: number; buffered: number; last_at: Date | null }
  /** The news archive: items and triggers kept, and the last copies from MongoDB. */
  news: { items: number; triggers: number; last_append_at: Date | null; last_sync_at: Date | null }
}

export type LeaseDoc = { _id: "engine"; holder: string; acquired_at: Date; expires_at: Date }

/** A persisted event: the bot's event `E`, keyed by its `seq`. */
export type EventDoc<E> = E & { _id: number; expires_at: Date }

export type CommandStatus = "pending" | "processing" | "done" | "failed" | "rejected"

/** The command envelope: what the dashboard writes to `commands` and the engine updates as it processes it. */
export type CommandDoc<C extends { type: string }> = {
  _id: string
  type: C["type"]
  command: C
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

export type NotificationDoc = {
  _id: string
  at: Date
  level: "info" | "warning" | "error" | "critical"
  title: string
  message: string
  expires_at: Date
}

/** research_gap = the short Grok research that only fills gaps the wire dossier leaves. */
export type AiTask = "research" | "decision" | "research_gap"

export type AiCallDoc = {
  _id: string
  at: Date
  /** The AI budget day the call counts against (each bot's own day). */
  day: string
  task: AiTask
  model: string
  cycle_id: string | null
  input_tokens: number
  output_tokens: number
  /** Research calls: the web and X tool calls Grok made, each billed (absent on decisions and older docs). */
  searches?: number
  cost_usd: number
  cost_source: "gateway" | "estimate"
  duration_ms: number
  ok: boolean
  error: string | null
}

/** What started a cycle (absent on cycles from before it was recorded). core = a review of the long-term core book. */
export type CycleKind = "scheduled" | "price_move" | "manual" | "event" | "seed" | "core"

export type CycleStep = { name: string; at: Date; ok: boolean; detail: string | null }

/** The `cycles` fields both bots record. Each bot adds its own (phase, regime, candidates…). */
export type CycleDocBase<Status extends string> = {
  _id: string
  /** "schedule", "manual", a price move, a wire trigger… */
  trigger: string
  kind?: CycleKind
  status: Status
  started_at: Date
  finished_at: Date | null
  duration_ms: number | null
  steps: CycleStep[]
  error: string | null
  ai_cost_usd: number
  settings_version: number
  /** Event cycles: the trigger and the wire items that started it. */
  wire_trigger_id?: string | null
  wire_item_ids?: string[]
  /** Why Grok research was skipped (research_mode auto), when it was. */
  research_skip_reason?: string | null
  /** Which Grok research the cycle ran (full, gap-fill or none) and why (absent on older cycles and on cycles that stopped before research). */
  research_plan?: { kind: "full" | "gap" | "none"; reason: string }
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

/** UTC calendar day, e.g. "2026-10-25". */
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10)
