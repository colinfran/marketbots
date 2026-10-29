import { z } from "zod"
import type { AgentActionOutcome, AgentStepKind, EpisodeStatus, ObservationKind, Priority, WatchKind } from "./agent"
import type { DossierRow, NotableReason, WireKind, WireSourceState, WireTier, WireTriggerAction, WireTriggerStatus } from "./wire"

/**
 * Versioned event schema for the live activity stream (engine → dashboard) and the persisted
 * `events` collection: the envelope, who may see an event, the stream protocol, and the events both
 * bots define the same way. Each bot's event map adds its own events to `BaseEventDataMap`.
 *
 * Every persisted event has a monotonically increasing `seq`, so a reconnecting client asks for
 * "everything after seq N" and gets an exact replay from memory or MongoDB.
 *
 * Event content is always a summary written by the engine, and anything that came from the web
 * (source titles, excerpts) is sanitized before it is emitted.
 */

export const EVENT_SCHEMA_VERSION = 1 as const

/**
 * The events whose name and payload are the same in both bots. The parameters are the bot's own
 * wire categories, engine run statuses and cycle states.
 */
export type BaseEventDataMap<Category extends string, RunStatus extends string, CycleState extends string> = {
  "engine.started": { version: string; instance: string }
  "engine.stopping": { reason: string }
  "engine.status": { status: RunStatus; kill_switch: boolean; reason?: string }
  "engine.heartbeat": {
    status: RunStatus
    cycle_state: CycleState
    ws_clients: number
    uptime_s: number
    ai_calls_today: number
  }
  "research.query": { research_id: string; query: string; tool: string }
  "research.source": { research_id: string; title: string; url: string; domain: string }
  "research.progress": { research_id: string; chars: number; excerpt: string }
  "research.completed": {
    research_id: string
    sources: number
    queries: number
    duration_ms: number
    cost_usd: number
    error: string | null
  }
  "ai.decision.completed": { cycle_id: string; decisions: number; attempts: number; repaired: boolean; cost_usd: number }
  "ai.decision.failed": { cycle_id: string; error: string }
  "command.received": { command_id: string; type: string }
  "command.completed": { command_id: string; type: string; result: string }
  "command.failed": { command_id: string; type: string; error: string }
  /** A stored wire item at or above the annotate threshold. */
  "wire.item": {
    id: string
    source: string
    tier: WireTier
    kind: WireKind
    category: Category
    title: string
    url: string | null
    symbols: string[]
    severity: number
    first_seen_at: string
    notable: boolean
    notable_reasons: NotableReason[]
  }
  /** An earlier item just became notable (it triggered something, or the AI cited it). */
  "wire.notable": { id: string; reason: NotableReason; notable_reasons: NotableReason[]; title: string; symbols: string[]; severity: number }
  /** The wire items a cycle's AI was given. */
  "wire.dossier": { cycle_id: string; rows: DossierRow<Category>[]; total: number }
  "wire.trigger": { trigger_id: string; rule: string; action: WireTriggerAction; status: WireTriggerStatus; reason: string; symbols: string[]; severity: number; item_ids: string[] }
  "wire.source": { id: string; state: WireSourceState; error: string | null }
  "seed.started": { seed_id: string; cycle_id: string; amount_usd: number }
  "seed.completed": {
    seed_id: string
    cycle_id: string | null
    status: "done" | "failed"
    allocations: { symbol: string; weight_pct: number; notional_usd: number }[]
    executed: number
    error: string | null
  }
  /** The agent woke on a subject (docs/plans/LOCAL-AI.md §8). */
  "agent.woke": { episode_id: string; priority: Priority; subject: string; kinds: ObservationKind[]; observations: number; reasons: string[] }
  /** One step of an episode: a tool call (its purpose and result, capped) or the answer. */
  "agent.step": { episode_id: string; step: number; kind: AgentStepKind; tool: string | null; purpose: string | null; result: string | null; ms: number; tokens_per_s: number | null }
  /** The latest ~240 characters of the model's thinking, at most every 1.5 s while it streams (owner-only unless agent.public_thinking). */
  "agent.thinking": { episode_id: string; step: number; chars: number; excerpt: string }
  "agent.answered": {
    episode_id: string
    status: EpisodeStatus
    subject: string
    priority: Priority
    reply: string | null
    actions: { symbol: string; action: string; outcome: AgentActionOutcome }[]
    watches: number
    notes: number
    steps: number
    duration_ms: number
  }
  "agent.watch": { watch_id: string; status: "set" | "fired" | "expired" | "canceled"; kind: WatchKind; symbol: string | null; note: string }
  /** A fill in the shadow book: what the agent would have traded. */
  "agent.shadow": { position_id: string; symbol: string; side: "buy" | "sell"; qty: number; price: number; reason: string; realized_pnl_usd: number | null }
  /** A circuit breaker tripped (recorded; at level shadow nothing is enforced). */
  "agent.breaker": { name: string; detail: string }
  error: { scope: string; message: string }
  alert: { level: "info" | "warning" | "error" | "critical"; title: string; message: string }
}

