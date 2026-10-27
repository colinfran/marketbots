import { crossingId, crossingMeta, metricSource, type MetricRule, type MetricWatcher } from "../metrics"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { companyDirectoryOrAliases, shortName } from "./companies"
import { BROWSER_HEADERS, num, settleAll, watched } from "./common"

/**
 * Retail attention and sentiment (MASTER_PLAN §4.2 wave 2): all `sentiment_spike`, tier 3, low
 * severity, annotate only (§3.5). Each source reports a change, never a level, and only for held
 * and watched symbols (market-wide for the fear gauge and the broker apps):
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

const ENTRY_REARM_MS = 6 * 3_600_000
const ENTRY: MetricRule = { id: "entry", kind: "level", abs: 1, rearmMs: ENTRY_REARM_MS }

const attention = (symbols: string[], marketWide = false) => ({ symbols, marketWide, category: "sentiment_spike" as const, kind: "sentiment" as const, tier: 3 as const, polarity: 0 as const })

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

type StSymbol = { symbol: string; title?: string }

export const stocktwitsTrendingItems = (body: { symbols?: StSymbol[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const list = (body.symbols ?? []).map((s) => s.symbol.toUpperCase())
  const items: RawItem[] = []
  // Every watched stock is observed every poll (0 when absent), so an entry can end and re-arm.
  for (const symbol of watched(ctx)) {
    const rank = list.indexOf(symbol) + 1
    for (const c of w.observe(`stocktwits:trending:${symbol}`, rank ? 1 : 0, at, [ENTRY])) {
      items.push({ ...attention([symbol]), sourceId: crossingId(c), title: `${symbol} enters StockTwits trending (#${rank} of ${list.length})`, url: `https://stocktwits.com/symbol/${symbol}`, meta: { ...crossingMeta(c), rank } })
    }
  }
  return items
}

// ── r/wallstreetbets: ApeWisdom and Tradestie ───────────────────────────────

type ApeResult = { ticker: string; name: string; rank: number; mentions: number | string; mentions_24h_ago: number | string | null }

const APE_MIN_MENTIONS = 30
const APE_RATIO = 3

export const apewisdomItems = (body: { results?: ApeResult[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const rows = new Map((body.results ?? []).map((r) => [String(r.ticker).toUpperCase(), r]))
  const items: RawItem[] = []
  for (const symbol of watched(ctx)) {
    const r = rows.get(symbol)
    const mentions = num(r?.mentions) ?? 0
    const before = num(r?.mentions_24h_ago)
    const ratio = mentions >= APE_MIN_MENTIONS && before && before > 0 ? mentions / before : 0
    for (const c of w.observe(`apewisdom:${symbol}`, ratio, at, [{ id: "jump", kind: "level", abs: APE_RATIO }])) {
      items.push({
        ...attention([symbol]),
        sourceId: crossingId(c),
        title: `${symbol}: ${mentions} Reddit/4chan mentions in 24 h, ${c.value.toFixed(1)}× the day before (ApeWisdom)`,
        url: `https://apewisdom.io/stocks/${encodeURIComponent(symbol)}/`,
        meta: { ...crossingMeta(c), mentions, mentions_24h_ago: before, rank: num(r?.rank) },
      })
    }
  }
  return items
}

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

type AppleTop = { feed?: { results?: { id: string; name: string }[] } }
type AppleGenre = { feed?: { entry?: { id?: { attributes?: { "im:id"?: string } }; "im:name"?: { label?: string } }[] } }

/** Retail brokers whose chart rank says how many new traders are arriving. */
export const BROKER_APPS = [
  { id: "938003185", name: "Robinhood", match: /^robinhood\b(?!\s*banking)/i, url: "https://apps.apple.com/us/app/robinhood-trading-investing/id938003185" },
  { id: "1179213067", name: "Webull", match: /^webull\b/i, url: "https://apps.apple.com/us/app/webull-investing-trading/id1179213067" },
]
type App = (typeof BROKER_APPS)[number]

/** An app's rank in a chart (1 = top), or null when it isn't on it. */
export const appRank = (body: AppleTop | AppleGenre, app: App): number | null => {
  const top = (body as AppleTop).feed?.results
  if (top) {
    const i = top.findIndex((a) => a.id === app.id || app.match.test(a.name ?? ""))
    return i >= 0 ? i + 1 : null
  }
  const entries = (body as AppleGenre).feed?.entry ?? []
  const i = entries.findIndex((e) => e.id?.attributes?.["im:id"] === app.id || app.match.test(e["im:name"]?.label ?? ""))
  return i >= 0 ? i + 1 : null
}

