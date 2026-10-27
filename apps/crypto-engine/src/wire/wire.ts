import type { Settings } from "@mb/crypto-core/settings"
import { CATEGORY_BASE, type WireCategory } from "@mb/crypto-core/wire"
import { Wire as WireOf, type ItemEvent as ItemEventOf, type WireDeps as WireDepsOf } from "@mb/wire/wire"
import { requestText } from "../util/http"

export type WireSettings = Settings["wire"]

export type ItemEvent = ItemEventOf<WireCategory>

export type WireDeps = Omit<WireDepsOf<WireCategory, WireSettings>, "categoryBase" | "request" | "enrich">

/**
 * The news engine (@mb/wire/wire) with crypto's categories and their severity bases, fetching
 * through crypto's HTTP client, and asking the scraper for article text as its "crypto" caller.
 */
export class Wire extends WireOf<WireCategory, WireSettings> {
  constructor(d: WireDeps) {
    super({ ...d, categoryBase: CATEGORY_BASE, request: requestText, enrich: { client: "crypto" } })
  }
}
