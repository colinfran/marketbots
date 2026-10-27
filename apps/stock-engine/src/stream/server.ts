import type { Logger } from "@mb/engine-kit/log"
import { StreamServer as StreamServerOf, type StreamServerOptions } from "@mb/engine-kit/stream"
import { OWNER_ONLY_EVENTS, type EventDataMap } from "@mb/stock-core/events"
import { verifyStreamToken } from "@mb/stock-core/stream-token"
import type { EventBus } from "../bus/event-bus"

/**
 * The engine's stream server (@mb/engine-kit/stream) for stock: it accepts only stock's stream
 * tokens (`smb-stream.` HMAC prefix) and hides stock's owner-only events from public viewers.
 */
export class StreamServer extends StreamServerOf<EventDataMap> {
  constructor(bus: EventBus, log: Logger, opts: StreamServerOptions) {
    super(bus, log, opts, { verifyToken: verifyStreamToken, ownerOnly: OWNER_ONLY_EVENTS })
  }
}
