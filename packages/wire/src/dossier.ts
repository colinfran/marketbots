import type { DossierRow, WireItemDoc } from "@mb/core/wire"
import { cleanLine, fenceUntrusted } from "@mb/engine-kit/util/text"
import type { Collection } from "mongodb"
import { upcomingMacro } from "./calendar"
import { isConfirmed } from "./notable"

/**
 * What our own feeds know about a cycle's subjects, ready for a prompt (MASTER_PLAN §3.8).
 *
 * Items for the subject symbols plus market-wide ones in the window, cluster roots only, ranked
 * by severity × recency (half-life 12 h) and capped: 8 per symbol, 10 market-wide, 10 calendar
 * entries for the next 72 h, 5 sentiment/odds lines. Each line carries the time we first saw it,
 * the tier and source, the category, the severity and, when we had a price then, the move since.
 *
 * Two lists drive gap-fill research: anomalies no item explains, and high-severity items that
 * aren't confirmed yet.
 *
 * The 8 highest-ranked items with a checked machine summary of their article (@mb/wire/enrich)
 * carry it on a line of its own, once each (MARKETBOTS_PLAN 10.5).
 */

const PER_SYMBOL = 8
const MARKET = 10
const CALENDAR = 10
const SENTIMENT = 5
const SUMMARIES = 8
const SUMMARY_CHARS = 600
const HALF_LIFE_H = 12
/** An anomaly counts as explained by any news on its symbol within this window. */
const EXPLAIN_MS = 2 * 3_600_000

export type DossierOptions = {
  symbols: string[]
  since: Date
  now: Date
  price: (symbol: string) => number | null
  /** Formats a time for the prompt ("14:03Z" for crypto, "10:03 ET" for stocks). */
  timeLabel: (d: Date) => string
  /** Severity at or above which an unconfirmed item asks for verification. */
  reviewThreshold: number
}

export type Dossier<C extends string> = {
  items: WireItemDoc<C>[]
  unexplained: WireItemDoc<C>[]
  unconfirmed: WireItemDoc<C>[]
  calendar: string[]
  /** Fenced prompt section, or "" when there's nothing. */
  text: string
  /** URLs the AI may cite as evidence. */
  urls: Set<string>
  /** URL → item id, for marking cited items. */
  idByUrl: Map<string, string>
  rows: DossierRow<C>[]
}

const score = (i: WireItemDoc<string>, now: Date) => i.severity * 0.5 ** ((now.getTime() - i.first_seen_at.getTime()) / 3_600_000 / HALF_LIFE_H)

const isSentiment = (i: WireItemDoc<string>) => i.kind === "sentiment" || i.category === "sentiment_spike" || i.category === "odds_swing"

export const toRow = <C extends string>(i: WireItemDoc<C>): DossierRow<C> => ({
  id: i._id,
  at: i.first_seen_at.toISOString(),
  source: i.source,
  tier: i.tier,
  category: i.category,
  title: i.title,
  url: i.url,
  severity: i.severity,
  symbols: i.symbols,
})

export const renderLine = (i: WireItemDoc<string>, o: Pick<DossierOptions, "price" | "timeLabel">) => {
  const symbol = i.symbols.length === 1 ? i.symbols[0] : null
  const then = symbol ? i.price_at_seen[symbol] : undefined
  const now = symbol ? o.price(symbol) : null
  const since = then && now ? ` | ${now >= then ? "+" : ""}${((now / then - 1) * 100).toFixed(1)}% since` : ""
  const confirmed = i.confirmations.length ? ` | +${i.confirmations.length} confirmations` : ""
  return `[${o.timeLabel(i.first_seen_at)} | T${i.tier} ${i.domain ?? i.source} | ${i.category.replace(/_/g, " ")} | sev ${i.severity}${confirmed}${since}] ${i.title}${i.url ? ` (${i.url})` : ""}`
}

const hasSummary = (i: WireItemDoc<string>) => i.article?.status === "ok" && !!i.article.summary

/** The line under an item that carries its article's machine summary (quoted: the fence collapses indentation). */
export const summaryLine = (i: WireItemDoc<string>) => `> machine summary of the article: ${cleanLine(i.article?.summary, SUMMARY_CHARS)}`

