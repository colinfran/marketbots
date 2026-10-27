import type { PollFn } from "../poller"
import type { SourceContext, SourceSpec } from "../types"
import { symbolCycler } from "./rss"

/** A JSON API polled on an interval; the catalog entry's `map` turns the payload into items. */
export const jsonPoller = (spec: SourceSpec, ctx: SourceContext): PollFn => {
  if (!spec.map) throw new Error(`${spec.id}: a json source needs a map function`)
  const next = spec.urlFor ? symbolCycler(spec, ctx) : null
  return async () => {
    const symbol = next ? next() : null
    if (next && !symbol) return []
    const url = symbol && spec.urlFor ? spec.urlFor(symbol) : spec.url!
    const body = await ctx.fetch.json<unknown>(url, { headers: { accept: "application/json", ...spec.headers?.(ctx.env) } })
    return body === null ? null : spec.map!(body, ctx)
  }
}
