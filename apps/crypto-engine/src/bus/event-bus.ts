import { EventBus as EventBusOf } from "@mb/engine-kit/bus"
import type { Logger } from "@mb/engine-kit/log"
import { EPHEMERAL_EVENTS, type EventDataMap } from "@mb/crypto-core/events"
import type { Collections } from "../db/mongo"

/** The engine's event bus (@mb/engine-kit/bus) with crypto's events; tickers, heartbeats and AI progress (memo, reasoning, decision) are streamed but not stored. */
export class EventBus extends EventBusOf<EventDataMap> {
  constructor(col: Pick<Collections, "events">, log: Logger, retentionDays: number, clock?: () => number) {
    super(col, log, retentionDays, EPHEMERAL_EVENTS, clock)
  }
}
