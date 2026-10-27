import type { CycleDoc } from "@mb/crypto-core/db"
import type { CycleState } from "@mb/crypto-core/events"
import type { Logger } from "@mb/engine-kit/log"
import { cleanLine } from "@mb/engine-kit/util/text"
import type { AiBudget } from "../ai/budget"
import type { AiRunner } from "../ai/runner"
import type { Alerts } from "../alerts"
import type { EventBus } from "../bus/event-bus"
import type { Collections } from "../db/mongo"
import type { Executor } from "../execution/executor"
import type { CandleCache } from "../market/candles"
import type { MarketHub } from "../market/hub"
import type { Ledger } from "../portfolio/ledger"
import type { Gate } from "../risk/engine"
import type { EngineStateStore, SettingsStore } from "../state/stores"
import type { Wire } from "../wire/wire"

/** Everything a cycle needs, passed explicitly so cycles are plain, testable functions. */
export type EngineContext = {
  col: Collections
  log: Logger
  bus: EventBus
  settings: SettingsStore
  state: EngineStateStore
  hub: MarketHub
  candles: CandleCache
  ledger: Ledger
  executor: Executor
  ai: AiRunner
  budget: AiBudget
  alerts: Alerts
  /** Current risk gate (run state, kill switch, connectivity, reconciliation). */
  gate: () => Gate
  /** The paper wallet's fee rate in bps (fixed per workspace), used for every edge calculation. */
  feeBps: () => number
  setCycleState: (state: CycleState, detail?: string) => void
  /** The news engine, when running (null in tests and while it is off). */
  wire?: Wire | null
  signal: AbortSignal
}

/** Appends a step to a cycle document (the cycle's audit trail). */
export const cycleStep = (col: Pick<Collections, "cycles">, cycleId: string, name: string, ok: boolean, detail: string | null = null) =>
  col.cycles.updateOne({ _id: cycleId }, { $push: { steps: { at: new Date(), name, ok, detail: detail?.slice(0, 500) ?? null } } })

export const finishCycle = (
  col: Pick<Collections, "cycles">,
  cycleId: string,
  started: number,
  fields: Partial<Pick<CycleDoc, "status" | "summary" | "error" | "decision_ids" | "research_id" | "ai_cost_usd" | "regime" | "candidates" | "reviews">>,
) => col.cycles.updateOne({ _id: cycleId }, { $set: { ...fields, finished_at: new Date(), duration_ms: Date.now() - started, state: "idle" } })

/** The model's reasoning while research or the decision streams (live views only; never stored). */
export const reasoningEvent = (ctx: Pick<EngineContext, "bus">, cycleId: string, task: "research" | "decision") => (chars: number, excerpt: string) =>
  ctx.bus.emit("ai.reasoning", { cycle_id: cycleId, task, chars, excerpt }, { summary: `Reasoning (${task})`, cycle_id: cycleId, level: "debug" })

/** The decision as it's written: the market read so far and how many decisions it holds (live views only). */
export const decisionProgressEvent = (ctx: Pick<EngineContext, "bus">, cycleId: string) => (chars: number, partial: unknown) => {
  const p = partial as { market_read?: { summary?: unknown }; decisions?: unknown } | undefined
  const headline = typeof p?.market_read?.summary === "string" && p.market_read.summary.trim() ? cleanLine(p.market_read.summary, 160) : null
  const n = Array.isArray(p?.decisions) ? p.decisions.length : 0
  const so = n ? ` · ${n} decision${n === 1 ? "" : "s"} so far` : ""
  ctx.bus.emit("ai.decision.progress", { cycle_id: cycleId, chars, headline, decisions: n }, { summary: headline ? `Writing: “${headline}”${so}` : `Writing decisions (${chars} chars)${so}`, cycle_id: cycleId, level: "debug" })
}

/** The seed allocation as it's written: how many pairs it holds so far (live views only). */
export const seedProgressEvent = (ctx: Pick<EngineContext, "bus">, cycleId: string) => (chars: number, partial: unknown) => {
  const p = partial as { allocations?: unknown } | undefined
  const n = Array.isArray(p?.allocations) ? p.allocations.length : 0
  ctx.bus.emit("ai.decision.progress", { cycle_id: cycleId, chars, headline: null, decisions: n }, { summary: `Writing the seed allocation (${chars} chars)${n ? ` · ${n} pair${n === 1 ? "" : "s"} so far` : ""}`, cycle_id: cycleId, level: "debug" })
}
