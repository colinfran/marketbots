import { load } from "cheerio"
import { marketDay, marketTime } from "@mb/stock-core/time"
import { PollingSource } from "@mb/wire/poller"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { BROWSER_HEADERS, num, usd, watched } from "./common"

/**
 * Insider buying (MASTER_PLAN §4.2 wave 2, `insiders` and the insider half of `finviz`), from
 * Form 4 filings as two aggregators list them (HTML, browser User-Agent), tier 2:
 *
 *   insiders            openinsider.com "latest insider purchases $25K+", every 10 minutes
 *   finviz:insider      Finviz's insider page (buys and sales), every 10 minutes
 *
 * A purchase or sale becomes an item only for held and watched stocks. Two or more insiders
 * buying at one issuer within 5 days (openinsider, any issuer priced at $5+ with $100K+ bought
 * between them) is an `insider_cluster`: one item per cluster, also for stocks we don't follow,
 * as an idea for the next cycle. All of it is annotate only (§3.5): items carry `meta.insider`,
 * which the policy never acts on. Both sources title a purchase the same way, so one Form 4 seen
 * on both sites is one story.
 */

const CLUSTER_DAYS = 5
const CLUSTER_MIN_PRICE = 5
const CLUSTER_MIN_USD = 100_000
const FINVIZ_MIN_USD = 100_000

export type InsiderTrade = { ticker: string; company: string; insider: string; role: string; type: "buy" | "sale"; price: number | null; shares: number | null; value: number; tradeDate: string; filedAt: Date | null; url: string | null }

/** The sites word roles differently ("Pres, CEO" vs "President & CEO"): one coarse label, the most senior first. */
const ROLES: [RegExp, string][] = [
  [/\bCEO\b|chief executive/i, "CEO"],
  [/\bCFO\b|chief financial/i, "CFO"],
  [/\bpres(ident)?\b/i, "president"],
  [/\bCOB\b|chair(man)?\b/i, "chairman"],
  [/\bdir(ector)?\b/i, "director"],
  [/10%/, "10% owner"],
]

/** "Dir, 10%" → "director", "Co-Founder, CEO & Chairman" → "CEO", "See Remarks" → "insider". */
export const roleLabel = (s: string) => ROLES.find(([re]) => re.test(s))?.[1] ?? (/\b(officer|vp|evp|svp|chief|counsel|secretary|treasurer)\b/i.test(s) ? "officer" : "insider")

/** One title for a Form 4 trade, whichever site listed it. */
export const tradeTitle = (t: InsiderTrade) =>
  `${t.ticker}: ${t.role} ${t.insider} ${t.type === "buy" ? "buys" : "sells"} ${usd(t.value)} of stock${t.price !== null ? ` at $${t.price.toFixed(2)}` : ""} (Form 4, traded ${t.tradeDate})`

export const tradeItem = (t: InsiderTrade): RawItem => ({
  sourceId: `${t.ticker}:${t.insider}:${t.tradeDate}:${t.type}:${Math.round(t.value)}`,
  title: tradeTitle(t),
  url: t.url,
  publishedAt: t.filedAt,
  symbols: [t.ticker],
  category: t.type === "buy" ? "insider_buy" : "general",
  kind: "filing",
  tier: 2,
  // Most sales are planned (10b5-1) or for taxes: context, not a signal.
  polarity: t.type === "buy" ? 1 : 0,
  ...(t.type === "sale" ? { baseSeverity: 20 } : {}),
  meta: { insider: true, insider_name: t.insider, role: t.role, trade: t.type, value_usd: Math.round(t.value), price: t.price, shares: t.shares, trade_date: t.tradeDate },
})

// ── openinsider ─────────────────────────────────────────────────────────────

/** "2026-10-26 21:53:02" (New York time). */
const etDateTime = (s: string) => {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/.exec(s.trim())
  return m ? marketTime(m[1], m[2]) : null
}

