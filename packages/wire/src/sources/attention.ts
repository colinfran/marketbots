import { crossingId, crossingMeta, type Crossing, type MetricRule, type MetricWatcher } from "../metrics"
import type { RawItem, SourceContext } from "../types"
import { num } from "./common"

/**
 * Retail-attention building blocks that both bots' attention
 * sources are made of: ApeWisdom mention jumps, StockTwits trending entries, App Store chart
 * ranks and Wikipedia pageview spikes. Every item is `sentiment_spike`, tier 3, low severity and
 * annotate only, and reports a change, never a level.
 *
 * What differs per bot is how it names its subjects on each site (a coin is "BTC.X" on StockTwits,
 * a stock its ticker), which apps it watches and its pageview floor; the bot passes those in.
 */

const ENTRY_REARM_MS = 6 * 3_600_000
/** A trending entry only counts again after the subject has been off the list and 6 hours have passed. */
export const ENTRY: MetricRule = { id: "entry", kind: "level", abs: 1, rearmMs: ENTRY_REARM_MS }

/** The fields every attention item has. */
export const attention = (symbols: string[], marketWide = false) => ({ symbols, marketWide, category: "sentiment_spike" as const, kind: "sentiment" as const, tier: 3 as const, polarity: 0 as const })

/** A subject a source is read for: `key` names it in the watcher's series, `ticker` is how the site lists it, `symbol` is what its items are tagged with. */
export type AttentionTarget = { key: string; ticker: string; symbol: string }

// ── ApeWisdom ───────────────────────────────────────────────────────────────

export type ApeResult = { ticker: string; name: string; rank: number; mentions: number | string; mentions_24h_ago: number | string | null }

const APE_MIN_MENTIONS = 30
const APE_RATIO = 3

/**
 * Reddit/4chan mentions (24 h) ≥ 3× the day before, with at least 30 mentions. `rowTicker` turns
 * a row's ticker into the form the targets' `ticker` uses.
 */
export const apewisdomItems = (
  body: { results?: ApeResult[] },
  targets: Iterable<AttentionTarget>,
  w: MetricWatcher,
  ctx: Pick<SourceContext, "now">,
  site: { rowTicker: (ticker: string) => string; url: (t: AttentionTarget) => string },
): RawItem<"sentiment_spike">[] => {
  const at = ctx.now().getTime()
  const rows = new Map((body.results ?? []).map((r) => [site.rowTicker(String(r.ticker)), r]))
  const items: RawItem<"sentiment_spike">[] = []
  for (const t of targets) {
    const r = rows.get(t.ticker)
    const mentions = num(r?.mentions) ?? 0
    const before = num(r?.mentions_24h_ago)
    // Every subject is observed every poll (0 when quiet), so a jump can end and re-arm.
    const ratio = mentions >= APE_MIN_MENTIONS && before && before > 0 ? mentions / before : 0
    for (const c of w.observe(`apewisdom:${t.key}`, ratio, at, [{ id: "jump", kind: "level", abs: APE_RATIO }])) {
      items.push({
        ...attention([t.symbol]),
        sourceId: crossingId(c),
        title: `${t.symbol}: ${mentions} Reddit/4chan mentions in 24 h, ${c.value.toFixed(1)}× the day before (ApeWisdom)`,
        url: site.url(t),
        meta: { ...crossingMeta(c), mentions, mentions_24h_ago: before, rank: num(r?.rank) },
      })
    }
  }
  return items
}

// ── StockTwits ──────────────────────────────────────────────────────────────

export type StSymbol = { symbol: string; title?: string }

export const STOCKTWITS_API = "https://api.stocktwits.com/api/2"

/** A target entering StockTwits trending (each one observed every poll, 0 when absent, so an entry can end and re-arm). */
export const stocktwitsTrendingItems = (body: { symbols?: StSymbol[] }, targets: Iterable<AttentionTarget>, w: MetricWatcher, ctx: Pick<SourceContext, "now">): RawItem<"sentiment_spike">[] => {
  const at = ctx.now().getTime()
  const list = (body.symbols ?? []).map((s) => s.symbol.toUpperCase())
  const items: RawItem<"sentiment_spike">[] = []
  for (const t of targets) {
    const rank = list.indexOf(t.ticker) + 1
    for (const c of w.observe(`stocktwits:trending:${t.key}`, rank ? 1 : 0, at, [ENTRY])) {
      items.push({ ...attention([t.symbol]), sourceId: crossingId(c), title: `${t.symbol} enters StockTwits trending (#${rank} of ${list.length})`, url: `https://stocktwits.com/symbol/${t.ticker}`, meta: { ...crossingMeta(c), rank } })
    }
  }
  return items
}

