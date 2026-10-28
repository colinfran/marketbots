import {
  type BaseEventDataMap,
  type EngineEvent as EngineEventOf,
  eventForViewer as sharedEventForViewer,
  type EventVisibility,
  type ServerFrame as ServerFrameOf,
} from "@mb/core/events"
import type { StrategyId } from "./strategies"
import type { WireCategory } from "./wire"

export { clientFrameSchema, EVENT_SCHEMA_VERSION, eventEnvelopeSchema, STREAM_PROTOCOL_VERSION } from "@mb/core/events"
export type { ClientFrame, EventLevel, EventVisibility } from "@mb/core/events"

/**
 * Crypto's events for the live activity stream (engine → dashboard) and the persisted `events`
 * collection: the envelope, the stream protocol and the events both bots share come from
 * @mb/core/events; the rest are crypto's own. The engine is the source of truth; the dashboard
 * only renders. Model reasoning reaches the stream only as the provider sends it (its reasoning
 * summaries, when it returns any), as short excerpts that are never stored.
 */

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

/** The events both bots define the same way, with crypto's categories, run statuses and cycle states. */
type Shared = BaseEventDataMap<WireCategory, EngineRunStatus, CycleState>

export type EventDataMap = {
  "engine.started": Shared["engine.started"]
  "engine.stopping": Shared["engine.stopping"]
  "engine.status": Shared["engine.status"]
  "engine.heartbeat": Shared["engine.heartbeat"]
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
  "research.query": Shared["research.query"]
  "research.source": Shared["research.source"]
  "research.progress": Shared["research.progress"]
  "research.completed": Shared["research.completed"]
  /** The latest ~240 characters of the model's reasoning, at most every 1.5 s while it streams. */
  "ai.reasoning": { cycle_id: string; task: "research" | "decision"; chars: number; excerpt: string }
  "ai.decision.started": { cycle_id: string; model: string; items: string[] }
  /** The decision as it's written: the market read so far (the seed: null) and how many decisions it holds. */
  "ai.decision.progress": { cycle_id: string; chars: number; headline: string | null; decisions: number }
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
  "ai.decision.completed": Shared["ai.decision.completed"]
  "ai.decision.failed": Shared["ai.decision.failed"]
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
  "command.received": Shared["command.received"]
  "command.completed": Shared["command.completed"]
  "command.failed": Shared["command.failed"]
  "summary.periodic": { equity_usd: number; day_pnl_pct: number | null; total_return_pct: number | null; positions: number }
  "backtest.completed": { backtest_id: string; total_return_pct: number | null; sharpe: number | null; max_drawdown_pct: number | null }
  "wire.item": Shared["wire.item"]
  "wire.notable": Shared["wire.notable"]
  "wire.dossier": Shared["wire.dossier"]
  "wire.trigger": Shared["wire.trigger"]
  "wire.source": Shared["wire.source"]
  "seed.started": Shared["seed.started"]
  "seed.completed": Shared["seed.completed"]
  error: Shared["error"]
  alert: Shared["alert"]
}

export type EventType = keyof EventDataMap

export type EngineEvent<T extends EventType = EventType> = EngineEventOf<EventDataMap, T>

/** Events that never reach a public (logged-out) viewer. */
export const OWNER_ONLY_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "command.received",
  "command.completed",
  "command.failed",
  "error",
  "engine.reconciled",
])

/** High-frequency events that are streamed but not stored. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["market.ticker", "engine.heartbeat", "research.progress", "ai.decision.progress", "ai.reasoning"])

/**
 * Whether a viewer may see an event. Everything is paper money, so public viewers see amounts
 * (like stockmarketbot); only operational and control events are owner-only.
 */
export const eventForViewer = (event: EngineEvent, scope: EventVisibility): EngineEvent | null => sharedEventForViewer(event, scope, OWNER_ONLY_EVENTS)

export type ServerFrame = ServerFrameOf<EngineEvent>