/** The purchases table (filing date, trade date, ticker, company, insider, title, type, price, qty, owned, ΔOwn, value…). */
export const parseOpenInsider = (html: string): InsiderTrade[] => {
  const $ = load(html)
  const out: InsiderTrade[] = []
  $("table.tinytable tbody tr").each((_, tr) => {
    const td = $(tr).find("td")
    const cell = (i: number) => td.eq(i).text().replace(/\s+/g, " ").trim()
    const ticker = cell(3).toUpperCase()
    const value = num(cell(12))
    if (!/^[A-Z][A-Z.]{0,6}$/.test(ticker) || !/^P\b/.test(cell(7)) || value === null) return
    out.push({
      ticker,
      company: cell(4),
      insider: cell(5),
      role: roleLabel(cell(6)),
      type: "buy",
      price: num(cell(8)),
      shares: num(cell(9)),
      value: Math.abs(value),
      tradeDate: cell(2),
      filedAt: etDateTime(cell(1)),
      url: td.eq(1).find("a").attr("href") ?? null,
    })
  })
  return out
}

/** Trades seen in the last 5 days by issuer, and the clusters already reported. */
export class InsiderClusters {
  private readonly byTicker = new Map<string, Map<string, InsiderTrade>>()
  private readonly reported = new Map<string, number>()

  /** Adds trades; returns a cluster item for each issuer whose second (distinct) insider just appeared. */
  add(trades: InsiderTrade[], now: Date): RawItem[] {
    const cutoff = new Date(`${marketDay(now)}T12:00:00Z`)
    cutoff.setUTCDate(cutoff.getUTCDate() - CLUSTER_DAYS)
    const oldest = cutoff.toISOString().slice(0, 10)
    for (const t of trades) {
      if (t.type !== "buy" || t.tradeDate < oldest) continue
      const m = this.byTicker.get(t.ticker) ?? new Map<string, InsiderTrade>()
      m.set(`${t.insider}|${t.tradeDate}|${Math.round(t.value)}`, t)
      this.byTicker.set(t.ticker, m)
    }
    const items: RawItem[] = []
    for (const [ticker, m] of this.byTicker) {
      for (const [k, t] of m) if (t.tradeDate < oldest) m.delete(k)
      if (!m.size) {
        this.byTicker.delete(ticker)
        continue
      }
      const list = [...m.values()]
      const insiders = [...new Set(list.map((t) => t.insider))]
      const total = list.reduce((s, t) => s + t.value, 0)
      const price = list.map((t) => t.price ?? 0).reduce((a, b) => Math.max(a, b), 0)
      const last = this.reported.get(ticker)
      if (insiders.length < 2 || total < CLUSTER_MIN_USD || price < CLUSTER_MIN_PRICE || (last !== undefined && now.getTime() - last < CLUSTER_DAYS * 86_400_000)) continue
      this.reported.set(ticker, now.getTime())
      const first = list.map((t) => t.tradeDate).sort()[0]
      items.push({
        sourceId: `cluster:${ticker}:${first}`,
        title: `${ticker}: insider cluster buy, ${insiders.length} insiders bought ${usd(total)} of stock within ${CLUSTER_DAYS} days (${insiders.slice(0, 3).join(", ")}${insiders.length > 3 ? "…" : ""})`,
        url: `http://openinsider.com/${encodeURIComponent(ticker)}`,
        publishedAt: now,
        symbols: [ticker],
        category: "insider_buy",
        kind: "filing",
        tier: 2,
        polarity: 1,
        baseSeverity: 45,
        meta: { insider: true, cluster: true, insiders: insiders.length, value_usd: Math.round(total), first_trade: first, company: list[0].company || null },
      })
    }
    for (const [ticker, at] of this.reported) if (now.getTime() - at > CLUSTER_DAYS * 86_400_000) this.reported.delete(ticker)
    return items
  }
}

export const openInsiderItems = (trades: InsiderTrade[], clusters: InsiderClusters, ctx: SourceContext): RawItem[] => {
  const mine = watched(ctx)
  return [...trades.filter((t) => mine.has(t.ticker)).map(tradeItem), ...clusters.add(trades, ctx.now())]
}

