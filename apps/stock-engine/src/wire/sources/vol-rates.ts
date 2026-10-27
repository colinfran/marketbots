import { XMLParser } from "fast-xml-parser"
import { marketDay } from "@mb/stock-core/time"
import { crossingId, crossingMeta, metricSource, type Crossing, type MetricRule, type MetricWatcher } from "@mb/wire/metrics"
import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { etNow, num, settleAll, signed } from "./common"

/**
 * Volatility and rates (`vol_rates` and `treasury`): tier 1, market-wide
 * readings that only go in the dossier (`market_shock` is SPY/QQQ's own move, and these
 * describe the market rather than explain a move).
 *
 *   vol_rates:vix     CBOE's delayed VIX quote, every minute. Risk-off when the VIX is up ≥ 20% on
 *                     the day, up ≥ 15% within an hour (from at least 12), or reaches 30. Each
 *                     fires once per excursion (@mb/wire/metrics), and one poll is one item.
 *   vol_rates:yields  Treasury's daily par yield curve (an ~18 s XML answer, polled every two
 *                     hours): the 2-year or 10-year moving ≥ 15 bp from the previous day.
 *   treasury          TreasuryDirect auction results for nominal notes and bonds (bills, TIPS and
 *                     FRNs are left out): weak when the bid-to-cover is ≥ 8% below the average of
 *                     the last six auctions of that term, or primary dealers were left with at
 *                     least 8 points more of it than usual. TreasuryDirect publishes no
 *                     when-issued yield, so the classic "tail" can't be computed from it.
 *
 * CBOE's daily put/call ratio has no simple endpoint; CNN's Fear & Greed payload carries the
 * 5-day put/call average, which the `fng` item keeps in its meta.
 */

// ── VIX ─────────────────────────────────────────────────────────────────────

type CboeQuote = { data?: { current_price?: number; prev_day_close?: number; price_change_percent?: number; last_trade_time?: string } }

const VIX_LEVEL = 30
/** On the VIX itself: reaching 30 (re-armed below 25), and a fast rise within the hour. */
const VIX_RULES: MetricRule[] = [
  { id: "level", kind: "level", abs: VIX_LEVEL, rearmAt: 25 / VIX_LEVEL },
  { id: "hour", kind: "change", windowMin: 60, pct: 15, direction: "up", min: 12 },
]
/** On the day's change in % (falls count as 0): a jump of 20%, re-armed below 10%. */
const DAY_RULE: MetricRule = { id: "day", kind: "level", abs: 20 }

export const vixItems = (body: CboeQuote, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const vix = num(body.data?.current_price)
  if (vix === null || vix <= 0) return []
  const prev = num(body.data?.prev_day_close)
  const dayPct = num(body.data?.price_change_percent) ?? (prev ? (vix / prev - 1) * 100 : 0)
  const at = ctx.now().getTime()
  const crossings: Crossing[] = [...w.observe("vix", vix, at, VIX_RULES), ...w.observe("vix:day_pct", Math.max(0, dayPct), at, [DAY_RULE])]
  if (!crossings.length) return []
  const hour = crossings.find((c) => c.rule === "hour")
  // The day's change is always in the title; the other rules say why it is news now.
  const reasons = [
    ...(hour ? [`up ${hour.pct!.toFixed(0)}% within the hour`] : []),
    ...(crossings.some((c) => c.rule === "level") ? [`at or above ${VIX_LEVEL}`] : []),
  ]
  const severe = vix >= VIX_LEVEL || dayPct >= 30
  return [
    {
      sourceId: crossingId(crossings[0]),
      title: `VIX at ${vix.toFixed(2)}, ${signed(dayPct)}% on the day${reasons.length ? `, ${reasons.join(", ")}` : ""}: risk-off (CBOE, delayed)`,
      url: "https://www.cboe.com/tradable_products/vix/",
      symbols: [],
      marketWide: true,
      category: "price_shock",
      kind: "derivatives",
      tier: 1,
      polarity: -1,
      baseSeverity: severe ? 60 : 50,
      meta: { ...crossingMeta(crossings[0]), rules: crossings.map((c) => c.rule).join(","), vix, day_change_pct: Math.round(dayPct * 100) / 100, prev_close: prev },
    },
  ]
}

// ── Treasury yield curve ────────────────────────────────────────────────────

const yieldParser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, isArray: (name) => name === "entry" })

export type YieldDay = { date: string; y2: number | null; y10: number | null }