/** Picks and renders the dossier from items already loaded (pure; buildDossier loads them). */
export const assembleDossier = <C extends string>(all: WireItemDoc<C>[], o: DossierOptions): Dossier<C> => {
  const roots = all.filter((i) => i.cluster_id === i._id).sort((a, b) => score(b, o.now) - score(a, o.now))
  const subjects = new Set(o.symbols)
  const bySymbol = new Map<string, WireItemDoc<C>[]>()
  const market: WireItemDoc<C>[] = []
  const sentiment: WireItemDoc<C>[] = []
  const chosen = new Map<string, WireItemDoc<C>>()
  for (const i of roots) {
    if (i.kind === "calendar") continue
    if (isSentiment(i)) {
      if (sentiment.length < SENTIMENT) sentiment.push(i)
      continue
    }
    if (!i.symbols.length) {
      if (market.length < MARKET) {
        market.push(i)
        chosen.set(i._id, i)
      }
      continue
    }
    for (const s of i.symbols.filter((x) => subjects.has(x))) {
      const list = bySymbol.get(s) ?? []
      if (list.length >= PER_SYMBOL) continue
      list.push(i)
      bySymbol.set(s, list)
      chosen.set(i._id, i)
    }
  }
  for (const i of sentiment) chosen.set(i._id, i)

  // Anomalies on subjects that no news item explains (our own readings, `meta.metric`, explain
  // nothing), and loud items nobody has confirmed.
  const news = roots.filter((i) => i.kind !== "anomaly" && i.meta.metric === undefined)
  const unexplained = roots.filter(
    (i) =>
      i.kind === "anomaly" &&
      i.symbols.length > 0 &&
      i.symbols.some((s) => subjects.has(s)) &&
      !news.some((n) => n.symbols.some((s) => i.symbols.includes(s)) && Math.abs(n.first_seen_at.getTime() - i.first_seen_at.getTime()) <= EXPLAIN_MS),
  )
  const unconfirmed = [...chosen.values()].filter((i) => i.kind !== "anomaly" && i.severity >= o.reviewThreshold && !isConfirmed(i))

  const calendar = [
    ...upcomingMacro(o.now, 72).map((e) => `${o.timeLabel(e.at)} ${e.title} (${e.source})`),
    ...roots
      .filter((i) => i.kind === "calendar" && typeof i.meta.event_at === "string" && Date.parse(i.meta.event_at) >= o.now.getTime() && Date.parse(i.meta.event_at) <= o.now.getTime() + 72 * 3_600_000)
      .map((i) => `${o.timeLabel(new Date(String(i.meta.event_at)))} ${i.title.replace(/^Scheduled: /, "").replace(/ at \S+/, "")}`),
  ]
    .filter((v, idx, arr) => arr.indexOf(v) === idx)
    .slice(0, CALENDAR)

  // Roots are in rank order, so these are the best-ranked chosen items with a summary.
  const summarized = new Set(
    roots
      .filter((i) => chosen.has(i._id) && hasSummary(i))
      .slice(0, SUMMARIES)
      .map((i) => i._id),
  )
  const withSummary = (i: WireItemDoc<C>) => {
    const line = renderLine(i, o)
    if (!summarized.delete(i._id)) return line
    return `${line}\n${summaryLine(i)}`
  }

  const sections: string[] = []
  for (const s of o.symbols) {
    const list = bySymbol.get(s)
    if (list?.length) sections.push(`## ${s}\n${list.map(withSummary).join("\n")}`)
  }
  if (market.length) sections.push(`## Market-wide\n${market.map(withSummary).join("\n")}`)
  if (calendar.length) sections.push(`## Scheduled (next 72 h)\n${calendar.join("\n")}`)
  if (sentiment.length) sections.push(`## Sentiment and odds\n${sentiment.map(withSummary).join("\n")}`)
  if (unexplained.length) sections.push(`## Unexplained moves (no news found yet)\n${unexplained.map((i) => renderLine(i, o)).join("\n")}`)
  if (unconfirmed.length) sections.push(`## Unconfirmed high-severity items (one source so far)\n${unconfirmed.map((i) => renderLine(i, o)).join("\n")}`)

  const items = [...chosen.values()]
  const idByUrl = new Map<string, string>()
  for (const i of [...items, ...unexplained]) if (i.url) idByUrl.set(i.url, i._id)
  return {
    items,
    unexplained,
    unconfirmed,
    calendar,
    text: sections.length ? fenceUntrusted("wire", sections.join("\n\n")) : "",
    urls: new Set(idByUrl.keys()),
    idByUrl,
    rows: items.sort((a, b) => b.severity - a.severity).slice(0, 15).map(toRow),
  }
}

export const buildDossier = async <C extends string>(col: { wireItems: Collection<WireItemDoc<C>> }, o: DossierOptions): Promise<Dossier<C>> => {
  const items = await col.wireItems
    .find({ first_seen_at: { $gte: o.since }, $or: [{ symbols: { $in: o.symbols } }, { symbols: { $size: 0 } }] })
    .sort({ severity: -1, first_seen_at: -1 })
    .limit(600)
    .toArray()
  return assembleDossier(items, o)
}
