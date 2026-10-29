import { cleanLine, cleanUrl } from "@mb/engine-kit/util/text"
import type { RequestText } from "../fetch"

/**
 * The search service (SearXNG, `search` in compose; docs/SERVER.md §9): one query, to the engines
 * named. Results are untrusted: every field is cleaned and capped here.
 *
 * Free engines answer from our own IP. Paid ones go through the residential proxy, billed per GB,
 * so research asks them only when the free ones find too little (packages/wire/docker/searxng.yml
 * routes them). An engine that filters by date gets the range. SearXNG skips the others when a
 * range is set, so they're asked without one, and only their results dated since `since` are kept.
 */

export type SearchResult = { url: string; title: string; snippet: string; published: string | null; engines: string[] }

export type SearchRange = "day" | "week" | "month"

/** A SearXNG engine, and whether it filters by date (`time_range`). */
export type SearchEngine = { name: string; byRange: boolean }

/** News engines that answer from our own IP. The first two date their results; Bing News doesn't, but filters by date. */
export const FREE_ENGINES: SearchEngine[] = [
  { name: "duckduckgo news", byRange: false },
  { name: "yahoo news", byRange: false },
  { name: "bing news", byRange: true },
]

/** Web engines that block our IP, through the residential proxy: one request each (~11 KB) per search. */
export const PAID_ENGINES: SearchEngine[] = [{ name: "google cse", byRange: true }]

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** One request to the service, for engines that all filter by date or all don't. */
const searchOnce = async (request: RequestText, base: string, query: string, engines: SearchEngine[], range: SearchRange | null, timeoutMs: number) => {
  const params = new URLSearchParams({ q: query, format: "json", engines: engines.map((e) => e.name).join(","), language: "en", ...(range ? { time_range: range } : {}) })
  // The service only serves us (its bot detection is off); the header keeps it from logging every request as an error.
  const res = await request(`${base.replace(/\/+$/, "")}/search?${params}`, { headers: { accept: "application/json", "x-real-ip": "127.0.0.1" }, timeoutMs, attempts: 1 })
  let body: unknown
  try {
    body = JSON.parse(res.text)
  } catch {
    throw new Error("the search service answered with something that isn't JSON")
  }
  if (!isObject(body) || !Array.isArray(body.results)) throw new Error("the search service answered in an unexpected shape")
  const results: SearchResult[] = []
  for (const r of body.results.filter(isObject)) {
    const url = typeof r.url === "string" ? cleanUrl(r.url) : null
    if (!url || results.some((x) => x.url === url)) continue
    const engines = Array.isArray(r.engines) ? r.engines.filter((e): e is string => typeof e === "string") : typeof r.engine === "string" ? [r.engine] : []
    const published = typeof r.publishedDate === "string" && !Number.isNaN(Date.parse(r.publishedDate)) ? new Date(r.publishedDate).toISOString() : null
    results.push({ url, title: cleanLine(typeof r.title === "string" ? r.title : "", 200), snippet: cleanLine(typeof r.content === "string" ? r.content : "", 400), published, engines: engines.slice(0, 5) })
  }
  const failed = Array.isArray(body.unresponsive_engines) ? body.unresponsive_engines.map((e) => (Array.isArray(e) ? String(e[0]) : String(e))).slice(0, 10) : []
  return { results, failed }
}

/**
 * Results of one query from `engines`, best first (alternating between the engines that filter by
 * date and the others), and the engines that failed it. `since` (an ISO date or time) is the
 * oldest result kept from engines that don't filter by date. Throws when the service can't be
 * reached or answers with an error.
 */
export const searchWeb = async (
  request: RequestText,
  base: string,
  query: string,
  { engines, range, since, timeoutMs }: { engines: SearchEngine[]; range: SearchRange; since: string; timeoutMs: number },
): Promise<{ results: SearchResult[]; failed: string[] }> => {
  const byRange = engines.filter((e) => e.byRange)
  const byDate = engines.filter((e) => !e.byRange)
  const oldest = Date.parse(since)
  const answers = await Promise.allSettled([
    byRange.length ? searchOnce(request, base, query, byRange, range, timeoutMs) : null,
    byDate.length ? searchOnce(request, base, query, byDate, null, timeoutMs).then((a) => ({ ...a, results: a.results.filter((r) => r.published !== null && Date.parse(r.published) >= oldest) })) : null,
  ])
  const done = answers.flatMap((a) => (a.status === "fulfilled" && a.value ? [a.value] : []))
  const error = answers.find((a) => a.status === "rejected")
  if (!done.length && error) throw error.reason
  const results: SearchResult[] = []
  for (let i = 0; done.some((a) => i < a.results.length); i++) for (const a of done) if (a.results[i] && !results.some((x) => x.url === a.results[i].url)) results.push(a.results[i])
  return { results, failed: done.flatMap((a) => a.failed) }
}
