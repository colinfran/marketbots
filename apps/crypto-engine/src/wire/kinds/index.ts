// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import type { WireSourceState } from "@mb/crypto-core/wire"
import { PollingSource, type PollFn } from "../poller"
import type { SourceContext, SourceSpec, WireSource } from "../types"
import { diffPoller } from "./diff"
import { headlessPoller } from "./headless"
import { htmlPoller } from "./html"
import { jsonPoller } from "./json"
import { rssPoller } from "./rss"
import { statuspagePoller } from "./statuspage"
import { telegramPoller } from "./telegram"

const POLLERS: Record<Exclude<SourceSpec["kind"], "custom">, (spec: SourceSpec, ctx: SourceContext) => PollFn> = {
  rss: rssPoller,
  json: jsonPoller,
  html: htmlPoller,
  headless: headlessPoller,
  statuspage: statuspagePoller,
  telegram: telegramPoller,
  diff: diffPoller,
}

/** A catalog entry → a running source: a generic poller for the standard kinds, `create` for custom ones. */
export const buildSource = (spec: SourceSpec, ctx: SourceContext, onState: (id: string, state: WireSourceState, error: string | null) => void): WireSource => {
  if (spec.kind === "custom") {
    if (!spec.create) throw new Error(`${spec.id}: a custom source needs create()`)
    return spec.create(spec, ctx)
  }
  return new PollingSource(spec, ctx, POLLERS[spec.kind](spec, ctx), onState)
}
