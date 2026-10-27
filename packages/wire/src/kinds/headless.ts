import { HttpError } from "@mb/engine-kit/util/http"
import type { PollFn } from "../poller"
import type { SourceContext, SourceSpec } from "../types"
import { parseHtml } from "./html"

/**
 * A page that needs JavaScript, rendered by the scraper sidecar (apps/scraper, MASTER_PLAN
 * Phase 7) and then read like an html source (selectors or mapHtml), or from the JSON responses
 * the page loaded itself (`render.capture`, read with `map`). Only for sites whose robots.txt and
 * terms allow it; the catalog notes the check. Off until SCRAPER_URL is set (wire.ts), and a dead
 * sidecar only takes these sources down.
 */

export type Captured = { url: string; status: number; body: string }
export type Rendered = { status: number; url: string; html: string; captured: Captured[] }

const DEFAULT_TIMEOUT_MS = 30_000

export const headlessPoller = (spec: SourceSpec, ctx: SourceContext): PollFn => {
  const capture = spec.render?.capture ?? []
  if (capture.length ? !spec.map : !spec.selectors && !spec.mapHtml) throw new Error(`${spec.id}: a headless source needs map (with render.capture), selectors or mapHtml`)
  const timeout = spec.render?.timeout_ms ?? DEFAULT_TIMEOUT_MS
  return async () => {
    const base = ctx.env.SCRAPER_URL
    if (!base) throw new Error("SCRAPER_URL not set")
    const r = await ctx.fetch.postJson<Rendered>(
      `${base.replace(/\/+$/, "")}/render`,
      { url: spec.url, wait_for: spec.render?.wait_for ?? null, timeout_ms: timeout, capture },
      // The sidecar renders two pages at a time; a render may wait for one ahead of it.
      { timeoutMs: 2 * timeout + 10_000 },
    )
    // The site's own answer: a 403 or 429 marks the source degraded, like a plain fetch would.
    if (r.status >= 400) throw new HttpError(r.status, `${new URL(spec.url!).host} answered ${r.status} (rendered)`, "")
    if (capture.length) return spec.map!(r.captured, ctx)
    return spec.mapHtml ? spec.mapHtml(r.html, ctx) : parseHtml(r.html, spec.selectors!, r.url || spec.url!)
  }
}
