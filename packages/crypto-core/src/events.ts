import { z } from "zod"
import type { StrategyId } from "./strategies"
import type { DossierRow, NotableReason, WireCategory, WireKind, WireSourceState, WireTier, WireTriggerAction, WireTriggerStatus } from "./wire"

/**
 * Versioned event schema for the live activity stream (engine → dashboard) and the persisted
 * `events` collection. The engine is the source of truth; the dashboard only renders.
 *
 * Every persisted event has a monotonically increasing `seq`, so a reconnecting client asks for
 * "everything after seq N" and gets an exact replay from memory or MongoDB.
 *
 * Event content is always a summary written by the engine. Raw model reasoning is never streamed,
 * and anything that came from the web (source titles, excerpts) is sanitized before it is emitted.
 */

export const EVENT_SCHEMA_VERSION = 1 as const

export type EngineRunStatus = "starting" | "reconciling" | "running" | "paused" | "halted" | "stopping"

export type CycleState =
  | "idle"
  | "waiting_for_data"
  | "screening"
  | "researching"
  | "evaluating"
  | "risk_check"
  | "placing_order"
  | "position_monitoring"

export type EvidenceKind = "fact" | "sourced_claim" | "estimate" | "speculation"

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
  "engine.reconciled": { ok: boolean; issues: string[]; imported: number }
  "market.ticker": { symbol: string; bid: number; ask: number; last: number; change_pct: number | null }
  "market.stale": { symbol: string; age_s: number }
  "market.restored": { symbol: string }
  "venue.connected": { channel: string }
  "venue.disconnected": { channel: string; reason: string }
  "venue.error": { message: string }
  "cycle.started": { cycle_id: string; trigger: string }
  "cycle.state": { cycle_id: string; state: CycleState; detail?: string }
  "cycle.completed": {
    cycle_id: string
    duration_ms: number
    decisions: number
    approved: number
    executed: number
    ai_cost_usd: number
    summary: string
  }
  "cycle.skipped": { reason: string }
  "cycle.failed": { cycle_id: string; error: string }
  "screen.candidates": {
    cycle_id: string
    candidates: { instrument: string; strategy: StrategyId; score: number; signal: string }[]
    reviews: string[]
    /** Market regime label and how many symbols had usable data (absent on older events). */
    regime?: string
    symbols?: number
  }
  "research.started": { cycle_id: string; research_id: string; subjects: string[]; model: string }
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
  "ai.decision.started": { cycle_id: string; model: string; items: string[] }
  "ai.decision.proposed": {
    decision_id: string
    instrument: string
    action: string
    conviction: number
    thesis: string
    edge_bps: number | null
    /** What happened to it: filled, rejected, not_applicable… (absent on older events). */
    execution?: string
  }
  "ai.decision.completed": { cycle_id: string; decisions: number; attempts: number; repaired: boolean; cost_usd: number }
  "ai.decision.failed": { cycle_id: string; error: string }
  "risk.checked": {
    decision_id: string
    instrument: string
    approved: boolean
    resized: boolean
    reasons: string[]
    qty: number | null
    notional_usd: number | null
  }
  "order.submitted": {
    order_id: string
    instrument: string
    side: "buy" | "sell"
    type: string
    qty: number
    limit_price: number | null
    purpose: string
  }
  "order.updated": { order_id: string; status: string; filled_qty: number }
  "order.filled": {
    order_id: string
    fill_id: string
    instrument: string
    side: "buy" | "sell"
    qty: number
    price: number
    fee_usd: number
    partial: boolean
    slippage_bps: number | null
  }
  "order.canceled": { order_id: string; reason: string }
  "order.rejected": { order_id: string; reason: string }
  "position.opened": {
    position_id: string
    instrument: string
    qty: number
    avg_price: number
    stop_price: number | null
    take_profit_price: number | null
    strategy: StrategyId | null
  }
  "position.updated": { position_id: string; instrument: string; qty: number; avg_price: number }
  "position.closed": {
    position_id: string
    instrument: string
    realized_pnl_usd: number
    return_pct: number | null
    exit_reason: string
  }
  "protection.triggered": { position_id: string; instrument: string; kind: string; price: number }
  "budget.exhausted": { spent_usd: number; budget_usd: number }
  "command.received": { command_id: string; type: string }
  "command.completed": { command_id: string; type: string; result: string }
  "command.failed": { command_id: string; type: string; error: string }
  "summary.periodic": { equity_usd: number; day_pnl_pct: number | null; total_return_pct: number | null; positions: number }
  "backtest.completed": { backtest_id: string; total_return_pct: number | null; sharpe: number | null; max_drawdown_pct: number | null }
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
  instrument?: string
  cycle_id?: string
  data: EventDataMap[T]
}

/** Events that never reach a public (logged-out) viewer. */
export const OWNER_ONLY_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "command.received",
  "command.completed",
  "command.failed",
  "error",
  "engine.reconciled",
])

/** High-frequency events that are streamed but not stored. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["market.ticker", "engine.heartbeat", "research.progress"])

/**
 * Whether a viewer may see an event. Everything is paper money, so public viewers see amounts
 * (like stockmarketbot); only operational and control events are owner-only.
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
