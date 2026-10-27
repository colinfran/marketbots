import { load } from "cheerio"
import { marketDay } from "@mb/stock-core/time"
import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { etNow, num, tracked } from "./common"

/**
 * MarketBeat (`ratings`), tier 2, plain HTML. Its robots.txt and llms.txt
 * invite crawling; its terms ask that data not be redistributed in bulk, so only the rows for
 * tracked symbols become items (owner-approved 2026-10-26).
 *
 *   ratings:marketbeat    today's analyst actions: upgrades, downgrades, initiations, target
 *                         changes, reiterations (~460 rows, no timestamps; new rows are new)
 *   earnings:marketbeat   today's reports: consensus vs actual EPS and revenue, once reported
 *
 * Both pages are large (2 MB and 0.8 MB), so they're read every 15 minutes on weekdays from 06:00
 * to 19:00 ET only, when analysts and companies publish. Rating rows carry no date, so a row's
 * identity is the action itself: yesterday's rows still on the page in the morning are
 * duplicates, never fresh news (an identical action repeated within the retention is lost).
 */

const OPEN_MIN = 6 * 60
const CLOSE_MIN = 19 * 60

const inHours = (now: Date) => {
  const et = etNow(now)
  return et.weekday >= 1 && et.weekday <= 5 && et.minutes >= OPEN_MIN && et.minutes < CLOSE_MIN
}

const clean = (v: string | undefined) => (v ?? "").split("|").map((s) => s.trim())
const price = (s: string | undefined) => {
  const n = num(s)
  return n && n > 0 ? n : null
}
const money = (n: number) => `$${n.toFixed(2)}`

// ── Analyst ratings ─────────────────────────────────────────────────────────

export type RatingRow = { ticker: string; company: string; action: string; broker: string; targetFrom: number | null; targetTo: number | null; ratingFrom: string | null; ratingTo: string | null }

export const parseRatings = (html: string): RatingRow[] => {
  const $ = load(html)
  return $("table")
    .first()
    .find("tbody tr")
    .toArray()
    .flatMap((tr): RatingRow[] => {
      const td = $(tr).find("td").toArray()
      if (td.length < 7) return []
      const [ticker, company] = clean($(td[0]).attr("data-clean"))
      const action = $(td[1]).text().replace(/\s+/g, " ").trim()
      const [broker] = clean($(td[2]).attr("data-clean"))
      const [targetFrom, targetTo] = clean($(td[5]).attr("data-clean"))
      const [ratingFrom, ratingTo] = clean($(td[6]).attr("data-clean"))
      if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker ?? "") || !action || !broker) return []
      const rating = (s: string | undefined) => (s && s !== "N/A" ? s : null)
      return [{ ticker, company: company ?? ticker, action, broker, targetFrom: price(targetFrom), targetTo: price(targetTo), ratingFrom: rating(ratingFrom), ratingTo: rating(ratingTo) }]
    })
}

const BULLISH = /^(strong[- ]buy|buy|outperform|overweight|market outperform|sector outperform|accumulate|positive|moderate buy|top pick)$/i
const BEARISH = /^(strong[- ]sell|sell|underperform|underweight|market underperform|sector underperform|reduce|negative|moderate sell)$/i
const stance = (rating: string | null): -1 | 0 | 1 => (!rating ? 0 : BULLISH.test(rating) ? 1 : BEARISH.test(rating) ? -1 : 0)

/** What an action means: its verb, direction and weight. Upgrades and downgrades weigh most. */
const describeRating = (r: RatingRow): { text: string; polarity: -1 | 0 | 1; base: number } => {
  const target = r.targetTo ? `, target ${r.targetFrom && r.targetFrom !== r.targetTo ? `${money(r.targetFrom)} to ` : ""}${money(r.targetTo)}` : ""
  const from = r.ratingFrom && r.ratingFrom !== r.ratingTo ? ` from ${r.ratingFrom}` : ""
  const a = r.action.toLowerCase()
  if (a.startsWith("upgraded")) return { text: `upgrades to ${r.ratingTo ?? "a higher rating"}${from}${target}`, polarity: 1, base: 45 }
  if (a.startsWith("downgraded")) return { text: `downgrades to ${r.ratingTo ?? "a lower rating"}${from}${target}`, polarity: -1, base: 45 }
  const change = (verb: string) => `${verb} ${r.targetTo ? `target to ${money(r.targetTo)}${r.targetFrom ? ` from ${money(r.targetFrom)}` : ""}` : "its target"}${r.ratingTo ? `, ${r.ratingTo}` : ""}`
  if (a.startsWith("target raised")) return { text: change("raises"), polarity: 1, base: 30 }
  if (a.startsWith("target lowered")) return { text: change("lowers"), polarity: -1, base: 30 }
  if (a.startsWith("initiated")) return { text: `initiates at ${r.ratingTo ?? "a rating"}${target}`, polarity: stance(r.ratingTo), base: 30 }
  const moved = r.targetFrom && r.targetTo && r.targetFrom !== r.targetTo ? (r.targetTo > r.targetFrom ? 1 : -1) : 0
  return { text: `${a.replace(/ by$/, "")} ${r.ratingTo ?? ""}${target}`.replace(/\s+/g, " ").trim(), polarity: moved, base: 20 }
}