/** The month's daily par yields, oldest first. */
export const parseYieldCurve = (xml: string): YieldDay[] => {
  const doc = yieldParser.parse(xml) as { feed?: { entry?: { content?: { properties?: Record<string, unknown> } }[] } }
  return (doc.feed?.entry ?? [])
    .map((e) => e.content?.properties ?? {})
    .map((p) => ({ date: String(p.NEW_DATE ?? "").slice(0, 10), y2: num(p.BC_2YEAR), y10: num(p.BC_10YEAR) }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .sort((a, b) => a.date.localeCompare(b.date))
}

const YIELD_MOVE_BP = 15
const YIELD_BIG_BP = 25

/** The latest day against the one before it: one item when the 2-year or 10-year moved ≥ 15 bp. */
export const yieldItems = (days: YieldDay[]): RawItem[] => {
  const [prev, last] = days.slice(-2)
  if (!prev || !last) return []
  const move = (a: number | null, b: number | null) => (a !== null && b !== null ? Math.round((b - a) * 1000) / 10 : null)
  const d2 = move(prev.y2, last.y2)
  const d10 = move(prev.y10, last.y10)
  const moved = [d2, d10].filter((d): d is number => d !== null && Math.abs(d) >= YIELD_MOVE_BP)
  if (!moved.length) return []
  const part = (label: string, d: number | null, y: number | null) => (d === null || y === null ? null : `${label} ${signed(d, 0)} bp to ${y.toFixed(2)}%`)
  const biggest = moved.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a))
  return [
    {
      sourceId: `yields:${last.date}`,
      title: `Treasury yields on ${last.date}: ${[part("2-year", d2, last.y2), part("10-year", d10, last.y10)].filter(Boolean).join(", ")}`,
      url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve",
      symbols: [],
      marketWide: true,
      category: "macro_release",
      kind: "macro",
      tier: 1,
      // Yields jumping is the risk-off case for stocks; a sharp fall is often a flight to safety.
      polarity: biggest > 0 ? -1 : 0,
      baseSeverity: Math.abs(biggest) >= YIELD_BIG_BP ? 55 : 45,
      meta: { metric: "treasury:yields", date: last.date, y2: last.y2, y10: last.y10, d2_bp: d2, d10_bp: d10, spread_2s10s_bp: last.y2 !== null && last.y10 !== null ? Math.round((last.y10 - last.y2) * 1000) / 10 : null },
    },
  ]
}

const yieldsUrl = (month: string) => `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${month}`
const monthOf = (d: Date) => marketDay(d).slice(0, 7).replace("-", "")
const prevMonthOf = (d: Date) => {
  const [y, m] = marketDay(d).split("-").map(Number)
  return m === 1 ? `${y - 1}12` : `${y}${String(m - 1).padStart(2, "0")}`
}
/** The XML endpoint takes ~18 s to answer (probed from the server). */
const YIELDS_TIMEOUT_MS = 60_000

const yieldsPoll = (ctx: SourceContext) => async (): Promise<RawItem[] | null> => {
  const now = ctx.now()
  const res = await ctx.fetch.get(yieldsUrl(monthOf(now)), { timeoutMs: YIELDS_TIMEOUT_MS })
  if (res.notModified) return null
  let days = parseYieldCurve(res.text)
  // Early in a month the previous day is in last month's file.
  if (days.length < 2) days = [...parseYieldCurve((await ctx.fetch.get(yieldsUrl(prevMonthOf(now)), { timeoutMs: YIELDS_TIMEOUT_MS, conditional: false })).text), ...days]
  return yieldItems(days)
}

// ── TreasuryDirect auctions ─────────────────────────────────────────────────

export type Auction = {
  cusip: string
  securityType: string
  securityTerm: string
  originalSecurityTerm?: string
  competitiveAuctionCloseDate?: string
  highYield?: string
  bidToCoverRatio?: string
  inflationProtected?: string
  floatingRate?: string
  primaryDealersCompetitiveParAwarded?: string
  directBiddersCompetitiveParAwarded?: string
  indirectBiddersCompetitiveParAwarded?: string
}

const TD = "https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json"
const BTC_DROP = 0.08
const DEALER_EXCESS_PTS = 8
const PRIOR_AUCTIONS = 6

const isCoupon = (a: Auction) => (a.securityType === "Note" || a.securityType === "Bond") && a.inflationProtected !== "Yes" && a.floatingRate !== "Yes"
const termOf = (a: Auction) => a.originalSecurityTerm || a.securityTerm
const dayOf = (a: Auction) => (a.competitiveAuctionCloseDate ?? "").slice(0, 10)