// ── Finviz insider page ─────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "Oct 23 '26" → "2026-10-23". */
const finvizDay = (s: string) => {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) '(\d{2})$/.exec(s.trim())
  const month = m ? MONTHS.indexOf(m[1]) + 1 : 0
  return m && month ? `20${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}` : null
}

/** "Oct 26 09:57 PM" (New York time; the year is the trade's). */
const finvizFiled = (s: string, year: string) => {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}) (\d{1,2}):(\d{2}) (AM|PM)$/.exec(s.trim())
  const month = m ? MONTHS.indexOf(m[1]) + 1 : 0
  if (!m || !month) return null
  const h = (Number(m[3]) % 12) + (m[5] === "PM" ? 12 : 0)
  return marketTime(`${year}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`, `${String(h).padStart(2, "0")}:${m[4]}`)
}

/** Rows: ticker, owner, relationship, date, transaction, cost, #shares, value, #shares total, SEC Form 4. */
export const parseFinvizInsider = (html: string): InsiderTrade[] => {
  const $ = load(html)
  const out: InsiderTrade[] = []
  $("tr.fv-insider-row").each((_, tr) => {
    const td = $(tr).find("td")
    const cell = (i: number) => td.eq(i).text().replace(/\s+/g, " ").trim()
    const ticker = (td.eq(0).attr("data-boxover-ticker") ?? cell(0)).toUpperCase()
    const action = cell(4)
    const type = action === "Buy" ? "buy" : action === "Sale" ? "sale" : null
    const day = finvizDay(cell(3))
    const value = num(cell(7))
    if (!type || !day || value === null || !/^[A-Z][A-Z.]{0,6}$/.test(ticker)) return
    out.push({
      ticker,
      company: td.eq(0).attr("data-boxover-company") ?? "",
      insider: cell(1),
      role: roleLabel(cell(2)),
      type,
      price: num(cell(5)),
      shares: num(cell(6)),
      value: Math.abs(value),
      tradeDate: day,
      filedAt: finvizFiled(cell(9), day.slice(0, 4)),
      url: td.eq(9).find("a").attr("href") ?? null,
    })
  })
  return out
}

export const finvizInsiderItems = (trades: InsiderTrade[], ctx: SourceContext): RawItem[] => {
  const mine = watched(ctx)
  return trades.filter((t) => mine.has(t.ticker) && t.value >= FINVIZ_MIN_USD).map(tradeItem)
}

// ── Catalog entries ─────────────────────────────────────────────────────────

const HTML = { ...BROWSER_HEADERS, accept: "text/html" }

export const INSIDER_SOURCES: SourceSpec[] = [
  {
    id: "insiders",
    kind: "custom",
    url: "http://openinsider.com/latest-insider-purchases-25k",
    interval_s: 600,
    tier: 2,
    wire_kind: "filing",
    default_enabled: true,
    note: "openinsider.com latest purchases $25K+ (HTML; browser User-Agent): held and watched stocks' buys, and insider clusters for any issuer",
    create: (spec, ctx) => {
      const clusters = new InsiderClusters()
      return new PollingSource(spec, ctx, async () => {
        const res = await ctx.fetch.get(spec.url!, { headers: HTML })
        return res.notModified ? null : openInsiderItems(parseOpenInsider(res.text), clusters, ctx)
      })
    },
  },
  {
    id: "finviz:insider",
    kind: "custom",
    url: "https://finviz.com/insidertrading.ashx",
    interval_s: 600,
    tier: 2,
    wire_kind: "filing",
    default_enabled: true,
    note: "Finviz insider trading page (HTML; browser User-Agent): buys and sales of $100K+ in held and watched stocks",
    create: (spec, ctx) =>
      new PollingSource(spec, ctx, async () => {
        const res = await ctx.fetch.get(spec.url!, { headers: HTML })
        return res.notModified ? null : finvizInsiderItems(parseFinvizInsider(res.text), ctx)
      }),
  },
]
