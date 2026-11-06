import type { AgentStatus } from "./agent"
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
  lease: "engine_lease",
  events: "events",
  commands: "commands",
  audit: "audit_log",
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
  // `level` + `ts`: the heartbeat's count of the last hour's errors, once a minute.
  events: [{ key: { expires_at: 1 }, expireAfterSeconds: 0 }, { key: { type: 1, _id: -1 } }, { key: { cycle_id: 1 }, sparse: true }, { key: { level: 1, ts: -1 } }],
  commands: [{ key: { status: 1, created_at: 1 } }, { key: { created_at: -1 } }],
  audit_log: [{ key: { at: -1 } }],
  ai_calls: [{ key: { day: 1 } }, { key: { at: -1 } }],
  notifications: [{ key: { at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
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
  agent_episodes: [{ key: { started_at: -1 } }, { key: { subject: 1, started_at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  agent_watches: [{ key: { status: 1 } }, { key: { purge_at: 1 }, expireAfterSeconds: 0 }],
  agent_notes: [{ key: { subject: 1, created_at: -1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }],
  // Better Auth's own field names (camelCase).
  auth_sessions: [{ key: { token: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  auth_verifications: [{ key: { identifier: 1 } }, { key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
})

export type TokenUsage = { input: number; output: number; total: number }

export type SettingsDoc<S> = { _id: "current"; settings: S; version: number; updated_at: Date; updated_by: string }

/**
 * What research's metered search providers cost this bot in a UTC month (docs/SERVER.md §9): one
 * document a month, `_id` "YYYY-MM", each provider's spend in its own unit (searches; dollars for
 * Exa). Research paces each provider against it, so the counts survive restarts.
 */
export type SearchUsageDoc = { _id: string; spent: Record<string, number>; updated_at: Date }

/** Desired state, changed only by commands (or the engine's own risk halt). Survives restarts. */
export type EngineStateDoc = {
  _id: "engine"
  status: "running" | "paused" | "halted"
  pause_reason: string | null
  kill_switch: { engaged: boolean; reason: string | null; at: Date | null; by: string | null; liquidate: boolean }
  /** When the agent was last turned on or its entries resumed, the account's equity then, and its highest equity since: the drawdown breaker counts from that peak. */
  agent_promotion?: { at: Date; equity_usd: number; peak_usd?: number } | null
  /** A circuit breaker's pause on the agent's new entries, until the owner resumes them (Admin). */
  agent_pause?: { at: Date; reason: string } | null
  /** Legacy: a breaker's drop to the old shadow level. Read once at startup and turned into `agent_pause`. */
  agent_demotion?: { at: Date; reason: string } | null
  updated_at: Date
}

/**
 * Observed state: the fields both bots report in their heartbeat every 10 seconds, kept in the
 * engine's memory and read by the dashboards from its GET /v1/status (never stored). Each bot adds
 * its own section (venue or broker health, market, last cycle…).
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
  /** The agent (absent before it shipped). */
  agent?: AgentStatus
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
  /** The backfills and other long-running jobs (absent on engines without any). */
  jobs?: HistoryJobStatus[]
}

export type HistoryJobStatus = {
  name: string
  state: "waiting" | "running" | "done" | "failed"
  /** The job's own words, e.g. "BTC/USD 1-minute: 2019-03-04 (4.1M rows)". */
  progress: string
  updated_at: Date | null
  error: string | null
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

/** research_gap = the short web research that only fills gaps the wire dossier leaves; agent = one agent episode, every step. */
export type AiTask = "research" | "decision" | "research_gap" | "agent"

export type AiCallDoc = {
  _id: string
  at: Date
  /** The day the call counts toward (each bot's own day: crypto UTC, stock the New York trading day). */
  day: string
  task: AiTask
  model: string
  cycle_id: string | null
  input_tokens: number
  output_tokens: number
  /** Research calls: the web searches made (before 2026-10-28, Grok's billed web and X tool calls; absent on decisions and older docs). */
  searches?: number
  cost_usd: number
  cost_source: "gateway" | "estimate" | "local"
  duration_ms: number
  ok: boolean
  error: string | null
}

/** What started a cycle (absent on cycles from before it was recorded). core = a review of the long-term core book; agent = an agent episode (its decisions' cycle_id is the episode's id). */
export type CycleKind = "scheduled" | "price_move" | "manual" | "event" | "seed" | "core" | "agent"

/** Rate-limit counter for the dashboard's sign-in endpoints, keyed by a hash of client IP + path. */
export type LoginAttemptDoc = { _id: string; count: number; first_at: Date; expires_at: Date }

/**
 * The cluster's storage cap: the Azure DocumentDB free tier (docs/SERVER.md §1). MongoDB can't report
 * it; Azure Monitor can, so this is only used without the AZURE_* variables.
 */
export const DB_STORAGE_LIMIT_BYTES = 32 * 1024 ** 3

/**
 * Admin → System's database card: what the cluster's databases take on disk, as MongoDB reports it
 * (`used_bytes` null and `error` set when it couldn't be read), and the disk as Azure counts it.
 */
export type DatabaseStorageView = {
  used_bytes: number | null
  limit_bytes: number
  /** Each database's data and indexes on disk, largest first. */
  databases: { name: string; bytes: number }[]
  error: string | null
  /**
   * Azure Monitor's storage metrics (StorageUsed, StoragePercent): data, indexes, logs and system
   * files, against the disk they fill. Null without the AZURE_* variables or when they failed.
   */
  azure: { used_bytes: number; limit_bytes: number; percent: number; at: Date } | null
  azure_error: string | null
}

/** UTC calendar day, e.g. "2026-10-25". */
export const utcDay = (date = new Date()) => date.toISOString().slice(0, 10)
