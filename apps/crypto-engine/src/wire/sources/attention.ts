import { crossingId, crossingMeta, metricSource, type MetricRule, type MetricWatcher } from "@mb/wire/metrics"
import {
  apewisdomItems as apewisdomItemsOf,
  APP_CHARTS,
  appChartCrossings,
  appChartTitle,
  appRank,
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
import { num, settleAll, universeBases } from "./common"

/**
 * Retail attention: all `sentiment_spike`, tier 3, low severity, and
 * annotate only. Each source reports a change, never a level: a coin entering a trending
 * list, mentions or message rates jumping, an app climbing the charts, pageviews far above normal,
 * the Fear & Greed index entering or leaving an extreme. The building blocks both bots use are in
 * @mb/wire/sources/attention.
 *
 *   apewisdom   Reddit/4chan mentions (24 h) ≥ 3× the day before, with at least 30 mentions
 *   stocktwits  a universe coin entering StockTwits trending; BTC.X/ETH.X message rate ≥ 4× its
 *               24-hour median
 *   coingecko   a universe coin entering CoinGecko's trending list (Demo key; 15 min ≈ 2,900
 *               calls a month)
 *   appstore    the Coinbase app entering the US top-100 free apps, or climbing ≥ 25 places
 *               there (≥ 15 in Finance, into its top 20) within 24 h
 *   wikipedia   yesterday's article views ≥ 3× the 4-week median (at least 50 views a day normally)
 *   fng         alternative.me Crypto Fear & Greed entering or leaving Extreme Fear/Greed
 *
 * A trending entry only counts again after the coin has been off the list and 6 hours have
 * passed, so a coin hovering at the edge of a list doesn't repeat.
 */

// ── ApeWisdom ───────────────────────────────────────────────────────────────

export const apewisdomItems = (body: { results?: ApeResult[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] =>
  apewisdomItemsOf(
    body,
    [...universeBases(ctx)].map(([base, symbol]) => ({ key: base, ticker: base, symbol })),
    w,
    ctx,
    // ApeWisdom lists coins as BTC or BTC.X.
    { rowTicker: (ticker) => ticker.replace(/\.X$/i, "").toUpperCase(), url: (t) => `https://apewisdom.io/cryptocurrencies/${t.key}/` },
  )

// ── StockTwits ──────────────────────────────────────────────────────────────

type StMessage = { id: number; created_at: string }

/** The universe coins StockTwits streams are read for (more need the owner's approval). */
export const STOCKTWITS_STREAMS = ["BTC", "ETH"]
const ST_RATE_RULE: MetricRule = { id: "rate", kind: "spike", windowMin: 24 * 60, ratio: 4, minSamples: 30, min: 30 }

/** Messages per hour over the latest page of a symbol stream (30 messages), or null. */
export const messageRate = (messages: StMessage[]) => {
  const times = messages.map((m) => Date.parse(m.created_at)).filter(Number.isFinite)
  if (times.length < 5) return null
  const spanH = (Math.max(...times) - Math.min(...times)) / 3_600_000
  return spanH > 0 ? (times.length - 1) / spanH : null
}

/** StockTwits lists a coin as BTC.X. */
export const stocktwitsTrendingItems = (body: { symbols?: StSymbol[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] =>
  stocktwitsTrendingItemsOf(
    body,
    [...universeBases(ctx)].map(([base, symbol]) => ({ key: base, ticker: `${base}.X`, symbol })),
    w,
    ctx,
  )

export const stocktwitsRateItems = (base: string, body: { messages?: StMessage[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const symbol = universeBases(ctx).get(base)
  const rate = messageRate(body.messages ?? [])
  if (!symbol || rate === null) return []
  return w.observe(`stocktwits:rate:${base}`, rate, ctx.now().getTime(), [ST_RATE_RULE]).map((c) => ({
    ...attention([symbol]),
    sourceId: crossingId(c),
    title: `${symbol}: StockTwits message rate ${Math.round(c.value)}/h, ${c.ratio!.toFixed(1)}× its 24-hour median`,
    url: `https://stocktwits.com/symbol/${base}.X`,
    meta: crossingMeta(c),
  }))
}

// ── CoinGecko ───────────────────────────────────────────────────────────────

type CgTrending = { coins?: { item: { id: string; symbol: string; name: string; score?: number } }[] }

/** CoinGecko ids of the universe assets (tickers repeat across coins on CoinGecko; ids don't). */
export const COINGECKO_IDS: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  ripple: "XRP",
  dogecoin: "DOGE",
  cardano: "ADA",
  chainlink: "LINK",
  "avalanche-2": "AVAX",
  litecoin: "LTC",
  polkadot: "DOT",
}

export const coingeckoItems = (body: CgTrending, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const coins = (body.coins ?? []).map((c) => c.item)
  const rankOf = new Map(coins.map((c, i) => [COINGECKO_IDS[c.id], i + 1] as const).filter(([b]) => b))
  const items: RawItem[] = []
  for (const [base, symbol] of universeBases(ctx)) {
    const rank = rankOf.get(base) ?? 0
    for (const c of w.observe(`coingecko:trending:${base}`, rank ? 1 : 0, at, [ENTRY])) {
      items.push({ ...attention([symbol]), sourceId: crossingId(c), title: `${symbol} is trending on CoinGecko (#${rank} of ${coins.length})`, url: "https://www.coingecko.com/en/highlights/trending-crypto", meta: { ...crossingMeta(c), rank } })
    }
  }
  return items
}

// ── App Store ───────────────────────────────────────────────────────────────

const COINBASE: ChartApp = { id: "886427730", name: "Coinbase", match: /^coinbase\b(?!\s*wallet)/i, url: "https://apps.apple.com/us/app/coinbase-buy-bitcoin-ether/id886427730" }

/** Coinbase's rank in a chart (1 = top), or null when it isn't on it. */
export const coinbaseRank = (body: AppleTop | AppleGenre): number | null => appRank(body, COINBASE)

export const appstoreItems = (chart: AppChart, body: AppleTop | AppleGenre, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const { rank, crossings } = appChartCrossings(chart, body, COINBASE, w, ctx)
  return crossings.map((c) => ({ ...attention([], true), sourceId: crossingId(c), title: appChartTitle(COINBASE, chart, c, rank), url: COINBASE.url, meta: { ...crossingMeta(c), chart: chart.id, rank } }))
}

// ── Wikipedia ───────────────────────────────────────────────────────────────

/** English Wikipedia articles for the universe assets. */
export const WIKIPEDIA_ARTICLES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana_(blockchain_platform)",
  XRP: "XRP_Ledger",
  DOGE: "Dogecoin",
  ADA: "Cardano_(blockchain_platform)",
  LINK: "Chainlink_(blockchain)",
  AVAX: "Avalanche_(blockchain_platform)",
  LTC: "Litecoin",
  DOT: "Polkadot_(blockchain_platform)",
}
/** Below this many daily views (Chainlink, Avalanche, Polkadot get under 40) a 3× day is a few clicks. */
const WIKI_MIN_MEDIAN = 50

/** The latest day's views over the median of the 28 days before it, with that day's time. */
export const pageviewRatio = (body: Pageviews) => pageviewRatioOf(body, WIKI_MIN_MEDIAN)

const wikipediaPoll = (ctx: SourceContext, w: MetricWatcher) => {
  const warned = new Set<string>()
  return async (): Promise<RawItem[]> => {
    const now = ctx.now()
    const coins = [...universeBases(ctx)].filter(([base]) => WIKIPEDIA_ARTICLES[base])
    const results = await settleAll(
      coins.map(([base, symbol]) => async () => {
        const article = WIKIPEDIA_ARTICLES[base]
        try {
          const body = await ctx.fetch.json<Pageviews>(pageviewsUrl(article, now), { conditional: false })
          return { base, symbol, article, r: body ? pageviewRatio(body) : null }
        } catch (error) {
          // One renamed article shouldn't hide the rest; say so once.
          if (!warned.has(article)) ctx.log.warn("wikipedia pageviews failed for an article", { article, error: String(error).slice(0, 200) })
          warned.add(article)
          throw error
        }
      }),
    )
    return results.flatMap((x) => (x?.r ? pageviewItems({ key: x.base, symbol: x.symbol }, x.article, x.r, w, `https://en.wikipedia.org/wiki/${x.article}`) : []))
  }
}

// ── Fear & Greed ────────────────────────────────────────────────────────────

type Fng = { data?: { value: string; value_classification: string; timestamp: string }[] }

/** Extreme Greed → 1, Extreme Fear → −1, anything else 0: crossing into or out of an extreme. */
export const fngItems = (body: Fng, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const d = body.data?.[0]
  const at = num(d?.timestamp)
  if (!d || at === null) return []
  const cls = d.value_classification
  const state = /extreme greed/i.test(cls) ? 1 : /extreme fear/i.test(cls) ? -1 : 0
  const rule: MetricRule = { id: "extreme", kind: "level", abs: 1, rearmAt: 1, rearmMs: 0, exits: true }
  return w.observe("fng", state, at * 1000, [rule]).map((c) => ({
    ...attention([], true),
    sourceId: crossingId(c),
    title: c.exit ? `Crypto Fear & Greed index leaves the extreme: ${d.value} (${cls})` : `Crypto Fear & Greed index enters ${cls}: ${d.value}`,
    url: "https://alternative.me/crypto/fear-and-greed-index/",
    meta: { ...crossingMeta(c), index: num(d.value), classification: cls },
  }))
}

// ── Catalog entries ─────────────────────────────────────────────────────────

export const ATTENTION_SOURCES: SourceSpec[] = [
  {
    id: "apewisdom",
    kind: "custom",
    url: "https://apewisdom.io/api/v1.0/filter/all-crypto/page/1",
    interval_s: 900,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "ApeWisdom (keyless): Reddit/4chan mention counts for crypto",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<{ results?: ApeResult[] }>(spec.url!)
        return body === null ? null : apewisdomItems(body, w, ctx)
      }),
  },
  {
    id: "stocktwits",
    kind: "custom",
    url: STOCKTWITS_API,
    // Three requests a poll: 60 an hour, well inside the ~200/hour IP limit both bots share.
    interval_s: 180,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "StockTwits public API: trending symbols, and the BTC.X/ETH.X message streams",
    create: (spec, ctx) =>
      metricSource(
        spec,
        ctx,
        (w) => async () => {
          const results = await settleAll([
            async () => stocktwitsTrendingItems((await ctx.fetch.json<{ symbols?: StSymbol[] }>(`${STOCKTWITS_API}/trending/symbols.json`, { conditional: false })) ?? {}, w, ctx),
            ...STOCKTWITS_STREAMS.map((base) => async () => stocktwitsRateItems(base, (await ctx.fetch.json<{ messages?: StMessage[] }>(`${STOCKTWITS_API}/streams/symbol/${base}.X.json`, { conditional: false })) ?? {}, w, ctx)),
          ])
          return results.flatMap((r) => r ?? [])
        },
        { maxPoints: 600 },
      ),
  },
  {
    id: "coingecko",
    kind: "custom",
    url: "https://api.coingecko.com/api/v3/search/trending",
    interval_s: 900,
    tier: 3,
    wire_kind: "sentiment",
    key_env: "COINGECKO_API_KEY",
    default_enabled: true,
    note: "CoinGecko Demo: trending coins every 15 min (≈ 2,900 calls a month)",
    headers: (env) => ({ "x-cg-demo-api-key": env.COINGECKO_API_KEY ?? "" }),
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<CgTrending>(spec.url!, { headers: spec.headers!(ctx.env) })
        return body === null ? null : coingeckoItems(body, w, ctx)
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
    note: "Apple App Store charts (keyless): Coinbase's rank in the US top free apps and in Finance",
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
    note: "Wikimedia pageviews API (keyless): daily views of each universe asset's article",
    create: (spec, ctx) => metricSource(spec, ctx, (w) => wikipediaPoll(ctx, w)),
  },
  {
    id: "fng",
    kind: "custom",
    url: "https://api.alternative.me/fng/?limit=1",
    interval_s: 3_600,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "alternative.me Crypto Fear & Greed (daily)",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<Fng>(spec.url!)
        return body === null ? null : fngItems(body, w, ctx)
      }),
  },
]
