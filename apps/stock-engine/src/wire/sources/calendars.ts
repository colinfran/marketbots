import { marketDay, marketTime } from "@mb/stock-core/time"
import { PollingSource } from "../poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { BROWSER_HEADERS, nextWeekdays, num, settleAll, usd, usDate, watched } from "./common"

/**
 * Scheduled company events from Nasdaq's calendars (MASTER_PLAN §4.2 wave 2, `calendars`;
 * unofficial JSON that answers browsers only), as calendar items for the dossier's "next 72 hours":
 *
 *   calendar:earnings   earnings dates of held and watched stocks, today and the next 3 weekdays
 *   calendar:dividends  their ex-dividend dates over the same days
 *   calendar:ipo        IPOs expected to price within 7 days that raise $1B or more (market-wide:
 *                       a mega IPO drains liquidity from its peers)
 *
 * Only held and watched symbols get earnings and dividend items, never the whole list (a busy day
 * has 300+ reports). Items appear once, a few days ahead, so they are fresh when the dossier looks.
 * Alpaca's corporate-actions feed (also in the plan's row) is not wired: splits and dividends of
 * what we hold are already reflected in the broker's positions.
 */

const NASDAQ = "https://api.nasdaq.com/api"
const HEADERS = { ...BROWSER_HEADERS, accept: "application/json" }
const DAYS_AHEAD = 4
const IPO_MIN_USD = 1e9

type Calendar<T> = { data?: { rows?: T[] | null; calendar?: { rows?: T[] | null } } | null }
type EarningsRow = { symbol: string; name?: string; time?: string; epsForecast?: string; noOfEsts?: string; fiscalQuarterEnding?: string }
type DividendRow = { symbol: string; companyName?: string; dividend_Ex_Date?: string; payment_Date?: string; dividend_Rate?: number | string }
type IpoRow = { proposedTickerSymbol?: string; companyName?: string; proposedExchange?: string; proposedSharePrice?: string; expectedPriceDate?: string; dollarValueOfSharesOffered?: string; dealID?: string }
type IpoBody = { data?: { upcoming?: { upcomingTable?: { rows?: IpoRow[] | null } } } | null }

const WHEN: Record<string, { label: string; at: string }> = {
  "time-pre-market": { label: "before the open", at: "07:00" },
  "time-after-hours": { label: "after the close", at: "16:05" },
}

export const earningsItems = (body: Calendar<EarningsRow>, day: string, symbols: ReadonlySet<string>): RawItem[] =>
  (body.data?.rows ?? []).flatMap((r): RawItem[] => {
    const symbol = r.symbol?.toUpperCase()
    if (!symbol || !symbols.has(symbol)) return []
    const when = WHEN[r.time ?? ""] ?? { label: "time not announced", at: "12:00" }
    const eps = r.epsForecast?.trim() ? `EPS forecast ${r.epsForecast.trim()}${r.noOfEsts ? ` from ${r.noOfEsts} estimates` : ""}` : null
    return [
      {
        sourceId: `earnings:${symbol}:${day}`,
        title: `Scheduled: ${symbol} reports earnings ${day} ${when.label}${r.fiscalQuarterEnding ? ` (quarter ending ${r.fiscalQuarterEnding})` : ""}${eps ? `, ${eps}` : ""}`,
        url: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/earnings`,
        publishedAt: null,
        symbols: [symbol],
        category: "earnings",
        kind: "calendar",
        tier: 2,
        polarity: 0,
        // Schedule information, not news: stored for the dossier, never loud.
        baseSeverity: 15,
        meta: { event_at: marketTime(day, when.at).toISOString(), eps_forecast: r.epsForecast?.trim() || null, estimates: num(r.noOfEsts), time: r.time ?? null },
      },
    ]
  })

export const dividendItems = (body: Calendar<DividendRow>, symbols: ReadonlySet<string>): RawItem[] =>
  (body.data?.calendar?.rows ?? []).flatMap((r): RawItem[] => {
    const symbol = r.symbol?.toUpperCase()
    const ex = usDate(r.dividend_Ex_Date)
    const rate = num(r.dividend_Rate)
    if (!symbol || !symbols.has(symbol) || !ex) return []
    const paid = usDate(r.payment_Date)
    const amount = rate !== null ? ` ($${Number(rate.toFixed(4))} a share${paid ? `, paid ${paid}` : ""})` : ""
    return [
      {
        sourceId: `dividend:${symbol}:${ex}`,
        title: `Scheduled: ${symbol} goes ex-dividend ${ex}${amount}`,
        url: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/dividend-history`,
        publishedAt: null,
        symbols: [symbol],
        category: "general",
        kind: "calendar",
        tier: 2,
        polarity: 0,
        baseSeverity: 10,
        meta: { event_at: marketTime(ex, "09:30").toISOString(), dividend: rate, payment_date: paid },
      },
    ]
  })

