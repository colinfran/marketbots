import type { CycleDoc } from "@mb/crypto-core/db"
import type { CycleState } from "@mb/crypto-core/events"
import type { AiBudget } from "../ai/budget"
import type { AiRunner } from "../ai/runner"
import type { Alerts } from "../alerts"
import type { EventBus } from "../bus/event-bus"
import type { Collections } from "../db/mongo"
import type { Executor } from "../execution/executor"
import type { Logger } from "../log"
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
