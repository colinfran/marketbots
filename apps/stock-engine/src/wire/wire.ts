import type { Settings } from "@mb/stock-core/settings"
import { CATEGORY_BASE, type WireCategory } from "@mb/stock-core/wire"
import { Wire as WireOf, type ItemEvent as ItemEventOf, type WireDeps as WireDepsOf } from "@mb/wire/wire"
import { requestText } from "../util/http"

export type WireSettings = Settings["wire"]

export type ItemEvent = ItemEventOf<WireCategory>

export type WireDeps = Omit<WireDepsOf<WireCategory, WireSettings>, "categoryBase" | "request">

/** The news engine (@mb/wire/wire) with stock's categories and their severity bases, fetching through stock's HTTP client. */
export class Wire extends WireOf<WireCategory, WireSettings> {
  constructor(d: WireDeps) {
    super({ ...d, categoryBase: CATEGORY_BASE, request: requestText })
  }
}
