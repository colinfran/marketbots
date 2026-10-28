import { cleanLine, cleanUrl } from "@mb/engine-kit/util/text"
import type { RequestText } from "../fetch"

/**
 * The search service (SearXNG, `search` in compose; docs/SERVER.md §9): one query, news and web
 * results together, from the engines it asks (Google, Bing News, DuckDuckGo, Startpage…). Results
 * are untrusted: every field is cleaned and capped here.
 */

export type SearchResult = { url: string; title: string; snippet: string; published: string | null; engines: string[] }

export type SearchRange = "day" | "week" | "month"

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** Results of one query, best first, and the engines that failed it. Throws when the service can't be reached or answers with an error. */
export const searchWeb = async (request: RequestText, base: string, query: string, { range, timeoutMs }: { range: SearchRange; timeoutMs: number }): Promise<{ results: SearchResult[]; failed: string[] }> => {
  const params = new URLSearchParams({ q: query, format: "json", categories: "news,general", time_range: range, language: "en" })
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
