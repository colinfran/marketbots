import type { WireCategory } from "@mb/stock-core/wire"
import { parseFeed } from "@mb/wire/kinds/rss"
import { PollingSource } from "@mb/wire/poller"
import { EIGHT_K_ITEMS, ITEM_PRIORITY } from "../lexicon"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { companyDirectory } from "./companies"

/**
 * SEC EDGAR "latest filings" Atom feeds, one per form group. Each entry's
 * title carries the form, company and CIK; its summary lists the 8-K item numbers. The CIK maps
 * to a ticker through the SEC's company_tickers.json (reloaded daily); filings by companies
 * without a listed ticker are dropped. SEC fair access: a descriptive User-Agent (the wire's) and
 * at most 4 requests/s from this bot (the limiter).
 */

/** CIK → ticker from the SEC company directory (sources/companies.ts: loaded once a day, shared with the sources that map company names). */
export const cikTickers = async (ctx: SourceContext): Promise<Map<number, string>> => (await companyDirectory(ctx)).byCik

export const parseEdgarTitle = (title: string) => {
  const m = /^(.+?) - (.+?) \((\d{10})\) \((\w+)\)$/.exec(title.trim())
  return m ? { form: m[1].trim(), company: m[2].trim(), cik: Number(m[3]), role: m[4] } : null
}

/** "Item 2.02: Results of Operations…" lines from an entry summary. */
export const parseEdgarItems = (summary: string | null | undefined) =>
  [...(summary ?? "").replace(/<[^>]+>/g, "\n").matchAll(/Item (\d\.\d\d):\s*([^\n]+)/g)].map((m) => ({ item: m[1], name: m[2].trim() }))

const FORM_CATEGORY = (form: string): WireCategory | null => {
  if (/^NT 10-[KQ]/.test(form)) return "late_filing"
  if (/^25-NSE/.test(form)) return "delisting_notice"
  if (/^424B/.test(form)) return "offering"
  return null
}

/** One EDGAR entry → an item about its ticker, or null when the filer has no listed ticker. */
export const edgarItem = (entry: RawItem, map: ReadonlyMap<number, string>): RawItem | null => {
  const t = parseEdgarTitle(entry.title)
  if (!t || t.role !== "Filer") return null
  const ticker = map.get(t.cik)
  if (!ticker) return null
  const items = parseEdgarItems(entry.summary)
  const material = ITEM_PRIORITY.find((code) => items.some((i) => i.item === code))
  const category: WireCategory = (material ? EIGHT_K_ITEMS[material] : null) ?? FORM_CATEGORY(t.form) ?? "general"
  const what = items.length ? items.filter((i) => !["9.01"].includes(i.item)).map((i) => `${i.item} ${i.name}`).join("; ") : t.company
  return {
    sourceId: entry.sourceId ?? null,
    title: `${ticker} ${t.form}: ${what}`,
    summary: `${t.company} (CIK ${t.cik})`,
    url: entry.url,
    publishedAt: entry.publishedAt,
    symbols: [ticker],
    category,
    kind: "filing",
    tier: 1,
    meta: { form: t.form, cik: t.cik, items: items.map((i) => i.item).join(",") || null },
  }
}

const atom = (type: string) => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&company=&dateb=&owner=include&start=0&count=40&output=atom`

const edgarSpec = (id: string, type: string, interval_s: number): SourceSpec => ({
  id,
  kind: "custom",
  url: atom(type),
  interval_s,
  tier: 1,
  wire_kind: "filing",
  key_env: "SEC_USER_AGENT",
  default_enabled: true,
  create: (spec, ctx) =>
    new PollingSource(spec, ctx, async () => {
      const map = await cikTickers(ctx)
      const res = await ctx.fetch.get(spec.url!, { headers: { accept: "application/atom+xml" } })
      if (res.notModified) return null
      return parseFeed(res.text)
        .map((e) => edgarItem(e, map))
        .filter((i): i is RawItem => i !== null)
    }),
})

/** 8-K material events, late filings, offerings (424B prospectuses), activist stakes, delistings. */
export const EDGAR_SPECS: SourceSpec[] = [
  edgarSpec("edgar:8k", "8-K", 30),
  edgarSpec("edgar:6k", "6-K", 300),
  edgarSpec("edgar:nt", "NT 10", 300),
  edgarSpec("edgar:424b", "424B", 120),
  edgarSpec("edgar:13d", "SC 13D", 300),
  edgarSpec("edgar:25", "25-NSE", 600),
]
