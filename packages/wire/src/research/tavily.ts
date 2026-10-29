import { HttpError } from "@mb/engine-kit/util/http"
import { cleanLine, cleanUrl } from "@mb/engine-kit/util/text"
import type { RequestText } from "../fetch"
import { allowanceSoFar, type MeteredSearch, type SpendLedger } from "./metered"
import type { SearchRange, SearchResult } from "./search"

/**
 * Tavily's search API (docs/SERVER.md §9), one of research's metered providers. The free plan has
 * 1,000 credits a calendar month (they reset on the 1st), shared by both bots through one key
 * (TAVILY_API_KEY), and a basic search costs one. It's paced like the others (./metered), and
 * also against Tavily's own count of the account (its usage endpoint), which covers both bots and
 * any other use of the key. Results are untrusted, cleaned here like the search service's.
 */

export const TAVILY = "tavily"
const API = "https://api.tavily.com"
/** How long a usage reading is trusted; our own searches since are added to it. */
const USAGE_TTL_MS = 5 * 60_000

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** The credits the month's days so far allow (UTC): floor(limit / days in the month) for each day up to today. */
export const tavilyAllowance = (limit: number, now: Date) => allowanceSoFar(limit, now)

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
    results.push({ url, title: cleanLine(typeof r.title === "string" ? r.title : "", 200), snippet: cleanLine(typeof r.content === "string" ? r.content : "", 400), published, engines: [TAVILY] })
  }
  return results
}

/**
 * Tavily's count of the account's month and its limit, from its usage endpoint (read at most every
 * USAGE_TTL_MS). The count lags our searches by minutes or more, so a new reading never lowers the
 * month's count below what this engine has already counted.
 */
export const tavilyAccount = (request: RequestText, apiKey: string, now: () => Date) => {
  let reading: { used: number; limit: number; at: number; month: string } | null = null
  let spentSince = 0
  let refreshing: Promise<void> | null = null

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
    /** The account's allowance so far, or null when its count has reached it. Throws when the usage can't be read. */
    allowance: async (): Promise<number | null> => {
      if (!reading || Date.now() - reading.at > USAGE_TTL_MS) await refresh()
      const r = reading!
      const allowance = tavilyAllowance(r.limit, now())
      return r.used + spentSince < allowance ? allowance : null
    },
    /** One search made. */
    spent: () => {
      spentSince++
    },
    /** Tavily refused for lack of credits (432): none until the next reading. */
    exhausted: () => {
      if (reading) spentSince = reading.limit
    },
  }
}

/** Tavily as a metered provider: within the account's allowance so far, and this engine's share of it. */
export const tavilyProvider = (request: RequestText, apiKey: string, ledger: SpendLedger, now: () => Date = () => new Date()): MeteredSearch => {
  const account = tavilyAccount(request, apiKey, now)
  return {
    name: TAVILY,
    search: async (query, { range, maxResults, timeoutMs }) => {
      const allowance = await account.allowance()
      if (allowance === null || !(await ledger.take(TAVILY, 1, allowance, now()))) return null
      account.spent()
      try {
        return await tavilySearch(request, apiKey, query, { range, maxResults, timeoutMs })
      } catch (error) {
        if (error instanceof HttpError && error.status === 432) account.exhausted()
        throw error
      }
    },
  }
}
