import { crossingId, crossingMeta, metricSource, type MetricRule, type MetricWatcher } from "@mb/wire/metrics"
import {
  apewisdomItems as apewisdomItemsOf,
  APP_CHARTS,
  appChartCrossings,
  appChartTitle,
  attention,
  ENTRY,
  pageviewItems,
  pageviewRatio as pageviewRatioOf,
  pageviewsUrl,
  STOCKTWITS_API,
  stocktwitsTrendingItems as stocktwitsTrendingItemsOf,
  type ApeResult,
  type AppChart,
  type AppleGenre,
  type AppleTop,
  type ChartApp,
  type Pageviews,
  type StSymbol,
} from "@mb/wire/sources/attention"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { companyDirectoryOrAliases, shortName } from "./companies"
import { BROWSER_HEADERS, num, settleAll, watched } from "./common"

export { APP_CHARTS, appRank } from "@mb/wire/sources/attention"

/**
 * Retail attention and sentiment (MASTER_PLAN §4.2 wave 2): all `sentiment_spike`, tier 3, low
 * severity, annotate only (§3.5). Each source reports a change, never a level, and only for held
 * and watched symbols (market-wide for the fear gauge and the broker apps). The building blocks
 * both bots use are in @mb/wire/sources/attention.
 *
 *   fng                CNN Fear & Greed entering (≤ 25 / ≥ 75) or leaving (past 30 / 70, at least
 *                      an hour later) extreme fear or greed; the 5-day put/call average rides along
 *   stocktwits         a held or watched stock entering StockTwits trending
 *   wsb:apewisdom      Reddit/4chan mentions (24 h) ≥ 3× the day before, with at least 30 mentions
 *   wsb:tradestie      a held or watched stock entering r/wallstreetbets' ten most discussed
 *                      (Tradestie top 50, at least 50 comments)
 *   appstore           Robinhood or Webull entering the US top-100 free apps or climbing ≥ 25
 *                      places there (≥ 15 in Finance, into its top 20) within 24 h
 *   wikipedia          yesterday's article views ≥ 3× the 4-week median (at least 100 a day normally)
 *
 * A trending entry only counts again after the stock has been off the list and 6 hours have
 * passed, so a stock hovering at the edge of a list doesn't repeat.
 */

/** Held and watched stocks, each listed by its own ticker. */
const watchedTargets = (ctx: SourceContext) => [...watched(ctx)].map((symbol) => ({ key: symbol, ticker: symbol, symbol }))

// ── CNN Fear & Greed ────────────────────────────────────────────────────────

type CnnFng = {
  fear_and_greed?: { score?: number; rating?: string; timestamp?: string; previous_close?: number }
  put_call_options?: { data?: { x: number; y: number }[] }
}

/**
 * CNN's index moves all day, so a plain "is it extreme" flag would flap around 25. The depth past
 * 50 is watched instead: extreme at 25 points (score ≤ 25 or ≥ 75), and over only once it is back
 * within 20 (score past 30 or 70) and an hour has passed.
 */
const FNG_RULE: MetricRule = { id: "extreme", kind: "level", abs: 25, rearmAt: 0.8, rearmMs: 3_600_000, exits: true }

export const cnnFngItems = (body: CnnFng, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const f = body.fear_and_greed
  const score = num(f?.score)
  if (!f || score === null) return []
  const at = Date.parse(f.timestamp ?? "") || ctx.now().getTime()
  const putCall = body.put_call_options?.data?.at(-1)?.y
  const rating = String(f.rating ?? "")
  const prev = num(f.previous_close)
  const items: RawItem[] = []
  for (const [side, depth] of [
    ["fear", Math.max(0, 50 - score)],
    ["greed", Math.max(0, score - 50)],
  ] as const) {
    for (const c of w.observe(`cnn_fng:${side}`, depth, at, [FNG_RULE])) {
      items.push({
        ...attention([], true),
        sourceId: crossingId(c),
        title: c.exit ? `CNN Fear & Greed index leaves extreme ${side}: ${Math.round(score)} (${rating})` : `CNN Fear & Greed index enters extreme ${side}: ${Math.round(score)}${prev !== null ? ` (previous close ${Math.round(prev)})` : ""}`,
        url: "https://www.cnn.com/markets/fear-and-greed",
        meta: { ...crossingMeta(c), index: Math.round(score * 10) / 10, rating, previous_close: prev === null ? null : Math.round(prev * 10) / 10, put_call_5d: typeof putCall === "number" ? Math.round(putCall * 1000) / 1000 : null },
      })
    }
  }
  return items
}

