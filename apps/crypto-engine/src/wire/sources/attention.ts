import { crossingId, crossingMeta, metricSource, type MetricRule, type MetricWatcher } from "../metrics"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { num, settleAll, universeBases } from "./common"

/**
 * Retail attention (MASTER_PLAN §4.1 wave 2): all `sentiment_spike`, tier 3, low severity, and
 * annotate only (§3.5). Each source reports a change, never a level: a coin entering a trending
 * list, mentions or message rates jumping, an app climbing the charts, pageviews far above normal,
 * the Fear & Greed index entering or leaving an extreme.
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

const ENTRY_REARM_MS = 6 * 3_600_000
const ENTRY: MetricRule = { id: "entry", kind: "level", abs: 1, rearmMs: ENTRY_REARM_MS }

const attention = (symbols: string[], marketWide = false) => ({ symbols, marketWide, category: "sentiment_spike" as const, kind: "sentiment" as const, tier: 3 as const, polarity: 0 as const })

// ── ApeWisdom ───────────────────────────────────────────────────────────────

type ApeResult = { ticker: string; name: string; rank: number; mentions: number | string; mentions_24h_ago: number | string | null }

const APE_MIN_MENTIONS = 30
const APE_RATIO = 3

export const apewisdomItems = (body: { results?: ApeResult[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const universe = universeBases(ctx)
  const rows = new Map((body.results ?? []).map((r) => [String(r.ticker).replace(/\.X$/i, "").toUpperCase(), r]))
  const items: RawItem[] = []
  for (const [base, symbol] of universe) {
    const r = rows.get(base)
    const mentions = num(r?.mentions) ?? 0
    const before = num(r?.mentions_24h_ago)
    // Every coin is observed every poll (0 when quiet), so a jump can end and re-arm.
    const ratio = mentions >= APE_MIN_MENTIONS && before && before > 0 ? mentions / before : 0
    for (const c of w.observe(`apewisdom:${base}`, ratio, at, [{ id: "jump", kind: "level", abs: APE_RATIO }])) {
      items.push({
        ...attention([symbol]),
        sourceId: crossingId(c),
        title: `${symbol}: ${mentions} Reddit/4chan mentions in 24 h, ${c.value.toFixed(1)}× the day before (ApeWisdom)`,
        url: `https://apewisdom.io/cryptocurrencies/${base}/`,
        meta: { ...crossingMeta(c), mentions, mentions_24h_ago: before, rank: num(r?.rank) },
      })
    }
  }
  return items
}

// ── StockTwits ──────────────────────────────────────────────────────────────

type StSymbol = { symbol: string; title?: string }
type StMessage = { id: number; created_at: string }

/** The universe coins StockTwits streams are read for (more need the owner's approval, Phase 6.5). */
export const STOCKTWITS_STREAMS = ["BTC", "ETH"]
const ST_RATE_RULE: MetricRule = { id: "rate", kind: "spike", windowMin: 24 * 60, ratio: 4, minSamples: 30, min: 30 }

/** Messages per hour over the latest page of a symbol stream (30 messages), or null. */
export const messageRate = (messages: StMessage[]) => {
  const times = messages.map((m) => Date.parse(m.created_at)).filter(Number.isFinite)
  if (times.length < 5) return null
  const spanH = (Math.max(...times) - Math.min(...times)) / 3_600_000
  return spanH > 0 ? (times.length - 1) / spanH : null
}