/** The agent's events: the same in both bots. */
export const AGENT_EVENT_TYPES = ["agent.woke", "agent.step", "agent.thinking", "agent.answered", "agent.watch", "agent.shadow", "agent.breaker"] as const
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]
export type AgentEventDataMap = Pick<BaseEventDataMap<string, string, string>, AgentEventType>

export type EventLevel = "debug" | "info" | "warn" | "error"
export type EventVisibility = "public" | "owner"

/** One event of a bot's event map `M`. */
export type EngineEvent<M, T extends keyof M = keyof M> = {
  v: typeof EVENT_SCHEMA_VERSION
  seq: number
  ts: string
  type: T
  level: EventLevel
  visibility: EventVisibility
  /** One-line, human-readable summary for the activity feed. */
  summary: string
  /** The symbol the event is about, for linking. */
  instrument?: string
  cycle_id?: string
  data: M[T]
}

/**
 * Whether a viewer may see an event. Everything is paper money, so public viewers see amounts;
 * only operational and control events (the bot's `ownerOnly` set, or any event emitted with owner
 * visibility) are owner-only.
 */
export const eventForViewer = <E extends { type: string; visibility: EventVisibility }>(event: E, scope: EventVisibility, ownerOnly: ReadonlySet<string>): E | null => {
  if (scope === "owner") return event
  if (event.visibility === "owner" || ownerOnly.has(event.type)) return null
  return event
}

/** Loose envelope check for clients: tolerate unknown event types from a newer engine. */
export const eventEnvelopeSchema = z.object({
  v: z.number(),
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  level: z.enum(["debug", "info", "warn", "error"]),
  visibility: z.enum(["public", "owner"]),
  summary: z.string(),
  instrument: z.string().optional(),
  cycle_id: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
})

// ─────────────────────────────────────────────────────────────────────────────
// Stream protocol (WebSocket frames)
// ─────────────────────────────────────────────────────────────────────────────

export const STREAM_PROTOCOL_VERSION = 1 as const

/** Client → server. The token goes in the first frame (not the URL) so it never lands in proxy logs. */
export const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(10).max(2_000), since: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("pong"), t: z.number().optional() }),
])
export type ClientFrame = z.infer<typeof clientFrameSchema>

/** Server → client, for a bot whose events are `E`. */
export type ServerFrame<E> =
  | { type: "hello"; protocol: typeof STREAM_PROTOCOL_VERSION; scope: EventVisibility; server_time: string; last_seq: number }
  | { type: "event"; event: E }
  | { type: "replay_done"; last_seq: number; truncated: boolean }
  | { type: "ping"; t: number }
  | { type: "error"; code: string; message: string }