// ── StockTwits ──────────────────────────────────────────────────────────────

export const stocktwitsTrendingItems = (body: { symbols?: StSymbol[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] => stocktwitsTrendingItemsOf(body, watchedTargets(ctx), w, ctx)

// ── r/wallstreetbets: ApeWisdom and Tradestie ───────────────────────────────

export const apewisdomItems = (body: { results?: ApeResult[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] =>
  apewisdomItemsOf(body, watchedTargets(ctx), w, ctx, { rowTicker: (ticker) => ticker.toUpperCase(), url: (t) => `https://apewisdom.io/stocks/${encodeURIComponent(t.key)}/` })

type TradestieRow = { ticker: string; sentiment?: string; sentiment_score?: number; no_of_comments?: number }

const WSB_TOP = 10
const WSB_MIN_COMMENTS = 50

export const tradestieItems = (body: TradestieRow[], w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const rows = [...body].sort((a, b) => (num(b.no_of_comments) ?? 0) - (num(a.no_of_comments) ?? 0))
  const items: RawItem[] = []
  for (const symbol of watched(ctx)) {
    const i = rows.findIndex((r) => String(r.ticker).toUpperCase() === symbol)
    const r = i >= 0 ? rows[i] : null
    const comments = num(r?.no_of_comments) ?? 0
    const hot = i >= 0 && i < WSB_TOP && comments >= WSB_MIN_COMMENTS
    for (const c of w.observe(`tradestie:${symbol}`, hot ? 1 : 0, at, [ENTRY])) {
      const score = num(r?.sentiment_score)
      items.push({
        ...attention([symbol]),
        sourceId: crossingId(c),
        title: `${symbol} is among r/wallstreetbets' most discussed: #${i + 1} with ${comments} comments, ${r?.sentiment ?? "no"} sentiment${score !== null ? ` (${score.toFixed(2)})` : ""} (Tradestie)`,
        url: "https://tradestie.com/apps/reddit/api/",
        meta: { ...crossingMeta(c), rank: i + 1, comments, sentiment: r?.sentiment ?? null, sentiment_score: score },
      })
    }
  }
  return items
}

// ── App Store ───────────────────────────────────────────────────────────────

/** Retail brokers whose chart rank says how many new traders are arriving. */
export const BROKER_APPS: ChartApp[] = [
  { id: "938003185", name: "Robinhood", match: /^robinhood\b(?!\s*banking)/i, url: "https://apps.apple.com/us/app/robinhood-trading-investing/id938003185" },
  { id: "1179213067", name: "Webull", match: /^webull\b/i, url: "https://apps.apple.com/us/app/webull-investing-trading/id1179213067" },
]

export const appstoreItems = (chart: AppChart, body: AppleTop | AppleGenre, w: MetricWatcher, ctx: SourceContext): RawItem[] =>
  BROKER_APPS.flatMap((app) => {
    const { rank, crossings } = appChartCrossings(chart, body, app, w, ctx)
    return crossings.map((c) => ({ ...attention([], true), sourceId: crossingId(c), title: appChartTitle(app, chart, c, rank), url: app.url, meta: { ...crossingMeta(c), chart: chart.id, app: app.name, rank } }))
  })

// ── Wikipedia ───────────────────────────────────────────────────────────────

/** Below this many daily views a 3× day is a few clicks. */
const WIKI_MIN_MEDIAN = 100
const WIKI_MAX_COMPANIES = 40

type WikiSearch = { query?: { search?: { title: string }[] } }

/** The latest day's views over the median of the 28 days before it, with that day's time. */
export const pageviewRatio = (body: Pageviews) => pageviewRatioOf(body, WIKI_MIN_MEDIAN)

const key = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "")

/**
 * The search result that is the company's article: the first whose title starts with the whole
 * name ("Lockheed Martin", not "Lockheed Corporation"; "The Coca-Cola Company"), else with its
 * first word ("SoFi" for SoFi Technologies).
 */
export const companyArticle = (body: WikiSearch, name: string): string | null => {
  const results = body.query?.search ?? []
  const whole = key(name)
  const first = key(name.split(" ")[0] ?? "")
  const hit = (whole && results.find((r) => key(r.title).startsWith(whole))) || (first && results.find((r) => key(r.title).startsWith(first)))
  return hit ? hit.title.replace(/ /g, "_") : null
}

const wikipediaPoll = (ctx: SourceContext, w: MetricWatcher) => {
  /** ticker → article (null: none found; looked up again after a week). */
  const articles = new Map<string, { title: string | null; at: number }>()
  const article = async (symbol: string, name: string) => {
    const known = articles.get(symbol)
    if (known && ctx.now().getTime() - known.at < 7 * 86_400_000) return known.title
    const body = await ctx.fetch.json<WikiSearch>(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`${name} company`)}&srlimit=3&srnamespace=0&format=json`, { conditional: false })
    const title = body ? companyArticle(body, name) : null
    articles.set(symbol, { title, at: ctx.now().getTime() })
    return title
  }
  return async (): Promise<RawItem[]> => {
    const now = ctx.now()
    const dir = await companyDirectoryOrAliases(ctx)
    const companies = [...watched(ctx)].flatMap((symbol) => {
      const title = dir.names.get(symbol)
      return title ? [{ symbol, name: shortName(title) }] : []
    })
    const results = await settleAll(
      companies.slice(0, WIKI_MAX_COMPANIES).map(({ symbol, name }) => async () => {
        const title = await article(symbol, name)
        if (!title) return null
        const body = await ctx.fetch.json<Pageviews>(pageviewsUrl(title, now), { conditional: false })
        return { symbol, title, r: body ? pageviewRatio(body) : null }
      }),
    )
    return results.flatMap((x) => (x?.r ? pageviewItems({ key: x.symbol, symbol: x.symbol }, x.title, x.r, w, `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title)}`) : []))
  }
}

// ── Catalog entries ─────────────────────────────────────────────────────────

export const ATTENTION_SOURCES: SourceSpec[] = [
  {
    id: "fng",
    kind: "custom",
    url: "https://production.dataviz.cnn.io/index/fearandgreed/graphdata",
    interval_s: 1_800,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "CNN Fear & Greed (unofficial JSON; browser User-Agent): entering or leaving extreme fear or greed",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<CnnFng>(spec.url!, { headers: { ...BROWSER_HEADERS, accept: "application/json" } })
        return body === null ? null : cnnFngItems(body, w, ctx)
      }),
  },
  {
    id: "stocktwits",
    kind: "custom",
    url: `${STOCKTWITS_API}/trending/symbols.json`,
    // 20 requests an hour; the crypto bot uses ~60 of the ~200/hour this server's IP gets.
    interval_s: 180,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "StockTwits public API: held and watched stocks entering trending",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => stocktwitsTrendingItems((await ctx.fetch.json<{ symbols?: StSymbol[] }>(spec.url!, { conditional: false })) ?? {}, w, ctx), { maxPoints: 600 }),
  },
  {
    id: "wsb:apewisdom",
    kind: "custom",
    url: "https://apewisdom.io/api/v1.0/filter/all-stocks/page/1",
    interval_s: 900,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "ApeWisdom (keyless): Reddit/4chan mention jumps for held and watched stocks",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<{ results?: ApeResult[] }>(spec.url!)
        return body === null ? null : apewisdomItems(body, w, ctx)
      }),
  },
  {
    id: "wsb:tradestie",
    kind: "custom",
    url: "https://tradestie.com/api/v1/apps/reddit",
    interval_s: 900,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "Tradestie (keyless): r/wallstreetbets top 50 by comments, with sentiment",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<TradestieRow[]>(spec.url!)
        return body === null ? null : tradestieItems(Array.isArray(body) ? body : [], w, ctx)
      }),
  },
  {
    id: "appstore",
    kind: "custom",
    url: APP_CHARTS[0].url,
    interval_s: 3_600,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "Apple App Store charts (keyless): Robinhood's and Webull's ranks in the US top free apps and in Finance",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const results = await settleAll(APP_CHARTS.map((chart) => async () => appstoreItems(chart, (await ctx.fetch.json<AppleTop | AppleGenre>(chart.url, { conditional: false })) ?? {}, w, ctx)))
        return results.flatMap((r) => r ?? [])
      }),
  },
  {
    id: "wikipedia",
    kind: "custom",
    url: "https://wikimedia.org/api/rest_v1/metrics/pageviews",
    // Daily figures: four looks a day catch yesterday's soon after Wikimedia publishes it.
    interval_s: 21_600,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "Wikimedia pageviews API (keyless): daily views of held and watched companies' articles (found once by Wikipedia search)",
    create: (spec, ctx) => metricSource(spec, ctx, (w) => wikipediaPoll(ctx, w)),
  },
]
