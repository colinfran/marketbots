import { cleanLine, cleanUrl } from "@mb/engine-kit/util/text"
import type { RequestText } from "../fetch"
import type { SearchRange, SearchResult } from "./search"

/**
 * Tavily's search API (docs/SERVER.md §9), for research's searches the free engines find too
 * little for. The free plan has 1,000 credits a calendar month (they reset on the 1st), shared by
 * both bots through one key (TAVILY_API_KEY), and a basic search costs one. So spending is paced:
 * each day of the month adds an equal share, floor(limit / days in the month), and a search is
 * made only while the month's usage is under the shares of the days so far. Tavily's usage
 * endpoint is the count, so it covers both bots and survives restarts. A day's unused share carries
 * over to later days; the month's credits can't run out early. Results are untrusted, cleaned
 * here like the search service's.
 */

const API = "https://api.tavily.com"
/** How long a usage reading is trusted; our own searches since are added to it. */
const USAGE_TTL_MS = 5 * 60_000
/** The engines sharing the key (both bots): each may spend its share of the allowance by its own count, whatever Tavily's lagging count says. */
const SHARING_ENGINES = 2

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** The credits the month's days so far allow (UTC): floor(limit / days in the month) for each day up to today. */
export const tavilyAllowance = (limit: number, now: Date) => {
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  return Math.floor(limit / days) * now.getUTCDate()
}

/** One basic search (one credit): up to `maxResults` results, published within `range` where Tavily knows the date. */
export const tavilySearch = async (request: RequestText, apiKey: string, query: string, { range, maxResults, timeoutMs }: { range: SearchRange; maxResults: number; timeoutMs: number }): Promise<SearchResult[]> => {
  const res = await request(`${API}/search`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, search_depth: "basic", topic: "general", time_range: range, max_results: maxResults, include_published_date: true, include_answer: false, include_raw_content: false, include_images: false }),
    timeoutMs,
    attempts: 1,
  })
  const body = JSON.parse(res.text) as unknown
  if (!isObject(body) || !Array.isArray(body.results)) throw new Error("Tavily answered in an unexpected shape")
  const results: SearchResult[] = []
  for (const r of body.results.filter(isObject)) {
    const url = typeof r.url === "string" ? cleanUrl(r.url) : null
    if (!url || results.some((x) => x.url === url)) continue
    const published = typeof r.published_date === "string" && !Number.isNaN(Date.parse(r.published_date)) ? new Date(r.published_date).toISOString() : null
    results.push({ url, title: cleanLine(typeof r.title === "string" ? r.title : "", 200), snippet: cleanLine(typeof r.content === "string" ? r.content : "", 400), published, engines: ["tavily"] })
  }
  return results
}

/**
 * The pacer: `take()` is true when one more search fits the month's allowance so far, and counts
 * it. Tavily's count lags our searches by minutes or more, so a new reading never lowers the
 * month's count below what this engine has already counted, and each engine also keeps to its
 * share of the allowance (1 / SHARING_ENGINES) by its own count, so two engines can't each spend
 * the whole allowance before Tavily's count shows the other's searches.
 */
export const tavilyPacer = (request: RequestText, apiKey: string, now: () => Date = () => new Date()) => {
  let reading: { used: number; limit: number; at: number; month: string } | null = null
  let spentSince = 0
  let own = { month: "", count: 0 }
  let refreshing: Promise<void> | null = null

  /** The account's credits used this month and its monthly limit, from Tavily's usage endpoint. */
  const refresh = () =>
    (refreshing ??= (async () => {
      const res = await request(`${API}/usage`, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, timeoutMs: 10_000, attempts: 1 })
      const account = (JSON.parse(res.text) as Json).account
      const used = isObject(account) ? account.plan_usage : undefined
      const limit = isObject(account) ? account.plan_limit : undefined
      if (typeof used !== "number" || typeof limit !== "number") throw new Error("Tavily's usage answered in an unexpected shape")
      const month = now().toISOString().slice(0, 7)
      const counted = reading?.month === month ? reading.used + spentSince : 0
      reading = { used: Math.max(used, counted), limit, at: Date.now(), month }
      spentSince = 0
    })().finally(() => {
      refreshing = null
    }))

  return {
    /** One search's credit, if the allowance so far has one left. Throws when Tavily's usage can't be read (then nothing is spent). */
    take: async (): Promise<boolean> => {
      if (!reading || Date.now() - reading.at > USAGE_TTL_MS) await refresh()
      const r = reading!
      const month = now().toISOString().slice(0, 7)
      if (own.month !== month) own = { month, count: 0 }
      const allowed = tavilyAllowance(r.limit, now())
      if (r.used + spentSince >= allowed || own.count >= Math.floor(allowed / SHARING_ENGINES)) return false
      spentSince++
      own.count++
      return true
    },
    /** Tavily refused for lack of credits (432): none until the next reading. */
    exhausted: () => {
      if (reading) spentSince = reading.limit
    },
    /** For the log: the month's usage as last read plus our searches since, this engine's own, and the allowance so far. */
    state: () => (reading ? { used: reading.used + spentSince, own: own.count, allowed: tavilyAllowance(reading.limit, now()), limit: reading.limit } : null),
  }
}
