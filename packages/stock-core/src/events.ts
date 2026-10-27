import { z } from "zod"
import type { AssetClass } from "./alpaca"
import type { Phase } from "./settings"
import type { DossierRow, NotableReason, WireCategory, WireKind, WireSourceState, WireTier, WireTriggerAction, WireTriggerStatus } from "./wire"

/**
 * Versioned event schema for the live activity stream (engine → dashboard) and the persisted
 * `events` collection. The engine is the source of truth; the dashboard only renders.
 *
 * Every persisted event has a monotonically increasing `seq`, so a reconnecting client asks for
 * "everything after seq N" and gets an exact replay from memory or MongoDB.
 *
 * Event content is always a summary written by the engine, and anything that came from the web
 * (source titles, excerpts) is sanitized before it is emitted.
 */

export const EVENT_SCHEMA_VERSION = 1 as const

export type EngineRunStatus = "starting" | "running" | "paused" | "halted" | "stopping"

export type CycleState = "idle" | "gathering_data" | "loading_options" | "researching" | "deciding" | "executing" | "protecting" | "reviewing"

export type RiskCheck = { name: string; ok: boolean; detail: string }

export type ProtectionKind = "stop" | "target" | "underlying_stop" | "underlying_target" | "time" | "kill_switch" | "unprotected_stop" | "manual" | "ai"