export const APP_CHARTS = [
  {
    id: "top",
    label: "top 100 free apps",
    url: "https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/100/apps.json",
    // Scored as places from the bottom (101 − rank, 0 when off the chart).
    rules: [{ id: "entry", kind: "level", abs: 1, rearmMs: 24 * 3_600_000 }, { id: "climb", kind: "change", windowMin: 24 * 60, points: 25, direction: "up" }] as MetricRule[],
  },
  {
    id: "finance",
    label: "Finance top 100",
    url: "https://itunes.apple.com/us/rss/topfreeapplications/limit=100/genre=6015/json",
    rules: [{ id: "climb", kind: "change", windowMin: 24 * 60, points: 15, direction: "up", min: 81 }] as MetricRule[],
  },
]
type Chart = (typeof APP_CHARTS)[number]

export const appstoreItems = (chart: Chart, body: AppleTop | AppleGenre, w: MetricWatcher, ctx: SourceContext): RawItem[] =>
  BROKER_APPS.flatMap((app) => {
    const rank = appRank(body, app)
    const crossings = w.observe(`appstore:${chart.id}:${app.name.toLowerCase()}`, rank ? 101 - rank : 0, ctx.now().getTime(), chart.rules)
    // Entering the chart is also a climb from nothing: one item, not two.
    const entered = crossings.some((c) => c.rule === "entry")
    return crossings
      .filter((c) => !entered || c.rule === "entry")
      .map((c) => ({
        ...attention([], true),
        sourceId: crossingId(c),
        title: c.rule === "entry" ? `${app.name} app enters the US App Store ${chart.label} (#${rank})` : `${app.name} app up ${Math.round(c.delta!)} places in 24 h to #${rank} in the US App Store ${chart.label}`,
        url: app.url,
        meta: { ...crossingMeta(c), chart: chart.id, app: app.name, rank },
      }))
  })

// ── Wikipedia ───────────────────────────────────────────────────────────────

const WIKI_RATIO = 3
/** Below this many daily views a 3× day is a few clicks. */
const WIKI_MIN_MEDIAN = 100
const WIKI_MAX_COMPANIES = 40

type Pageviews = { items?: { timestamp: string; views: number }[] }
type WikiSearch = { query?: { search?: { title: string }[] } }

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "")

/** The latest day's views over the median of the 28 days before it, with that day's time. */
export const pageviewRatio = (body: Pageviews): { at: number; views: number; median: number; ratio: number } | null => {
  const days = (body.items ?? []).map((i) => ({ at: Date.UTC(+i.timestamp.slice(0, 4), +i.timestamp.slice(4, 6) - 1, +i.timestamp.slice(6, 8)), views: num(i.views) ?? 0 }))
  if (days.length < 8) return null
  const last = days[days.length - 1]
  const prior = days.slice(-29, -1).map((d) => d.views).sort((a, b) => a - b)
  const median = prior.length % 2 ? prior[(prior.length - 1) / 2] : (prior[prior.length / 2 - 1] + prior[prior.length / 2]) / 2
  return median >= WIKI_MIN_MEDIAN ? { at: last.at, views: last.views, median, ratio: last.views / median } : null
}

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
    const start = ymd(new Date(now.getTime() - 35 * 86_400_000))
    const end = ymd(now)
    const companies = [...watched(ctx)].flatMap((symbol) => {
      const title = dir.names.get(symbol)
      return title ? [{ symbol, name: shortName(title) }] : []
    })
    const results = await settleAll(
      companies.slice(0, WIKI_MAX_COMPANIES).map(({ symbol, name }) => async () => {
        const title = await article(symbol, name)
        if (!title) return null
        const body = await ctx.fetch.json<Pageviews>(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title)}/daily/${start}/${end}`, { conditional: false })
        return { symbol, title, r: body ? pageviewRatio(body) : null }
      }),
    )
    const items: RawItem[] = []
    for (const x of results) {
      if (!x?.r) continue
      // The day's own time, so the next polls of the same day are ignored.
      for (const c of w.observe(`wikipedia:${x.symbol}`, x.r.ratio, x.r.at, [{ id: "spike", kind: "level", abs: WIKI_RATIO }])) {
        items.push({
          ...attention([x.symbol]),
          sourceId: crossingId(c),
          title: `${x.symbol}: Wikipedia "${x.title.replace(/_/g, " ")}" had ${x.r.views.toLocaleString("en-US")} views on ${new Date(x.r.at).toISOString().slice(0, 10)}, ${c.value.toFixed(1)}× its 4-week median`,
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(x.title)}`,
          meta: { ...crossingMeta(c), views: x.r.views, median: x.r.median },
        })
      }
    }
    return items
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
    url: "https://api.stocktwits.com/api/2/trending/symbols.json",
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
