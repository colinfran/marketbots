import type { EventDoc } from "@mb/core/db"
import type { EngineEvent } from "@mb/core/events"
import type { Collection } from "mongodb"
import { EventBus } from "../bus"
import { silentLogger } from "../log"

/** A real event bus on the test database (events are kept in memory; flushing is up to the test). */
export const makeTestBus = async <M>(col: { events: Collection<EventDoc<EngineEvent<M>>> }, ephemeral: ReadonlySet<keyof M>) => {
  const bus = new EventBus<M>(col, silentLogger, 30, ephemeral)
  await bus.init()
  return bus
}