/** Bid-to-cover and the share of the competitive award left with primary dealers (%), or null for an auction without results yet. */
export const auctionStats = (a: Auction) => {
  const btc = num(a.bidToCoverRatio)
  const pd = num(a.primaryDealersCompetitiveParAwarded) ?? 0
  const total = pd + (num(a.directBiddersCompetitiveParAwarded) ?? 0) + (num(a.indirectBiddersCompetitiveParAwarded) ?? 0)
  return btc === null || !(total > 0) ? null : { btc, dealerPct: (pd / total) * 100, indirectPct: ((num(a.indirectBiddersCompetitiveParAwarded) ?? 0) / total) * 100 }
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** A coupon auction against the last six of its term: an item when it was weak, else null. */
export const weakAuctionItem = (a: Auction, history: Auction[]): RawItem | null => {
  const s = auctionStats(a)
  if (!isCoupon(a) || !s) return null
  const prior = history
    .filter((h) => isCoupon(h) && termOf(h) === termOf(a) && dayOf(h) < dayOf(a))
    .sort((x, y) => dayOf(y).localeCompare(dayOf(x)))
    .slice(0, PRIOR_AUCTIONS)
    .map(auctionStats)
    .filter((p): p is NonNullable<typeof p> => p !== null)
  if (prior.length < 3) return null
  const avgBtc = avg(prior.map((p) => p.btc))
  const avgDealer = avg(prior.map((p) => p.dealerPct))
  const lowCover = s.btc <= avgBtc * (1 - BTC_DROP)
  const dealerHeavy = s.dealerPct >= avgDealer + DEALER_EXCESS_PTS
  if (!lowCover && !dealerHeavy) return null
  const term = termOf(a)
  const hy = num(a.highYield)
  return {
    sourceId: `${a.cusip}:${dayOf(a)}`,
    title: `Weak ${term} Treasury ${a.securityType.toLowerCase()} auction: bid-to-cover ${s.btc.toFixed(2)} vs ${avgBtc.toFixed(2)} for the last ${prior.length}, dealers took ${s.dealerPct.toFixed(0)}% (usually ${avgDealer.toFixed(0)}%)${hy !== null ? `, high yield ${hy.toFixed(3)}%` : ""}`,
    url: "https://www.treasurydirect.gov/auctions/announcements-data-results/",
    publishedAt: null,
    symbols: [],
    marketWide: true,
    category: "macro_release",
    kind: "macro",
    tier: 1,
    polarity: -1,
    baseSeverity: lowCover && dealerHeavy ? 55 : 50,
    meta: {
      metric: `treasury:auction:${term}`,
      cusip: a.cusip,
      auction_date: dayOf(a),
      bid_to_cover: s.btc,
      avg_bid_to_cover: Math.round(avgBtc * 100) / 100,
      dealer_pct: Math.round(s.dealerPct * 10) / 10,
      avg_dealer_pct: Math.round(avgDealer * 10) / 10,
      indirect_pct: Math.round(s.indirectPct * 10) / 10,
      high_yield: hy,
    },
  }
}

/** Coupon results come out around 13:00 ET: every minute from 13:00 to 13:30 on weekdays, else every 30 minutes. */
const inAuctionWindow = (now: Date) => {
  const t = etNow(now)
  return t.weekday >= 1 && t.weekday <= 5 && t.minutes >= 13 * 60 && t.minutes <= 13 * 60 + 30
}

export const treasuryPoll = (ctx: SourceContext) => {
  let lastAt = -Infinity
  let history: { day: string; auctions: Auction[] } | null = null
  return async (): Promise<RawItem[]> => {
    const now = ctx.now()
    if (!inAuctionWindow(now) && now.getTime() - lastAt < 30 * 60_000) return []
    lastAt = now.getTime()
    const day = marketDay(now)
    if (history?.day !== day) {
      const [notes, bonds] = await settleAll(["Note", "Bond"].map((type) => async () => (await ctx.fetch.json<Auction[]>(`${TD}&type=${type}&days=200`, { conditional: false, timeoutMs: 30_000 })) ?? []))
      history = { day, auctions: [...(notes ?? []), ...(bonds ?? [])] }
    }
    const recent = (await ctx.fetch.json<Auction[]>(`${TD}&days=3`, { conditional: false })) ?? []
    const all = [...history.auctions, ...recent.filter((r) => !history!.auctions.some((h) => h.cusip === r.cusip && dayOf(h) === dayOf(r)))]
    return recent.flatMap((a) => {
      const item = weakAuctionItem(a, all)
      return item ? [item] : []
    })
  }
}

// ── Catalog entries ─────────────────────────────────────────────────────────

export const VOL_RATES_SOURCES: SourceSpec[] = [
  {
    id: "vol_rates:vix",
    kind: "custom",
    url: "https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json",
    interval_s: 60,
    tier: 1,
    wire_kind: "derivatives",
    default_enabled: true,
    note: "CBOE delayed VIX quote (keyless): up ≥ 20% on the day, ≥ 15% within an hour, or at 30",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<CboeQuote>(spec.url!)
        return body === null ? null : vixItems(body, w, ctx)
      }),
  },
  {
    id: "vol_rates:yields",
    kind: "custom",
    url: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve",
    // A daily figure from a slow endpoint (~18 s): every two hours is plenty.
    interval_s: 7_200,
    tier: 1,
    wire_kind: "macro",
    default_enabled: true,
    note: "Treasury daily par yield curve (XML, keyless, slow): the 2-year or 10-year moving ≥ 15 bp in a day",
    create: (spec, ctx) => new PollingSource(spec, ctx, yieldsPoll(ctx)),
  },
  {
    id: "treasury",
    kind: "custom",
    url: TD,
    interval_s: 60,
    tier: 1,
    wire_kind: "macro",
    default_enabled: true,
    note: "TreasuryDirect auction results (keyless): weak note and bond auctions; every minute 13:00-13:30 ET, else every 30 min",
    create: (spec, ctx) => new PollingSource(spec, ctx, treasuryPoll(ctx)),
  },
]
