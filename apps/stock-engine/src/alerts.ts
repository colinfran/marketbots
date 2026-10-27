import { Alerts as AlertsOf } from "@mb/engine-kit/alerts"
import type { Logger } from "@mb/engine-kit/log"
import type { EventBus } from "./bus/event-bus"
import type { Collections } from "./db/mongo"

/** The engine's alerts (@mb/engine-kit/alerts), posted to Discord as StockMarketBot. */
export class Alerts extends AlertsOf {
  constructor(col: Pick<Collections, "notifications">, bus: EventBus, log: Logger, webhook: string | null, dashboardUrl: string | null) {
    super(col, bus, log, webhook, dashboardUrl, "StockMarketBot")
  }
}