export const stocktwitsTrendingItems = (body: { symbols?: StSymbol[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const list = (body.symbols ?? []).map((s) => s.symbol.toUpperCase())
  const items: RawItem[] = []
  for (const [base, symbol] of universeBases(ctx)) {
    const rank = list.indexOf(`${base}.X`) + 1
    for (const c of w.observe(`stocktwits:trending:${base}`, rank ? 1 : 0, at, [ENTRY])) {
      items.push({ ...attention([symbol]), sourceId: crossingId(c), title: `${symbol} enters StockTwits trending (#${rank} of ${list.length})`, url: `https://stocktwits.com/symbol/${base}.X`, meta: { ...crossingMeta(c), rank } })
    }
  }
  return items
}

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

type AppleTop = { feed?: { results?: { id: string; name: string }[] } }
type AppleGenre = { feed?: { entry?: { id?: { attributes?: { "im:id"?: string } }; "im:name"?: { label?: string } }[] } }

const COINBASE_APP_ID = "886427730"
const isCoinbase = (id: string | undefined, name: string | undefined) => id === COINBASE_APP_ID || /^coinbase\b(?!\s*wallet)/i.test(name ?? "")

/** Coinbase's rank in a chart (1 = top), or null when it isn't on it. */
export const coinbaseRank = (body: AppleTop | AppleGenre): number | null => {
  const top = (body as AppleTop).feed?.results
  if (top) {
    const i = top.findIndex((a) => isCoinbase(a.id, a.name))
    return i >= 0 ? i + 1 : null
  }
  const entries = (body as AppleGenre).feed?.entry ?? []
  const i = entries.findIndex((e) => isCoinbase(e.id?.attributes?.["im:id"], e["im:name"]?.label))
  return i >= 0 ? i + 1 : null
}

const CHARTS = [
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

export const appstoreItems = (chart: (typeof CHARTS)[number], body: AppleTop | AppleGenre, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const rank = coinbaseRank(body)
  const score = rank ? 101 - rank : 0
  const crossings = w.observe(`appstore:${chart.id}:coinbase`, score, ctx.now().getTime(), chart.rules)
  // Entering the chart is also a climb from nothing: one item, not two.
  const entered = crossings.some((c) => c.rule === "entry")
  return crossings.filter((c) => !entered || c.rule === "entry").map((c) => ({
    ...attention([], true),
    sourceId: crossingId(c),
    title: c.rule === "entry" ? `Coinbase app enters the US App Store ${chart.label} (#${rank})` : `Coinbase app up ${Math.round(c.delta!)} places in 24 h to #${rank} in the US App Store ${chart.label}`,
    url: "https://apps.apple.com/us/app/coinbase-buy-bitcoin-ether/id886427730",
    meta: { ...crossingMeta(c), chart: chart.id, rank },
  }))
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
const WIKI_RATIO = 3
/** Below this many daily views (Chainlink, Avalanche, Polkadot get under 40) a 3× day is a few clicks. */
const WIKI_MIN_MEDIAN = 50

type Pageviews = { items?: { timestamp: string; views: number }[] }

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

const wikipediaPoll = (ctx: SourceContext, w: MetricWatcher) => {
  const warned = new Set<string>()
  return async (): Promise<RawItem[]> => {
    const now = ctx.now()
    const start = ymd(new Date(now.getTime() - 35 * 86_400_000))
    const end = ymd(now)
    const coins = [...universeBases(ctx)].filter(([base]) => WIKIPEDIA_ARTICLES[base])
    const results = await settleAll(
      coins.map(([base, symbol]) => async () => {
        const article = WIKIPEDIA_ARTICLES[base]
        try {
          const body = await ctx.fetch.json<Pageviews>(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(article)}/daily/${start}/${end}`, { conditional: false })
          return { base, symbol, article, r: body ? pageviewRatio(body) : null }
        } catch (error) {
          // One renamed article shouldn't hide the rest; say so once.
          if (!warned.has(article)) ctx.log.warn("wikipedia pageviews failed for an article", { article, error: String(error).slice(0, 200) })
          warned.add(article)
          throw error
        }
      }),
    )
    const items: RawItem[] = []
    for (const x of results) {
      if (!x?.r) continue
      // The day's own time, so the next polls of the same day are ignored.
      for (const c of w.observe(`wikipedia:${x.base}`, x.r.ratio, x.r.at, [{ id: "spike", kind: "level", abs: WIKI_RATIO }])) {
        items.push({
          ...attention([x.symbol]),
          sourceId: crossingId(c),
          title: `${x.symbol}: Wikipedia "${x.article.replace(/_/g, " ")}" had ${x.r.views.toLocaleString("en-US")} views on ${new Date(x.r.at).toISOString().slice(0, 10)}, ${c.value.toFixed(1)}× its 4-week median`,
          url: `https://en.wikipedia.org/wiki/${x.article}`,
          meta: { ...crossingMeta(c), views: x.r.views, median: x.r.median },
        })
      }
    }
    return items
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

const STOCKTWITS_API = "https://api.stocktwits.com/api/2"

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
    url: CHARTS[0].url,
    interval_s: 3_600,
    tier: 3,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "Apple App Store charts (keyless): Coinbase's rank in the US top free apps and in Finance",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const results = await settleAll(CHARTS.map((chart) => async () => appstoreItems(chart, (await ctx.fetch.json<AppleTop | AppleGenre>(chart.url, { conditional: false })) ?? {}, w, ctx)))
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

