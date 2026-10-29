import { cleanLine, cleanUrl } from "@mb/engine-kit/util/text"
import type { RequestText } from "../fetch"
import { allowanceSoFar, type MeteredSearch, type SpendLedger } from "./metered"
import type { SearchRange, SearchResult } from "./search"

/**
 * Bright Data's SERP API (docs/SERVER.md §9), one of research's metered providers: Google's
 * results, fetched by Bright Data, 5,000 requests a calendar month on the account's allowance,
 * shared by both bots through one key (BRIGHTDATA_API_KEY) and SERP zone (BRIGHTDATA_ZONE). It's
 * slow (10–14 s a search, and failures after 2–25 s, on 2026-10-29), so it's asked after the
 * faster providers. Google dates results relatively ("9 hours ago"); they're turned into times
 * here. Results are untrusted, cleaned here like the search service's.
 */

export const BRIGHT_DATA = "brightdata"
/** The account's monthly allowance, in requests. */
export const BRIGHT_DATA_MONTHLY_REQUESTS = 5_000
/** The SERP zone's name when BRIGHTDATA_ZONE is unset: the name Bright Data gives an account's first one. */
export const BRIGHT_DATA_ZONE = "serp_api1"

const RANGE: Record<SearchRange, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m" }
const UNIT_MS: Record<string, number> = { sec: 1_000, second: 1_000, min: 60_000, minute: 60_000, hr: 3_600_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000 }
const RELATIVE = /^(\d+)\s*(sec|second|min|minute|hr|hour|day|week|month|year)s?\s+ago$/i

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : "")

/** Google's date for a result as an ISO time: "9 hours ago", "Yesterday", "Oct 26, 2026". Null when the text isn't one. */
export const googleDate = (text: string, now: Date): string | null => {
  const t = text.trim()
  if (/^yesterday$/i.test(t)) return new Date(now.getTime() - 86_400_000).toISOString()
  const m = RELATIVE.exec(t)
  if (m) return new Date(now.getTime() - Number(m[1]) * UNIT_MS[m[2].toLowerCase()]).toISOString()
  const ms = /\b\d{4}\b/.test(t) ? Date.parse(t) : Number.NaN
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/** One Google search within `range`, in English for the US: its top stories, then its results, up to `maxResults`. */
export const brightDataSearch = async (
  request: RequestText,
  apiKey: string,
  zone: string,
  query: string,
  { range, maxResults, timeoutMs }: { range: SearchRange; maxResults: number; timeoutMs: number },
  now: Date,
): Promise<SearchResult[]> => {
  const url = `https://www.google.com/search?${new URLSearchParams({ q: query, tbs: RANGE[range], hl: "en", gl: "us" })}&brd_json=1`
  const res = await request("https://api.brightdata.com/request", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
    timeoutMs,
    attempts: 1,
  })
  // A failed search still answers 200: with its reason in a header, and text instead of JSON.
  let body: unknown
  try {
    body = JSON.parse(res.text)
  } catch {
    throw new Error(`Bright Data: ${cleanLine(res.headers.get("x-brd-error") || res.text, 200) || "an empty answer"}`)
  }
  if (!isObject(body)) throw new Error("Bright Data answered in an unexpected shape")
  const results: SearchResult[] = []
  const add = (link: unknown, title: unknown, snippet: string, dates: string[]) => {
    const url = typeof link === "string" ? cleanUrl(link) : null
    if (!url || results.some((x) => x.url === url)) return
    const published = dates.map((d) => googleDate(d, now)).find((d) => d !== null) ?? null
    results.push({ url, title: cleanLine(str(title), 200), snippet: cleanLine(snippet, 400), published, engines: [BRIGHT_DATA] })
  }
  const stories = isObject(body.top_stories) && Array.isArray(body.top_stories.items) ? body.top_stories.items.filter(isObject) : []
  for (const s of stories) add(s.link, s.title, str(s.source), [str(s.date)])
  for (const o of Array.isArray(body.organic) ? body.organic.filter(isObject) : []) {
    const extensions = Array.isArray(o.extensions) ? o.extensions.filter(isObject).map((e) => str(e.text)) : []
    add(o.link, o.title, str(o.description), extensions)
  }
  return results.slice(0, maxResults)
}

/** Bright Data as a metered provider: a request each search. */
export const brightDataProvider = (request: RequestText, apiKey: string, zone: string, ledger: SpendLedger, now: () => Date = () => new Date()): MeteredSearch => ({
  name: BRIGHT_DATA,
  search: async (query, { range, maxResults, timeoutMs }) => {
    if (!(await ledger.take(BRIGHT_DATA, 1, allowanceSoFar(BRIGHT_DATA_MONTHLY_REQUESTS, now()), now()))) return null
    return brightDataSearch(request, apiKey, zone, query, { range, maxResults, timeoutMs }, now())
  },
})