export type EventDataMap = {
  "engine.started": { version: string; instance: string }
  "engine.stopping": { reason: string }
  "engine.status": { status: EngineRunStatus; kill_switch: boolean; reason?: string }
  "engine.heartbeat": {
    status: EngineRunStatus
    cycle_state: CycleState
    ws_clients: number
    uptime_s: number
    ai_spend_today_usd: number
    ai_budget_usd: number
  }
  "market.ticker": { symbol: string; price: number; bid: number | null; ask: number | null; change_pct: number | null }
  "market.session": { state: "open" | "closed"; day: string }
  "broker.connected": { channel: "trade_updates" | "market_data" }
  "broker.disconnected": { channel: "trade_updates" | "market_data"; reason: string }
  "broker.error": { scope: string; message: string }
  "cycle.started": { cycle_id: string; phase: Phase; trigger: string }
  "cycle.state": { cycle_id: string; state: CycleState; detail?: string }
  "cycle.step": { cycle_id: string; name: string; ok: boolean; detail: string | null }
  "cycle.completed": {
    cycle_id: string
    phase: Phase
    report_id: string
    duration_ms: number
    decisions: number
    executed: number
    rejected: number
    failed: number
    ai_cost_usd: number
    headline: string
  }
  "cycle.failed": { cycle_id: string; phase: Phase; error: string }
  "cycle.skipped": { phase: Phase | null; reason: string }
  "context.built": {
    cycle_id: string
    positions: number
    option_positions: number
    instruments: number
    headlines: number
    equity: number
    day_pnl_pct: number
    new_buys_allowed: boolean
    flags: string[]
  }
  "options.chains": { cycle_id: string; underlyings: { symbol: string; contracts: number }[] }
  "research.started": { cycle_id: string; research_id: string; phase: Phase; model: string; focus: string[] }
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
  "ai.reasoning": { cycle_id: string; task: "research" | "decision"; chars: number; excerpt: string }
  "ai.decision.started": { cycle_id: string; model: string }
  "ai.decision.progress": { cycle_id: string; chars: number; headline: string | null; decisions: number }
  "ai.decision.completed": { cycle_id: string; decisions: number; attempts: number; repaired: boolean; cost_usd: number }
  "ai.decision.failed": { cycle_id: string; error: string }
  "ai.report": {
    cycle_id: string
    phase: Phase
    headline: string
    summary: string
    sentiment: string
    regime: string
    stance: string
    confidence: number
    key_drivers: string[]
    watchlist: string[]
  }
  "ai.decision.proposed": {
    cycle_id: string
    symbol: string
    instrument: "stock" | "option"
    action: string
    conviction: number
    rationale: string
    detail: string | null
  }
  "risk.checked": {
    decision_id: string
    symbol: string
    action: string
    approved: boolean
    reasons: string[]
    checks: RiskCheck[]
    qty: number | null
    notional_usd: number | null
  }
  "decision.result": { decision_id: string; symbol: string; action: string; status: "executed" | "rejected" | "failed" | "noop"; reason: string | null }
  "order.submitted": {
    order_id: string
    symbol: string
    side: string
    type: string
    qty: number
    limit_price: number | null
    purpose: string
    asset_class: AssetClass
  }
  "order.updated": { order_id: string; symbol: string; status: string; filled_qty: number }
  "order.filled": { order_id: string; symbol: string; side: string; qty: number; price: number; partial: boolean; asset_class: AssetClass }
  "order.canceled": { order_id: string; symbol: string; reason: string }
  "order.rejected": { order_id: string; symbol: string; reason: string }
  "position.opened": { symbol: string; asset_class: AssetClass; qty: number; price: number | null; structure_id: string | null }
  "position.closed": { symbol: string; asset_class: AssetClass; realized_pnl_usd: number | null; return_pct: number | null; reason: string; structure_id: string | null }
  "protection.placed": { symbol: string; stop: number; target: number }
  "protection.triggered": { symbol: string; kind: ProtectionKind; price: number | null; structure_id: string | null }
  "budget.exhausted": { spent_usd: number; budget_usd: number }
  "command.received": { command_id: string; type: string }
  "command.completed": { command_id: string; type: string; result: string }
  "command.failed": { command_id: string; type: string; error: string }
  "summary.periodic": {
    equity_usd: number
    day_pnl_usd: number
    day_pnl_pct: number | null
    total_return_pct: number | null
    positions: number
    option_positions: number
  }
  "daily.stats": { day: string; pnl: number; pnl_pct: number; spy_pct: number | null }
  /** A stored wire item at or above the annotate threshold. */
  "wire.item": {
    id: string
    source: string
    tier: WireTier
    kind: WireKind
    category: WireCategory
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
  "wire.dossier": { cycle_id: string; rows: DossierRow[]; total: number }
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
  error: { scope: string; message: string }
  alert: { level: "info" | "warning" | "error" | "critical"; title: string; message: string }
}

export type EventType = keyof EventDataMap
export type EventLevel = "debug" | "info" | "warn" | "error"
export type EventVisibility = "public" | "owner"

export type EngineEvent<T extends EventType = EventType> = {
  v: typeof EVENT_SCHEMA_VERSION
  seq: number
  ts: string
  type: T
  level: EventLevel
  visibility: EventVisibility
  /** One-line, human-readable summary for the activity feed. */
  summary: string
  /** A stock ticker (or an option's underlying), for linking. */
  instrument?: string
  cycle_id?: string
  data: EventDataMap[T]
}

/** Events that never reach a public (logged-out) viewer. */
export const OWNER_ONLY_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["command.received", "command.completed", "command.failed", "error", "broker.error"])

/** High-frequency events that are streamed but not stored. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["market.ticker", "engine.heartbeat", "research.progress", "ai.decision.progress", "ai.reasoning"])

/**
 * Whether a viewer may see an event. Everything is paper money, so public viewers see amounts;
 * only operational and control events are owner-only.
 */
export const eventForViewer = (event: EngineEvent, scope: EventVisibility): EngineEvent | null => {
  if (scope === "owner") return event
  if (event.visibility === "owner" || OWNER_ONLY_EVENTS.has(event.type)) return null
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

export type ServerFrame =
  | { type: "hello"; protocol: typeof STREAM_PROTOCOL_VERSION; scope: EventVisibility; server_time: string; last_seq: number }
  | { type: "event"; event: EngineEvent }
  | { type: "replay_done"; last_seq: number; truncated: boolean }
  | { type: "ping"; t: number }
  | { type: "error"; code: string; message: string }