export const ipoItems = (body: IpoBody, now: Date): RawItem[] =>
  (body.data?.upcoming?.upcomingTable?.rows ?? []).flatMap((r): RawItem[] => {
    const day = usDate(r.expectedPriceDate)
    const amount = num(r.dollarValueOfSharesOffered)
    if (!day || amount === null || amount < IPO_MIN_USD) return []
    const at = marketTime(day, "09:30")
    if (at.getTime() < now.getTime() - 86_400_000 || at.getTime() > now.getTime() + 7 * 86_400_000) return []
    return [
      {
        sourceId: `ipo:${r.dealID ?? r.proposedTickerSymbol}:${day}`,
        title: `Scheduled: ${r.companyName ?? r.proposedTickerSymbol} IPO${r.proposedTickerSymbol ? ` (${r.proposedTickerSymbol}${r.proposedExchange ? `, ${r.proposedExchange}` : ""})` : ""} expected ${day}, raising ${usd(amount)}${r.proposedSharePrice ? ` at $${r.proposedSharePrice}` : ""}`,
        url: "https://www.nasdaq.com/market-activity/ipos",
        publishedAt: null,
        symbols: [],
        marketWide: true,
        category: "general",
        kind: "calendar",
        tier: 2,
        polarity: 0,
        baseSeverity: 20,
        meta: { event_at: at.toISOString(), offer_usd: amount, ticker: r.proposedTickerSymbol ?? null },
      },
    ]
  })

const earningsPoll = (ctx: SourceContext) => async (): Promise<RawItem[]> => {
  const symbols = watched(ctx)
  if (!symbols.size) return []
  const days = nextWeekdays(marketDay(ctx.now()), DAYS_AHEAD)
  const results = await settleAll(days.map((day) => async () => earningsItems((await ctx.fetch.json<Calendar<EarningsRow>>(`${NASDAQ}/calendar/earnings?date=${day}`, { headers: HEADERS, conditional: false })) ?? {}, day, symbols)))
  return results.flatMap((r) => r ?? [])
}

const dividendsPoll = (ctx: SourceContext) => async (): Promise<RawItem[]> => {
  const symbols = watched(ctx)
  if (!symbols.size) return []
  const days = nextWeekdays(marketDay(ctx.now()), DAYS_AHEAD)
  const results = await settleAll(days.map((day) => async () => dividendItems((await ctx.fetch.json<Calendar<DividendRow>>(`${NASDAQ}/calendar/dividends?date=${day}`, { headers: HEADERS, conditional: false })) ?? {}, symbols)))
  return results.flatMap((r) => r ?? [])
}

const ipoPoll = (ctx: SourceContext) => async (): Promise<RawItem[]> => {
  const now = ctx.now()
  // The next 7 days can reach into next month.
  const months = [...new Set([marketDay(now), marketDay(new Date(now.getTime() + 7 * 86_400_000))].map((d) => d.slice(0, 7)))]
  const results = await settleAll(months.map((m) => async () => ipoItems((await ctx.fetch.json<IpoBody>(`${NASDAQ}/ipo/calendar?date=${m}`, { headers: HEADERS, conditional: false })) ?? {}, now)))
  return results.flatMap((r) => r ?? [])
}

const calendarSpec = (id: string, path: string, note: string, poll: (ctx: SourceContext) => () => Promise<RawItem[]>): SourceSpec => ({
  id,
  kind: "custom",
  url: `${NASDAQ}/${path}`,
  // Daily data; four looks a day pick up late additions.
  interval_s: 21_600,
  tier: 2,
  wire_kind: "calendar",
  default_enabled: true,
  note,
  create: (spec, ctx) => new PollingSource(spec, ctx, poll(ctx)),
})

export const CALENDAR_SOURCES: SourceSpec[] = [
  calendarSpec("calendar:earnings", "calendar/earnings", "Nasdaq earnings calendar (unofficial JSON; browser User-Agent): held and watched stocks, the next 4 weekdays", earningsPoll),
  calendarSpec("calendar:dividends", "calendar/dividends", "Nasdaq dividend calendar: ex-dividend dates of held and watched stocks, the next 4 weekdays", dividendsPoll),
  calendarSpec("calendar:ipo", "ipo/calendar", "Nasdaq IPO calendar: deals of $1B or more expected within 7 days (market-wide)", ipoPoll),
]
