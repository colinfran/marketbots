import { load } from "cheerio"
import { XMLParser } from "fast-xml-parser"
import { marketDay, marketTime } from "@mb/stock-core/time"
import { parseFeed, symbolCycler } from "@mb/wire/kinds/rss"
import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { companyDirectoryOrAliases, normalizeName, shortName } from "./companies"
import { BROWSER_HEADERS, tracked, watched } from "./common"

/**
 * Outlets that need more than the generic RSS kind (MASTER_PLAN §4.2 wave 2):
 *
 *   rss:seekingalpha   Seeking Alpha market currents, whose items name their ticker in a
 *                      <category domain=".../symbol/X">
 *   persymbol:nasdaq   Nasdaq.com per-symbol RSS for held and watched stocks (round-robin; browser
 *                      User-Agent), with <nasdaq:tickers> on each item
 *   finviz             Finviz's news page (HTML): the "News" column tier 2, "Blogs" tier 3; the
 *                      links go to the original outlet, so its copies confirm other sources' items
 *   gdelt              GDELT DOC 2.0 for held and watched companies by name (keyless; it often
 *                      answers 429 from this server, and then degrades and backs off)
 *
 * Feed tags are only trusted for items about one to three tickers (a listicle tags a dozen), and
 * only tickers we track are kept; anything else is left to the lexicon, so the relevance filter
 * still keeps only items about a tracked symbol or the whole market.
 */

const tagParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", isArray: (name) => name === "item" || name === "category" })

type TaggedItem = { link?: unknown; category?: (string | { "#text"?: string; "@_domain"?: string })[]; "nasdaq:tickers"?: string }

/** Link → the tickers its item is tagged with: Seeking Alpha's symbol categories, Nasdaq's ticker list. */
export const feedTags = (xml: string): Map<string, string[]> => {
  const doc = tagParser.parse(xml) as { rss?: { channel?: { item?: TaggedItem[] } } }
  const out = new Map<string, string[]>()
  for (const i of doc.rss?.channel?.item ?? []) {
    const fromCategories = (i.category ?? []).flatMap((c) => {
      const domain = typeof c === "object" ? (c["@_domain"] ?? "") : ""
      const m = /\/symbol\/([A-Za-z.-]+)$/.exec(domain)
      return m ? [m[1].toUpperCase()] : []
    })
    const fromList = String(i["nasdaq:tickers"] ?? "")
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean)
    out.set(String(i.link ?? "").trim(), [...new Set([...fromCategories, ...fromList])])
  }
  return out
}

/**
 * Items with their tags as symbols, when the tags are few and tracked; otherwise the lexicon
 * decides. `only`: a per-symbol feed, whose other tags are related tickers, not the subject.
 */
export const taggedFeed = (xml: string, known: ReadonlySet<string>, only?: string): RawItem[] => {
  const tags = feedTags(xml)
  return parseFeed(xml).map((item) => {
    const t = tags.get(item.url ?? "") ?? []
    const mine = t.filter((s) => known.has(s) && (!only || s === only))
    return t.length >= 1 && t.length <= 3 && mine.length ? { ...item, symbols: mine } : item
  })
}

const seekingAlphaSpec: SourceSpec = {
  id: "rss:seekingalpha",
  kind: "custom",
  url: "https://seekingalpha.com/market_currents.xml",
  interval_s: 60,
  tier: 2,
  default_enabled: true,
  note: "Seeking Alpha market currents; each item's ticker comes from its symbol category",
  create: (spec, ctx) =>
    new PollingSource(spec, ctx, async () => {
      const res = await ctx.fetch.get(spec.url!, { headers: { accept: "application/rss+xml" } })
      return res.notModified ? null : taggedFeed(res.text, tracked(ctx))
    }),
}

const nasdaqSymbolSpec: SourceSpec = {
  id: "persymbol:nasdaq",
  kind: "custom",
  url: "https://www.nasdaq.com/feed/rssoutbound",
  symbols: "held+focus",
  interval_s: 45,
  tier: 2,
  default_enabled: true,
  note: "Nasdaq.com per-symbol RSS (browser User-Agent), round-robin over held and watched stocks",
  create: (spec, ctx) => {
    const next = symbolCycler(spec, ctx)
    return new PollingSource(spec, ctx, async () => {
      const symbol = next()
      if (!symbol) return []
      const res = await ctx.fetch.get(`${spec.url}?symbol=${encodeURIComponent(symbol)}`, { headers: { ...BROWSER_HEADERS, accept: "application/rss+xml" } })
      if (res.notModified) return null
      return taggedFeed(res.text, tracked(ctx), symbol).map((i) => ({ ...i, meta: { ...i.meta, query_symbol: symbol } }))
    })
  },
}

// ── Finviz news ─────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "10:28PM" (today, New York) or "Oct-25" (an earlier day) → an instant, never in the future. */
export const finvizTime = (s: string, now: Date): Date | null => {
  const today = marketDay(now)
  const t = /^(\d{1,2}):(\d{2})(AM|PM)$/.exec(s.trim())
  if (t) {
    const h = (Number(t[1]) % 12) + (t[3] === "PM" ? 12 : 0)
    const at = marketTime(today, `${String(h).padStart(2, "0")}:${t[2]}`)
    return at.getTime() > now.getTime() + 60_000 ? new Date(at.getTime() - 86_400_000) : at
  }
  const d = /^([A-Z][a-z]{2})-(\d{1,2})$/.exec(s.trim())
  const month = d ? MONTHS.indexOf(d[1]) + 1 : 0
  if (!d || !month) return null
  let year = Number(today.slice(0, 4))
  if (`${year}-${String(month).padStart(2, "0")}` > today.slice(0, 7)) year -= 1
  return marketTime(`${year}-${String(month).padStart(2, "0")}-${d[2].padStart(2, "0")}`, "09:30")
}

