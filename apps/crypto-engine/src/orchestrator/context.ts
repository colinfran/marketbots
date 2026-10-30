import type { CycleState } from "@mb/crypto-core/events"
import type { Logger } from "@mb/engine-kit/log"
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

/** Everything the agent's execution path needs, passed explicitly so it is plain, testable functions. */
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
  alerts: Alerts
  /** Current risk gate (run state, kill switch, connectivity, reconciliation). */
  gate: () => Gate
  /** The paper wallet's fee rate in bps (fixed per workspace), used for every edge calculation. */
  feeBps: () => number
  /** What the execution path is doing (the engine's state on the dashboard). */
  setCycleState: (state: CycleState, detail?: string) => void
  /** The news engine, when running (null in tests and while it is off). */
  wire?: Wire | null
  signal: AbortSignal
}

