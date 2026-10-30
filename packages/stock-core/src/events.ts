import {
  type BaseEventDataMap,
  type EngineEvent as EngineEventOf,
  eventForViewer as sharedEventForViewer,
  MODEL_EVENT_TYPES,
  type EventVisibility,
  type ServerFrame as ServerFrameOf,
} from "@mb/core/events"
import type { AssetClass } from "./alpaca"
import type { Phase } from "./settings"
import type { WireCategory } from "./wire"

export { clientFrameSchema, EVENT_SCHEMA_VERSION, eventEnvelopeSchema, STREAM_PROTOCOL_VERSION } from "@mb/core/events"
export type { ClientFrame, EventLevel, EventVisibility } from "@mb/core/events"

/**
 * Stock's events for the live activity stream (engine → dashboard) and the persisted `events`
 * collection: the envelope, the stream protocol and the events both bots share come from
 * @mb/core/events; the rest are stock's own. The engine is the source of truth; the dashboard
 * only renders. An event's `instrument` is a stock ticker (or an option's underlying).
 */

export type EngineRunStatus = "starting" | "running" | "paused" | "halted" | "stopping"

export type CycleState = "idle" | "gathering_data" | "loading_options" | "researching" | "deciding" | "executing" | "protecting" | "reviewing"

export type RiskCheck = { name: string; ok: boolean; detail: string }

export type ProtectionKind = "stop" | "target" | "underlying_stop" | "underlying_target" | "time" | "kill_switch" | "unprotected_stop" | "manual" | "ai"

/** The events both bots define the same way, with stock's categories, run statuses and cycle states. */
type Shared = BaseEventDataMap<WireCategory, EngineRunStatus, CycleState>

export type EventDataMap = {
  "engine.started": Shared["engine.started"]
  "engine.stopping": Shared["engine.stopping"]
  "engine.status": Shared["engine.status"]
  "engine.heartbeat": Shared["engine.heartbeat"]
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
  "research.query": Shared["research.query"]
  "research.source": Shared["research.source"]
  "research.progress": Shared["research.progress"]
  "research.completed": Shared["research.completed"]
  "ai.reasoning": { cycle_id: string; task: "research" | "decision"; chars: number; excerpt: string }
  "ai.decision.started": { cycle_id: string; model: string }
  "ai.decision.progress": { cycle_id: string; chars: number; headline: string | null; decisions: number }
  "ai.decision.completed": Shared["ai.decision.completed"]
  "ai.decision.failed": Shared["ai.decision.failed"]
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
  "command.received": Shared["command.received"]
  "command.completed": Shared["command.completed"]
  "command.failed": Shared["command.failed"]
  "summary.periodic": {
    equity_usd: number
    day_pnl_usd: number
    day_pnl_pct: number | null
    total_return_pct: number | null
    positions: number
    option_positions: number
  }
  "daily.stats": { day: string; pnl: number; pnl_pct: number; spy_pct: number | null }
  "wire.item": Shared["wire.item"]
  "wire.notable": Shared["wire.notable"]
  "wire.dossier": Shared["wire.dossier"]
  "wire.trigger": Shared["wire.trigger"]
  "wire.source": Shared["wire.source"]
  "seed.started": Shared["seed.started"]
  "seed.completed": Shared["seed.completed"]
  "agent.woke": Shared["agent.woke"]
  "agent.step": Shared["agent.step"]
  "agent.answered": Shared["agent.answered"]
  "agent.watch": Shared["agent.watch"]
  "agent.breaker": Shared["agent.breaker"]
  "llm.call": Shared["llm.call"]
  "llm.delta": Shared["llm.delta"]
  "llm.done": Shared["llm.done"]
  "llm.status": Shared["llm.status"]
  "core.review.started": { review_id: string; cycle_id: string; kind: "weekly" | "holding"; trigger: string; symbol: string | null; dry_run: boolean }
  "core.review.completed": {
    review_id: string
    cycle_id: string
    status: "done" | "failed" | "skipped"
    dry_run: boolean
    summary: string | null
    decisions: { symbol: string; action: string; status: string; reason: string | null }[]
    executed: number
    rejected: number
    cost_usd: number
    error: string | null
  }
  error: Shared["error"]
  alert: Shared["alert"]
}

export type EventType = keyof EventDataMap

export type EngineEvent<T extends EventType = EventType> = EngineEventOf<EventDataMap, T>

/** Events that never reach a public (logged-out) viewer. */
export const OWNER_ONLY_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["command.received", "command.completed", "command.failed", "error", "broker.error"])

/** High-frequency events that are streamed but not stored. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>(["market.ticker", "engine.heartbeat", "research.progress", "ai.decision.progress", "ai.reasoning", ...MODEL_EVENT_TYPES])

/**
 * Whether a viewer may see an event. Everything is paper money, so public viewers see amounts;
 * only operational and control events are owner-only.
 */
export const eventForViewer = (event: EngineEvent, scope: EventVisibility): EngineEvent | null => sharedEventForViewer(event, scope, OWNER_ONLY_EVENTS)

export type ServerFrame = ServerFrameOf<EngineEvent>
