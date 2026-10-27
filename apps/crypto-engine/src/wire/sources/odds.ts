import { MACRO_EVENTS } from "@mb/wire/calendar"
import { crossingId, crossingMeta, metricSource, type Crossing, type MetricWatcher } from "@mb/wire/metrics"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { num, settleAll } from "./common"

/**
 * Prediction-market odds: a market's probability moving at least
 * `odds_swing_pts` points within an hour → `odds_swing` (annotate; `market_review` only at
 * critical severity while something is held).
 *
 *   odds:polymarket  Gamma API events tagged `fed-rates` and `crypto-legal`. Fed markets (not
 *                    Treasury yields), and crypto-policy markets (laws, regulators, ETFs,
 *                    reserves), never price bets. (The `crypto` tag is mostly price ladders and
 *                    weighs 2.3 MB per call; `crypto-legal` holds the policy events in ~170 KB.)
 *   odds:kalshi      KXFED (fed funds target after the next two FOMC meetings).
 *
 * Only liquid markets count (a thin book moves on one order), and one item per event and poll:
 * when "no change" drops 20 points, "+25 bps" rises about as much, and that is one story.
 * Severity grows with the swing: 40 at the threshold, critical (100 base) at 2.5× it.
 */

const PM_MIN_LIQUIDITY = 25_000
const PM_MIN_VOLUME_24H = 5_000
const KALSHI_MIN_OPEN_INTEREST = 10_000
const KALSHI_MAX_SPREAD = 0.1

const FED = /\b(fed|fomc|federal reserve|interest rates?|rate (cut|hike)s?|bps)\b/i
const NOT_FED = /\b(treasury|yields?)\b/i
const POLICY = /\b(etfs?|sec|cftc|reserve|bill|act|law|congress|senate|regulat\w*|bans?|approv\w*|stablecoins?|legislation|executive order|tax\w*|lawsuit|court|pardon\w*|clarity|genius|sanction\w*)\b/i
const PRICE = /\b(price|reach(es)?|hit|dip|above|below|close|high|low|ath|all[- ]time|up or down|strike|market cap|flips?|between)\b|\$\s?\d/i

export const swingBase = (deltaPts: number, threshold: number) => Math.min(100, Math.round((40 * Math.abs(deltaPts)) / threshold))

type Selected = { key: string; group: string; question: string; prob: number; url: string; fed: boolean; venue: "Polymarket" | "Kalshi" }

const swingItem = (m: Selected, c: Crossing, threshold: number): RawItem => ({
  sourceId: crossingId(c),
  title: `${m.venue} odds: ${m.question} ${Math.round(c.ref!)}% → ${Math.round(c.value)}% in ${c.windowMin} min`,
  url: m.url,
  // Fed markets are about everything; a crypto-policy market is tagged by the lexicon (an ETF on one coin), else market-wide.
  symbols: m.fed ? [] : undefined,
  marketWide: true,
  category: "odds_swing",
  kind: "sentiment",
  polarity: 0,
  baseSeverity: swingBase(c.delta!, threshold),
  meta: { ...crossingMeta(c), venue: m.venue.toLowerCase(), market: m.key, event: m.group, prob_pct: Math.round(c.value) },
})

/** Observes every selected market; returns the biggest swing per event. */
export const swingItems = (markets: Selected[], w: MetricWatcher, ctx: SourceContext): RawItem[] => {
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

type PmMarket = { id: string; question: string; outcomes?: string; outcomePrices?: string; liquidityNum?: number; volume24hr?: number; active?: boolean; closed?: boolean; endDate?: string }
type PmEvent = { id: string; slug: string; title: string; markets?: PmMarket[] }

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

/** Liquid, open Fed or crypto-policy markets from Gamma events. */
export const polymarketMarkets = (events: PmEvent[], kind: "fed" | "crypto", now: Date): Selected[] => {
  const out: Selected[] = []
  for (const e of events) {
    for (const m of e.markets ?? []) {
      const q = m.question ?? ""
      const relevant = kind === "fed" ? FED.test(q) && !NOT_FED.test(q) : POLICY.test(q) && !PRICE.test(q)
      const open = m.active !== false && !m.closed && (!m.endDate || Date.parse(m.endDate) > now.getTime())
      const liquid = (num(m.liquidityNum) ?? 0) >= PM_MIN_LIQUIDITY && (num(m.volume24hr) ?? 0) >= PM_MIN_VOLUME_24H
      const prob = yesProbability(m)
      if (!relevant || !open || !liquid || prob === null) continue
      out.push({ key: `polymarket:${m.id}`, group: `polymarket:${e.id}`, question: q, prob, url: `https://polymarket.com/event/${e.slug}`, fed: kind === "fed", venue: "Polymarket" })
    }
  }
  return out
}

const GAMMA = "https://gamma-api.polymarket.com/events?closed=false&order=volume24hr&ascending=false"

// ── Kalshi ──────────────────────────────────────────────────────────────────

type KalshiMarket = { ticker: string; event_ticker: string; title: string; status?: string; yes_bid_dollars?: string; yes_ask_dollars?: string; last_price_dollars?: string; open_interest_fp?: string }

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

export const kalshiMarkets = (markets: KalshiMarket[]): Selected[] =>
  markets.flatMap((m) => {
    const prob = kalshiProbability(m)
    if (prob === null || (num(m.open_interest_fp) ?? 0) < KALSHI_MIN_OPEN_INTEREST || (m.status && m.status !== "active")) return []
    return [{ key: `kalshi:${m.ticker}`, group: `kalshi:${m.event_ticker}`, question: m.title, prob, url: "https://kalshi.com/markets/kxfed", fed: true, venue: "Kalshi" as const }]
  })

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2/markets"

export const ODDS_SOURCES: SourceSpec[] = [
  {
    id: "odds:polymarket",
    kind: "custom",
    url: GAMMA,
    // ~570 KB a poll (no ETags): every 5 minutes still sees a 15-point swing within the hour.
    interval_s: 300,
    tier: 2,
    wire_kind: "sentiment",
    default_enabled: true,
    note: "Polymarket Gamma: Fed-rate and crypto-policy markets (no price bets), liquidity ≥ $25K and ≥ $5K traded in 24 h",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const now = ctx.now()
        const [fed, crypto] = await settleAll([
          async () => polymarketMarkets((await ctx.fetch.json<PmEvent[]>(`${GAMMA}&limit=10&tag_slug=fed-rates`, { conditional: false })) ?? [], "fed", now),
          async () => polymarketMarkets((await ctx.fetch.json<PmEvent[]>(`${GAMMA}&limit=20&tag_slug=crypto-legal`, { conditional: false })) ?? [], "crypto", now),
        ])
        return swingItems([...(fed ?? []), ...(crypto ?? [])], w, ctx)
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
    note: "Kalshi KXFED for the next two FOMC meetings (open interest ≥ 10K contracts, spread ≤ 10¢)",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const events = kalshiFedEvents(ctx.now())
        const lists = await settleAll(events.map((e) => async () => (await ctx.fetch.json<{ markets?: KalshiMarket[] }>(`${KALSHI}?event_ticker=${e}&status=open&limit=100`, { conditional: false }))?.markets ?? []))
        return swingItems(kalshiMarkets(lists.flatMap((l) => l ?? [])), w, ctx)
      }),
  },
]
