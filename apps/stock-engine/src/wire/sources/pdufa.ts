import { load } from "cheerio"
import { marketDay, marketTime } from "@mb/stock-core/time"
import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { dayStart, nextWeekdays, shortDay, tracked, usDate } from "./common"

/**
 * RTTNews FDA calendar (`pdufa`), tier 2, plain HTML: PDUFA and other FDA
 * decision dates with the outcome once known. Its terms say personal use, no redistribution
 * (owner-approved 2026-10-26), so only tracked tickers become items, as plain facts.
 *
 * The calendar is paged by date, ten rows a page, furthest future first; the default page is the
 * current one and its "Previous" link goes later in time. Each poll reads it and up to three
 * later pages. Two kinds of item:
 *   - a decision due within the next three weekdays, as a calendar item, one per day until it
 *     is due (the dossier lists calendar items first seen in its 24 h window), and
 *   - an outcome recorded in the last three days.
 */

const BASE = "https://www.rttnews.com/corpinfo/fdacalendar.aspx"
const LATER_PAGES = 3
const OUTCOME_DAYS = 3

export type FdaRow = { id: string; company: string; tickers: string[]; drug: string; due: string | null; event: string; outcome: string | null; outcomeDay: string | null }

const squash = (s: string) => s.replace(/\s+/g, " ").trim()

export const parseFdaCalendar = (html: string): { rows: FdaRow[]; laterPage: number | null } => {
  const $ = load(html)
  const rows = $(".grid-row")
    .toArray()
    .flatMap((el): FdaRow[] => {
      const row = $(el)
      const id = row.find("input[id$='hdnFDACalendarID']").attr("value")
      const companyText = squash(row.find(".tblcontent1").text())
      if (!id || !companyText) return []
      // "Pfizer Inc. ( PFE )", "Pharming Group N.V. (PHGUF.PK, PHGUF.OB, PHAR , PHARM.AS)": US tickers only.
      const inside = /\(([^()]*)\)\s*$/.exec(companyText)?.[1] ?? ""
      const tickers = inside
        .split(",")
        .map((t) => t.trim())
        .filter((t) => /^[A-Z]{1,5}$/.test(t))
      const eventCell = row.find(".tblcontent3")
      const when = squash(eventCell.find("span").first().text())
      const event = squash(eventCell.clone().find("span").remove().end().text())
      const outcomeText = squash(row.find(".tblcontent4 span").first().text())
      return [
        {
          id,
          company: squash(companyText.replace(/\([^()]*\)\s*$/, "")),
          tickers,
          drug: squash(row.find(".tblcontent2").text()),
          due: usDate(when),
          event,
          outcome: outcomeText && !/^pending\b/i.test(outcomeText) ? outcomeText.replace(/\s*-$/, "") : null,
          outcomeDay: usDate(row.find("input[id$='hdnOutcomeDate']").attr("value")),
        },
      ]
    })
  const later = $("a[aria-label='Previous']").attr("href")
  const n = Number(/PageNum=(\d+)/.exec(later ?? "")?.[1])
  return { rows, laterPage: Number.isFinite(n) && n > 0 ? n : null }
}

const POSITIVE = /\bapprov/i
const NEGATIVE = /complete response|\bcrl\b|reject|declin|refus|not approv/i

export const fdaCalendarItems = (rows: FdaRow[], ctx: Pick<SourceContext, "symbols" | "now">): RawItem[] => {
  const symbols = tracked(ctx)
  const now = ctx.now()
  const today = marketDay(now)
  const soon = new Set(nextWeekdays(today, 3))
  const recent = new Date(now.getTime() - OUTCOME_DAYS * 86_400_000).toISOString().slice(0, 10)
  const seen = new Set<string>()
  return rows.flatMap((r): RawItem[] => {
    const ticker = r.tickers.find((t) => symbols.has(t))
    if (!ticker || seen.has(r.id)) return []
    seen.add(r.id)
    const out: RawItem[] = []
    if (r.due && soon.has(r.due) && !r.outcome) {
      out.push({
        sourceId: `${r.id}|due|${today}`,
        title: `${ticker}: FDA decision due ${shortDay(r.due)} on ${r.drug} (${r.company})`,
        summary: r.event || null,
        url: `https://www.rttnews.com/corpinfo/FDADetail.aspx?ID=${r.id}`,
        publishedAt: now,
        symbols: [ticker],
        kind: "calendar",
        category: "fda",
        polarity: 0,
        baseSeverity: 30,
        // FDA decisions can land any time that day, including after the close.
        meta: { event_at: marketTime(r.due, "20:00").toISOString(), drug: r.drug, rtt_id: r.id },
      })
    }
    if (r.outcome && r.outcomeDay && r.outcomeDay >= recent) {
      out.push({
        sourceId: `${r.id}|outcome`,
        title: `${ticker}: ${r.outcome}`,
        summary: `${r.drug}: ${r.event}`,
        url: `https://www.rttnews.com/corpinfo/FDADetail.aspx?ID=${r.id}`,
        publishedAt: dayStart(r.outcomeDay),
        symbols: [ticker],
        category: "fda",
        polarity: NEGATIVE.test(r.outcome) ? -1 : POSITIVE.test(r.outcome) ? 1 : 0,
        baseSeverity: 45,
        meta: { drug: r.drug, outcome_on: r.outcomeDay, rtt_id: r.id },
      })
    }
    return out
  })
}

export const PDUFA_SOURCE: SourceSpec = {
  id: "pdufa:rttnews",
  kind: "custom",
  url: BASE,
  interval_s: 6 * 3_600,
  tier: 2,
  wire_kind: "calendar",
  default_enabled: true,
  note: "RTTNews FDA calendar (HTML): decisions due within 3 weekdays and recent outcomes, tracked tickers only",
  create: (spec, ctx) =>
    new PollingSource(spec, ctx, async () => {
      const first = parseFdaCalendar((await ctx.fetch.get(BASE, { headers: { accept: "text/html" }, conditional: false, timeoutMs: 30_000 })).text)
      const rows = [...first.rows]
      let next = first.laterPage
      for (let i = 0; i < LATER_PAGES && next; i++) {
        const page = parseFdaCalendar((await ctx.fetch.get(`${BASE}?PageNum=${next}`, { headers: { accept: "text/html" }, conditional: false, timeoutMs: 30_000 })).text)
        rows.push(...page.rows)
        next = page.laterPage
      }
      return fdaCalendarItems(rows, ctx)
    }),
}
