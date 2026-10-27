import { MACRO_EVENTS } from "../calendar"
import { crossingId, crossingMeta, metricSource, type Crossing, type MetricWatcher } from "../metrics"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { num, settleAll } from "./common"

/**
 * Prediction-market odds (MASTER_PLAN §4.1 and §4.2, wave 2): a market's probability moving at
 * least `odds_swing_pts` points within an hour → `odds_swing`, market-wide (annotate;
 * `market_review` only at critical severity while something is held, §3.5).
 *
 *   odds:polymarket  Gamma API events under the bot's tags, filtered by its selection rule (an
 *                    event listed under two tags counts once).
 *   odds:kalshi      the bot's series: KXFED by the next two FOMC meetings' events, any other
 *                    series by its ticker; each with the open interest (contracts) a strike needs.
 *
 * Only liquid markets count (a thin book moves on one order), and one item per event and poll:
 * when "no change" drops 20 points, "+25 bps" rises about as much, and that is one story.
 * Severity grows with the swing: 40 at the threshold, critical (100 base) at 2.5× it.
 *
 * Each bot binds its tags, selection rule, Kalshi series and catalog notes (sources/odds.ts in its
 * engine).
 */

const PM_MIN_LIQUIDITY = 25_000
const PM_MIN_VOLUME_24H = 5_000
const KALSHI_MAX_SPREAD = 0.1

export const swingBase = (deltaPts: number, threshold: number) => Math.min(100, Math.round((40 * Math.abs(deltaPts)) / threshold))

export type Selected = { key: string; group: string; question: string; prob: number; url: string; venue: "Polymarket" | "Kalshi" }

const swingItem = (m: Selected, c: Crossing, threshold: number): RawItem<"odds_swing"> => ({
  sourceId: crossingId(c),
  title: `${m.venue} odds: ${m.question} ${Math.round(c.ref!)}% → ${Math.round(c.value)}% in ${c.windowMin} min`,
  url: m.url,
  // Fed, inflation and recession odds are about the whole market, never one ticker.
  symbols: [],
  marketWide: true,
  category: "odds_swing",
  kind: "sentiment",
  polarity: 0,
  baseSeverity: swingBase(c.delta!, threshold),
  meta: { ...crossingMeta(c), venue: m.venue.toLowerCase(), market: m.key, event: m.group, prob_pct: Math.round(c.value) },
})

/** Observes every selected market; returns the biggest swing per event. */
export const swingItems = (markets: Selected[], w: MetricWatcher, ctx: SourceContext): RawItem<"odds_swing">[] => {
  const at = ctx.now().getTime()
  const threshold = ctx.settings().odds_swing_pts
  const best = new Map<string, { m: Selected; c: Crossing }>()
  for (const m of markets) {
    for (const c of w.observe(m.key, m.prob, at, [{ id: "swing", kind: "change", windowMin: 60, points: threshold }])) {
      const prev = best.get(m.group)
      if (!prev || Math.abs(c.delta!) > Math.abs(prev.c.delta!)) best.set(m.group, { m, c })
    }
  }
  return [...best.values()].map(({ m, c }) => swingItem(m, c, threshold))
}

// ── Polymarket ──────────────────────────────────────────────────────────────

export type PmMarket = { id: string; question: string; outcomes?: string; outcomePrices?: string; liquidityNum?: number; volume24hr?: number; active?: boolean; closed?: boolean; endDate?: string }
export type PmEvent = { id: string; slug: string; title: string; markets?: PmMarket[] }

/** A Gamma tag the bot reads, and how many of its events (by 24-hour volume). */
export type PolymarketTag = { slug: string; limit: number }

