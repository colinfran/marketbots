import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { AiRunner } from "@mb/engine-kit/ai/runner"
import { silentLogger } from "@mb/engine-kit/log"
import { makeTestBus } from "@mb/engine-kit/testing/bus"
import type { EngineStateDoc } from "@mb/stock-core/db"
import { EPHEMERAL_EVENTS, type EngineEvent, type EventDataMap } from "@mb/stock-core/events"
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch, mergeSettings } from "@mb/stock-core/settings"
import { marketDay } from "@mb/stock-core/time"
import type { EngineContext } from "../../src/bot/context"
import type { EventBus } from "../../src/bus/event-bus"
import type { Collections } from "../../src/db/mongo"
import { LivePrices } from "../../src/market/prices"
import type { FakeBroker } from "./broker"

export type SentAlert = { level: string; title: string; message: string; path?: string; fields?: Record<string, unknown> }

/** A real event bus with stock's events on the test database (@mb/engine-kit/testing/bus). */
export const makeBus = (col: Collections): Promise<EventBus> => makeTestBus<EventDataMap>(col, EPHEMERAL_EVENTS)

/**
 * An engine context for tests: the test database, the fake broker, real settings (optionally
 * patched), a real event bus that records every event, alerts captured instead of sent.
 */
export const makeCtx = async (col: Collections, broker: FakeBroker, patch: SettingsPatch = {}) => {
  const bus = await makeBus(col)
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))
  const alerts: SentAlert[] = []
  // A deep copy, so a test can change settings without touching the shared defaults.
  const settings = { current: structuredClone(mergeSettings(DEFAULT_SETTINGS, patch)) as Settings, version: 1 }
  const state: { state: EngineStateDoc } = {
    state: { _id: "engine", status: "running", pause_reason: null, kill_switch: { engaged: false, reason: null, at: null, by: null, liquidate: false }, updated_at: new Date() },
  }
  const cycleStates: string[] = []
  const ctx: EngineContext = {
    col,
    log: silentLogger,
    bus,
    alpaca: broker.client,
    settings,
    state,
    ai: new AiRunner(new AiCallLog(col, marketDay), silentLogger),
    alerts: {
      send: async (level, title, message, opts) => {
        alerts.push({ level, title, message, path: opts?.path, ...(opts?.fields ? { fields: opts.fields } : {}) })
      },
      success: async (title, message, opts) => {
        alerts.push({ level: "success", title, message, path: opts?.path, ...(opts?.fields ? { fields: opts.fields } : {}) })
      },
    },
    prices: new LivePrices(null),
    setCycleState: (s) => cycleStates.push(s),
    signal: new AbortController().signal,
  }
  return { ctx, bus, events, alerts, settings, state, cycleStates }
}