// ── App Store ───────────────────────────────────────────────────────────────

export type AppleTop = { feed?: { results?: { id: string; name: string }[] } }
export type AppleGenre = { feed?: { entry?: { id?: { attributes?: { "im:id"?: string } }; "im:name"?: { label?: string } }[] } }

/** An app whose chart rank says how many new traders are arriving. */
export type ChartApp = { id: string; name: string; match: RegExp; url: string }

/** An app's rank in a chart (1 = top), or null when it isn't on it. */
export const appRank = (body: AppleTop | AppleGenre, app: Pick<ChartApp, "id" | "match">): number | null => {
  const top = (body as AppleTop).feed?.results
  if (top) {
    const i = top.findIndex((a) => a.id === app.id || app.match.test(a.name ?? ""))
    return i >= 0 ? i + 1 : null
  }
  const entries = (body as AppleGenre).feed?.entry ?? []
  const i = entries.findIndex((e) => e.id?.attributes?.["im:id"] === app.id || app.match.test(e["im:name"]?.label ?? ""))
  return i >= 0 ? i + 1 : null
}

/** The US charts: entering the top 100 free apps or climbing ≥ 25 places there (≥ 15 in Finance, into its top 20) within 24 h. */
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
export type AppChart = (typeof APP_CHARTS)[number]

/** One app on one chart: its rank and what crossed. Entering the chart is also a climb from nothing: one crossing, not two. */
export const appChartCrossings = (chart: AppChart, body: AppleTop | AppleGenre, app: ChartApp, w: MetricWatcher, ctx: Pick<SourceContext, "now">) => {
  const rank = appRank(body, app)
  const crossings = w.observe(`appstore:${chart.id}:${app.name.toLowerCase()}`, rank ? 101 - rank : 0, ctx.now().getTime(), chart.rules)
  const entered = crossings.some((c) => c.rule === "entry")
  return { rank, crossings: crossings.filter((c) => !entered || c.rule === "entry") }
}

export const appChartTitle = (app: ChartApp, chart: AppChart, c: Crossing, rank: number | null) =>
  c.rule === "entry" ? `${app.name} app enters the US App Store ${chart.label} (#${rank})` : `${app.name} app up ${Math.round(c.delta!)} places in 24 h to #${rank} in the US App Store ${chart.label}`

// ── Wikipedia ───────────────────────────────────────────────────────────────

const WIKI_RATIO = 3

export type Pageviews = { items?: { timestamp: string; views: number }[] }
export type PageviewRatio = { at: number; views: number; median: number; ratio: number }

const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "")

/** The Wikimedia pageviews API for an article's daily views over the last 35 days. */
export const pageviewsUrl = (article: string, now: Date) =>
  `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article)}/daily/${ymd(new Date(now.getTime() - 35 * 86_400_000))}/${ymd(now)}`

/** The latest day's views over the median of the 28 days before it, with that day's time; null below `minMedian` views a day (a 3× day there is a few clicks). */
export const pageviewRatio = (body: Pageviews, minMedian: number): PageviewRatio | null => {
  const days = (body.items ?? []).map((i) => ({ at: Date.UTC(+i.timestamp.slice(0, 4), +i.timestamp.slice(4, 6) - 1, +i.timestamp.slice(6, 8)), views: num(i.views) ?? 0 }))
  if (days.length < 8) return null
  const last = days[days.length - 1]
  const prior = days.slice(-29, -1).map((d) => d.views).sort((a, b) => a - b)
  const median = prior.length % 2 ? prior[(prior.length - 1) / 2] : (prior[prior.length / 2 - 1] + prior[prior.length / 2]) / 2
  return median >= minMedian ? { at: last.at, views: last.views, median, ratio: last.views / median } : null
}

/** Yesterday's views ≥ 3× the 4-week median → an item. Observed at the day's own time, so the next polls of the same day are ignored. */
export const pageviewItems = (t: Pick<AttentionTarget, "key" | "symbol">, article: string, r: PageviewRatio, w: MetricWatcher, url: string): RawItem<"sentiment_spike">[] =>
  w.observe(`wikipedia:${t.key}`, r.ratio, r.at, [{ id: "spike", kind: "level", abs: WIKI_RATIO }]).map((c) => ({
    ...attention([t.symbol]),
    sourceId: crossingId(c),
    title: `${t.symbol}: Wikipedia "${article.replace(/_/g, " ")}" had ${r.views.toLocaleString("en-US")} views on ${new Date(r.at).toISOString().slice(0, 10)}, ${c.value.toFixed(1)}× its 4-week median`,
    url,
    meta: { ...crossingMeta(c), views: r.views, median: r.median },
  }))
