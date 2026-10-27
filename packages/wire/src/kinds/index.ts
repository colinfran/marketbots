import type { WireSettingsBase } from "@mb/core/settings"
import type { WireSourceState } from "@mb/core/wire"
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

/**
 * A catalog entry → a running source: a generic poller for the standard kinds, `create` for custom
 * ones. A generic poller returns what the entry's own `map`, `refine`, `describe` or `mapHtml`
 * make, plus statuspage's two categories (StatuspageCategory), which the Wire's `categoryBase`
 * requires every bot to have: so its items are the bot's categories.
 */
export const buildSource = <C extends string, W extends WireSettingsBase>(spec: SourceSpec<C, W>, ctx: SourceContext<W>, onState: (id: string, state: WireSourceState, error: string | null) => void): WireSource<C> => {
  if (spec.kind === "custom") {
    if (!spec.create) throw new Error(`${spec.id}: a custom source needs create()`)
    return spec.create(spec, ctx)
  }
  return new PollingSource(spec, ctx, POLLERS[spec.kind](spec, ctx) as PollFn<C>, onState)
}
