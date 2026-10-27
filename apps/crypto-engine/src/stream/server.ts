import { OWNER_ONLY_EVENTS, type EventDataMap } from "@mb/crypto-core/events"
import { verifyStreamToken } from "@mb/crypto-core/stream-token"
import type { Logger } from "@mb/engine-kit/log"
import { StreamServer as StreamServerOf, type StreamServerOptions } from "@mb/engine-kit/stream"
import type { EventBus } from "../bus/event-bus"

/**
 * The engine's stream server (@mb/engine-kit/stream) for crypto: it accepts only crypto's stream
 * tokens (`cmb-stream.` HMAC prefix) and hides crypto's owner-only events from public viewers.
 */
export class StreamServer extends StreamServerOf<EventDataMap> {
  constructor(bus: EventBus, log: Logger, opts: StreamServerOptions) {
    super(bus, log, opts, { verifyToken: verifyStreamToken, ownerOnly: OWNER_ONLY_EVENTS })
  }
}