/** The two columns of finviz.com/news.ashx: news (tier 2) and blogs (tier 3). */
export const parseFinvizNews = (html: string, now: Date): RawItem[] => {
  const $ = load(html)
  const items: RawItem[] = []
  $("table.styled-table-new").each((col, table) => {
    $(table)
      .find("tr.news_table-row")
      .each((_, tr) => {
        const a = $(tr).find("a.nn-tab-link").first()
        const title = a.text().replace(/\s+/g, " ").trim()
        const href = a.attr("href")
        if (!title || !href) return
        let url: string | null = null
        try {
          url = new URL(href, "https://finviz.com/").toString()
        } catch {
          url = null
        }
        const outlet = /#([a-z0-9-]+?)-(?:light|dark)$/.exec($(tr).find("use").first().attr("href") ?? "")?.[1] ?? null
        const summary = $(tr).find("td.news_link-cell").attr("data-boxover-text")?.trim() ?? null
        items.push({
          title,
          summary: summary && summary !== title ? summary : null,
          url,
          publishedAt: finvizTime($(tr).find("td.news_date-cell").text(), now),
          tier: col === 0 ? 2 : 3,
          meta: { outlet },
        })
      })
  })
  return items
}

// ── GDELT ───────────────────────────────────────────────────────────────────

type GdeltArticle = { url: string; title: string; seendate?: string; domain?: string; language?: string; sourcecountry?: string }

/** GDELT's "20261027T023000Z". */
export const gdeltDate = (s: string | undefined) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s ?? "")
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null
}

const GDELT_BATCH = 8
/** One-word company names that are everyday words: as a search phrase they'd match everything. */
const EVERYDAY = new Set(["APPLE", "TARGET", "VISA", "SHELL", "BALL", "GAP", "BEST", "SQUARE", "BLOCK", "MATCH", "SNAP", "BOX", "UNITY", "COHERENT", "PROGRESSIVE", "CARNIVAL", "ALLY", "CHEWY", "UNION"])

/** Two words or more, or one word of 5+ letters that isn't an everyday word. */
const distinctiveName = (words: string[]) => (words.length >= 2 ? words.join(" ").length >= 6 : words.length === 1 && words[0].length >= 5 && !EVERYDAY.has(words[0]))

/** One OR query of quoted company names; GDELT ignores phrases shorter than 3 letters. */
export const gdeltQuery = (names: string[]) => `(${names.map((n) => `"${n}"`).join(" OR ")}) sourcelang:english`

/** Articles → items tagged with the companies their titles name (case-insensitive, whole words). */
export const gdeltItems = (articles: GdeltArticle[], companies: { symbol: string; name: string }[]): RawItem[] =>
  articles.map((a) => {
    const symbols = companies.filter((c) => new RegExp(`(^|[^\\p{L}\\p{N}])${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(a.title)).map((c) => c.symbol)
    return { title: a.title, url: a.url, publishedAt: gdeltDate(a.seendate), ...(symbols.length ? { symbols } : {}), meta: { language: a.language ?? null, country: a.sourcecountry ?? null } }
  })

const gdeltPoll = (ctx: SourceContext) => {
  let batch = 0
  return async (): Promise<RawItem[]> => {
    const dir = await companyDirectoryOrAliases(ctx)
    const companies = [...watched(ctx)].flatMap((symbol) => {
      const title = dir.names.get(symbol)
      const words = title ? normalizeName(title) : []
      return distinctiveName(words) ? [{ symbol, name: shortName(title!) }] : []
    })
    if (!companies.length) return []
    const batches = Math.ceil(companies.length / GDELT_BATCH)
    const chunk = companies.slice((batch % batches) * GDELT_BATCH, (batch % batches) * GDELT_BATCH + GDELT_BATCH)
    batch += 1
    // GDELT rejects 30 minutes as "too short"; an hour overlaps polls, and dedupe drops the repeats.
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(gdeltQuery(chunk.map((c) => c.name)))}&mode=artlist&format=json&maxrecords=75&timespan=1h&sort=datedesc`
    const body = await ctx.fetch.json<{ articles?: GdeltArticle[] }>(url, { conditional: false, timeoutMs: 30_000 })
    return gdeltItems(body?.articles ?? [], chunk)
  }
}

// ── Catalog entries ─────────────────────────────────────────────────────────

export const OUTLET_SOURCES: SourceSpec[] = [
  seekingAlphaSpec,
  nasdaqSymbolSpec,
  {
    id: "finviz",
    kind: "custom",
    url: "https://finviz.com/news.ashx",
    interval_s: 120,
    tier: 2,
    default_enabled: true,
    note: "Finviz news page (HTML; browser User-Agent): news column tier 2, blogs tier 3",
    create: (spec, ctx) =>
      new PollingSource(spec, ctx, async () => {
        const res = await ctx.fetch.get(spec.url!, { headers: { ...BROWSER_HEADERS, accept: "text/html" } })
        return res.notModified ? null : parseFinvizNews(res.text, ctx.now())
      }),
  },
  {
    id: "gdelt",
    kind: "custom",
    url: "https://api.gdeltproject.org/api/v2/doc/doc",
    interval_s: 300,
    tier: 3,
    default_enabled: true,
    note: "GDELT DOC 2.0 (keyless; one request per 5 s, enforced by the limiter; often answers 429 or times out, so it degrades and backs off): held and watched companies by name, 8 per query in rotation",
    create: (spec, ctx) => new PollingSource(spec, ctx, gdeltPoll(ctx)),
  },
]
