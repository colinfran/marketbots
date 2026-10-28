import type { AiRunner } from "@mb/engine-kit/ai/runner"
import type { Logger } from "@mb/engine-kit/log"
import type { EngineStateDoc } from "@mb/stock-core/db"
import type { CycleState } from "@mb/stock-core/events"
import type { Alerts } from "../alerts"
import type { Alpaca } from "../alpaca/client"
import type { EventBus } from "../bus/event-bus"
import type { Collections } from "../db/mongo"
import type { LivePrices } from "../market/prices"
import type { SettingsView } from "../state/stores"
import type { Wire } from "../wire/wire"

/** Everything trading code needs, passed explicitly so it's plain, testable functions. */
export type EngineContext = {
  col: Collections
  log: Logger
  bus: EventBus
  alpaca: Alpaca
  settings: SettingsView
  /** Desired run state (running / paused / halted + kill switch). */
  state: { readonly state: EngineStateDoc }
  ai: AiRunner
  alerts: Pick<Alerts, "send" | "success">
  prices: LivePrices
  setCycleState: (state: CycleState, detail?: string) => void
  /** The news engine, when running (absent in tests and while it is off). */
  wire?: Wire | null
  signal: AbortSignal
}

/** The subset that order, maintenance and options code uses (no AI). */
export type TradingContext = Pick<EngineContext, "col" | "log" | "bus" | "alpaca" | "settings" | "alerts" | "prices">
