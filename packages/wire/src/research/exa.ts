import { cleanLine, cleanUrl } from "@mb/engine-kit/util/text"
import type { RequestText } from "../fetch"
import { allowanceSoFar, type MeteredSearch, type SpendLedger } from "./metered"
import type { SearchResult } from "./search"

/**
 * Exa's search API (docs/SERVER.md §9), one of research's metered providers. The free plan gives
 * $10 of credit a calendar month (reset on the 1st), shared by both bots through one key
 * (EXA_API_KEY). An `auto` search for up to 10 results with highlights cost $0.007 on
 * 2026-10-29. It's paced in dollars (./metered): a search is reserved at EXA_SEARCH_USD and
 * settled at the cost Exa reports. Results are untrusted, cleaned here like the search service's.
 */

export const EXA = "exa"
/** The free plan's monthly credit, in dollars. */
export const EXA_MONTHLY_USD = 10
/** What a search is reserved at until Exa reports its cost. */
const EXA_SEARCH_USD = 0.007

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)

/** One `auto` search: up to `maxResults` results published since `since` (a date), with highlights as their snippets, and what it cost. */
export const exaSearch = async (request: RequestText, apiKey: string, query: string, { since, maxResults, timeoutMs }: { since: string; maxResults: number; timeoutMs: number }) => {
  const res = await request("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, type: "auto", numResults: maxResults, startPublishedDate: `${since.slice(0, 10)}T00:00:00.000Z`, contents: { highlights: { maxCharacters: 400 } } }),
    timeoutMs,
    attempts: 1,
  })
  const body = JSON.parse(res.text) as unknown
  if (!isObject(body) || !Array.isArray(body.results)) throw new Error("Exa answered in an unexpected shape")
  const results: SearchResult[] = []
  for (const r of body.results.filter(isObject)) {
    const url = typeof r.url === "string" ? cleanUrl(r.url) : null
    if (!url || results.some((x) => x.url === url)) continue
    const highlights = Array.isArray(r.highlights) ? r.highlights.filter((h): h is string => typeof h === "string") : []
    const published = typeof r.publishedDate === "string" && !Number.isNaN(Date.parse(r.publishedDate)) ? new Date(r.publishedDate).toISOString() : null
    results.push({ url, title: cleanLine(typeof r.title === "string" ? r.title : "", 200), snippet: cleanLine(highlights.join(" … "), 400), published, engines: [EXA] })
  }
  const cost = isObject(body.costDollars) && typeof body.costDollars.total === "number" ? body.costDollars.total : null
  return { results, cost }
}

/** Exa as a metered provider, paced in dollars. */
export const exaProvider = (request: RequestText, apiKey: string, ledger: SpendLedger, now: () => Date = () => new Date()): MeteredSearch => ({
  name: EXA,
  search: async (query, { since, maxResults, timeoutMs }) => {
    if (!(await ledger.take(EXA, EXA_SEARCH_USD, allowanceSoFar(EXA_MONTHLY_USD, now(), false), now()))) return null
    const { results, cost } = await exaSearch(request, apiKey, query, { since, maxResults, timeoutMs })
    if (cost !== null) ledger.adjust(EXA, cost - EXA_SEARCH_USD)
    return results
  },
})