const parseList = (s: string | undefined): string[] => {
  try {
    const v = JSON.parse(s ?? "[]") as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/** The "Yes" probability in %, or null. */
export const yesProbability = (m: Pick<PmMarket, "outcomes" | "outcomePrices">) => {
  const i = parseList(m.outcomes).findIndex((o) => o.toLowerCase() === "yes")
  const p = i >= 0 ? num(parseList(m.outcomePrices)[i]) : null
  return p === null ? null : p * 100
}

/** Liquid, open markets from Gamma events whose question the bot follows (an event listed under two tags counts once). */
export const polymarketMarkets = (events: PmEvent[], now: Date, selects: (question: string) => boolean): Selected[] => {
  const out = new Map<string, Selected>()
  for (const e of events) {
    for (const m of e.markets ?? []) {
      const q = m.question ?? ""
      const open = m.active !== false && !m.closed && (!m.endDate || Date.parse(m.endDate) > now.getTime())
      const liquid = (num(m.liquidityNum) ?? 0) >= PM_MIN_LIQUIDITY && (num(m.volume24hr) ?? 0) >= PM_MIN_VOLUME_24H
      const prob = yesProbability(m)
      if (!selects(q) || !open || !liquid || prob === null) continue
      out.set(m.id, { key: `polymarket:${m.id}`, group: `polymarket:${e.id}`, question: q, prob, url: `https://polymarket.com/event/${e.slug}`, venue: "Polymarket" })
    }
  }
  return [...out.values()]
}

const GAMMA = "https://gamma-api.polymarket.com/events?closed=false&order=volume24hr&ascending=false"

// ── Kalshi ──────────────────────────────────────────────────────────────────

export type KalshiMarket = { ticker: string; event_ticker: string; title: string; status?: string; yes_bid_dollars?: string; yes_ask_dollars?: string; last_price_dollars?: string; open_interest_fp?: string }

/** A Kalshi series the bot reads, and the open interest (contracts) a strike needs to count. */
export type KalshiSeries = { series: string; minOpenInterest: number }

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]

/** KXFED event tickers for the next `n` FOMC decisions, e.g. KXFED-26OCT. */
export const kalshiFedEvents = (now: Date, n = 2, events = MACRO_EVENTS) =>
  events
    .filter((e) => e.kind === "fomc" && e.at.getTime() > now.getTime())
    .slice(0, n)
    .map((e) => `KXFED-${String(e.at.getUTCFullYear()).slice(2)}${MONTHS[e.at.getUTCMonth()]}`)

/** The yes probability in %: the mid when the book is tight, else the last trade. */
export const kalshiProbability = (m: KalshiMarket) => {
  const bid = num(m.yes_bid_dollars)
  const ask = num(m.yes_ask_dollars)
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && ask - bid <= KALSHI_MAX_SPREAD) return ((bid + ask) / 2) * 100
  const last = num(m.last_price_dollars)
  return last !== null && last > 0 ? last * 100 : null
}

export const kalshiMarkets = (markets: KalshiMarket[], series: KalshiSeries): Selected[] =>
  markets.flatMap((m) => {
    const prob = kalshiProbability(m)
    if (prob === null || (num(m.open_interest_fp) ?? 0) < series.minOpenInterest || (m.status && m.status !== "active")) return []
    return [{ key: `kalshi:${m.ticker}`, group: `kalshi:${m.event_ticker}`, question: m.title, prob, url: `https://kalshi.com/markets/${series.series.toLowerCase()}`, venue: "Kalshi" as const }]
  })

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2/markets"

const kalshiUrls = (series: string, now: Date) =>
  series === "KXFED" ? kalshiFedEvents(now).map((e) => `${KALSHI}?event_ticker=${e}&status=open&limit=100`) : [`${KALSHI}?series_ticker=${series}&status=open&limit=200`]

// ── Catalog entries ─────────────────────────────────────────────────────────

export type OddsOptions = {
  polymarket: { tags: readonly PolymarketTag[]; selects: (question: string) => boolean; note: string }
  kalshi: { series: readonly KalshiSeries[]; note: string }
}

/** The bot's `odds:polymarket` and `odds:kalshi` catalog entries. */
export const oddsSources = (o: OddsOptions): SourceSpec<"odds_swing">[] => [
  {
    id: "odds:polymarket",
    kind: "custom",
    url: GAMMA,
    // A few hundred KB a poll (no ETags): every 5 minutes still sees a 15-point swing within the hour.
    interval_s: 300,
    tier: 2,
    wire_kind: "sentiment",
    default_enabled: true,
    note: o.polymarket.note,
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const now = ctx.now()
        const lists = await settleAll(o.polymarket.tags.map((t) => `${GAMMA}&limit=${t.limit}&tag_slug=${t.slug}`).map((url) => async () => (await ctx.fetch.json<PmEvent[]>(url, { conditional: false })) ?? []))
        return swingItems(polymarketMarkets(lists.flatMap((l) => l ?? []), now, o.polymarket.selects), w, ctx)
      }),
  },
  {
    id: "odds:kalshi",
    kind: "custom",
    url: KALSHI,
    interval_s: 120,
    tier: 2,
    wire_kind: "sentiment",
    default_enabled: true,
    note: o.kalshi.note,
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const now = ctx.now()
        const jobs = o.kalshi.series.flatMap((s) => kalshiUrls(s.series, now).map((url) => async () => kalshiMarkets((await ctx.fetch.json<{ markets?: KalshiMarket[] }>(url, { conditional: false }))?.markets ?? [], s)))
        const lists = await settleAll(jobs)
        return swingItems(lists.flatMap((l) => l ?? []), w, ctx)
      }),
  },
]