export const ratingItems = (rows: RatingRow[], ctx: Pick<SourceContext, "symbols">): RawItem[] => {
  const symbols = tracked(ctx)
  return rows
    .filter((r) => symbols.has(r.ticker))
    .map((r) => {
      const d = describeRating(r)
      return {
        sourceId: `${r.ticker}|${r.action}|${r.broker}|${r.targetFrom ?? ""}>${r.targetTo ?? ""}|${r.ratingFrom ?? ""}>${r.ratingTo ?? ""}`,
        title: `${r.ticker}: ${r.broker} ${d.text}`,
        url: `https://www.marketbeat.com/stocks/${encodeURIComponent(r.ticker)}/forecast/`,
        symbols: [r.ticker],
        category: "analyst_action" as const,
        polarity: d.polarity,
        baseSeverity: d.base,
        meta: { broker: r.broker, action: r.action, rating_from: r.ratingFrom, rating_to: r.ratingTo, target_from: r.targetFrom, target_to: r.targetTo },
      }
    })
}

// ── Earnings ────────────────────────────────────────────────────────────────

export type EarningsRow = { ticker: string; company: string; time: string; epsEstimate: number | null; epsActual: number | null; revenueEstimate: string | null; revenueActual: string | null; url: string | null; day: string | null }

export const parseEarnings = (html: string): EarningsRow[] => {
  const $ = load(html)
  return $("table")
    .first()
    .find("tbody tr")
    .toArray()
    .flatMap((tr): EarningsRow[] => {
      const td = $(tr).find("td").toArray()
      if (td.length < 6) return []
      const [ticker, company] = clean($(td[0]).attr("data-clean"))
      if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker ?? "")) return []
      const cell = (i: number) => $(td[i]).text().replace(/\s+/g, " ").trim()
      const text = (i: number) => (cell(i) && cell(i) !== "N/A" ? cell(i) : null)
      const url = $(td[6]).attr("data-clean") || null
      return [
        {
          ticker,
          company: company ?? ticker,
          time: cell(1),
          epsEstimate: num(text(2)),
          epsActual: num(text(3)),
          revenueEstimate: text(4),
          revenueActual: text(5),
          url,
          day: /\/(\d{4}-\d{2}-\d{2})-/.exec(url ?? "")?.[1] ?? null,
        },
      ]
    })
}

/** A surprise within ±2% of the estimate is in line. */
const IN_LINE = 0.02

export const earningsItems = (rows: EarningsRow[], ctx: Pick<SourceContext, "symbols" | "now">): RawItem[] => {
  const symbols = tracked(ctx)
  const today = marketDay(ctx.now())
  return rows
    .filter((r) => r.epsActual !== null && symbols.has(r.ticker))
    .map((r) => {
      const surprise = r.epsEstimate !== null && r.epsEstimate !== 0 ? (r.epsActual! - r.epsEstimate) / Math.abs(r.epsEstimate) : null
      const verdict = surprise === null ? null : surprise >= IN_LINE ? "beat" : surprise <= -IN_LINE ? "miss" : "in line"
      const vs = r.epsEstimate !== null ? ` vs ${money(r.epsEstimate)} expected (${verdict}${verdict !== "in line" && surprise !== null ? ` by ${Math.abs(surprise * 100).toFixed(1)}%` : ""})` : ""
      const revenue = r.revenueActual ? `; revenue ${r.revenueActual}${r.revenueEstimate ? ` vs ${r.revenueEstimate} expected` : ""}` : ""
      return {
        sourceId: `${r.day ?? today}|${r.ticker}|eps`,
        title: `${r.ticker}: ${r.company} reports EPS ${money(r.epsActual!)}${vs}${revenue}`,
        url: r.url ?? "https://www.marketbeat.com/earnings/latest/",
        symbols: [r.ticker],
        category: "earnings" as const,
        polarity: verdict === "beat" ? (1 as const) : verdict === "miss" ? (-1 as const) : (0 as const),
        // A clear beat or miss keeps the earnings base; an in-line report matters less.
        ...(verdict === "in line" || verdict === null ? { baseSeverity: 40 } : {}),
        meta: { eps_estimate: r.epsEstimate, eps_actual: r.epsActual, eps_surprise_pct: surprise === null ? null : Math.round(surprise * 1000) / 10, revenue_estimate: r.revenueEstimate, revenue_actual: r.revenueActual, release_time: r.time || null },
      }
    })
}

const page = (id: string, url: string, note: string, parse: (html: string, ctx: SourceContext) => RawItem[]): SourceSpec => ({
  id,
  kind: "custom",
  url,
  interval_s: 900,
  tier: 2,
  wire_kind: "news",
  default_enabled: true,
  note,
  create: (spec, ctx) =>
    new PollingSource(spec, ctx, async () => {
      if (!inHours(ctx.now())) return null
      const res = await ctx.fetch.get(spec.url!, { headers: { accept: "text/html" }, timeoutMs: 30_000 })
      return res.notModified ? null : parse(res.text, ctx)
    }),
})

export const MARKETBEAT_SOURCES: SourceSpec[] = [
  page("ratings:marketbeat", "https://www.marketbeat.com/ratings/", "MarketBeat analyst ratings (HTML, weekdays 06:00–19:00 ET): actions on tracked stocks", (html, ctx) => ratingItems(parseRatings(html), ctx)),
  page("earnings:marketbeat", "https://www.marketbeat.com/earnings/latest/", "MarketBeat latest earnings (HTML, weekdays 06:00–19:00 ET): reported EPS and revenue vs estimates for tracked stocks", (html, ctx) => earningsItems(parseEarnings(html), ctx)),
]
