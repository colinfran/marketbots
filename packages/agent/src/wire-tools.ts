import type { WireItemDoc } from "@mb/core/wire"
import { cleanLine, fenceUntrusted } from "@mb/engine-kit/util/text"
import { upcomingMacro } from "@mb/wire/calendar"
import type { LocalResearch } from "@mb/wire/research/local"
import { buildDossier, renderLine, summaryLine } from "@mb/wire/dossier"
import type { Collection } from "mongodb"
import { z } from "zod"
import { describeDailyBars, pastNewsText } from "./history"
import { defineTool, type AgentTool } from "./tools"

/**
 * The tools both bots' agents have, over our own feeds and the history store (docs/plans/LOCAL-AI.md
 * §8.3): recent news, the dossier, one item in full, the macro calendar, daily history and past news
 * with the moves after it. Read-only; news comes back fenced as untrusted, and every URL a tool
 * shows is added to the episode's seen URLs. Each bot passes its own words ("pair", "stock"), time
 * format and symbol argument.
 */

/** What the history tools need from the bot's history store (@mb/history's HistoryStore); null while it is unset. */
export type AgentHistory = {
  dailyBars(symbol: string, days: number): Promise<{ day: string; high: number; low: number; close: number }[] | null>
  newsWithMoves(
    symbol: string,
    o: { days: number; minSeverity: number; limit: number },
  ): Promise<{ first_seen_at: Date; severity: number; category: string; source: string; title: string; url: string | null; ret_1h: number | null; ret_1d: number | null; ret_5d: number | null }[] | null>
}

export type WireToolsDeps<C extends string> = {
  col: { wireItems: Collection<WireItemDoc<C>> }
  price: (symbol: string) => number | null
  /** An item's time in news lines. */
  timeLabel: (d: Date) => string
  /** An item's time in the dossier. */
  dossierTime: (d: Date) => string
  thresholds: () => { annotate: number; review: number }
  history: AgentHistory | null
  /** The bot's word for what it trades, e.g. { one: "pair", many: "pairs" }. */
  noun: { one: string; many: string }
  symbolArg: z.ZodString
}

const HOUR = 3_600_000

type LineDeps = Pick<WireToolsDeps<string>, "price" | "timeLabel">

/** One item as the news tool shows it: its line, and the article's summary when there is one. */
const itemLine = <C extends string>(d: LineDeps, i: WireItemDoc<C>) => [renderLine(i, { price: d.price, timeLabel: d.timeLabel }), ...(i.article?.status === "ok" && i.article.summary ? [summaryLine(i)] : [])].join("\n")

/**
 * What our feeds saw about a symbol (or the market, null) in the last `hours`, most severe first: the
 * news tool's answer, and what a brief shows under each subject so the agent sees a move's catalyst
 * (or that there is none) without having to look. `lines` are untrusted text: fence them.
 */
export const recentNews = async <C extends string>(d: Pick<WireToolsDeps<C>, "col" | "price" | "timeLabel" | "thresholds">, symbol: string | null, { hours, limit }: { hours: number; limit: number }) => {
  const since = new Date(Date.now() - hours * HOUR)
  const items = await d.col.wireItems
    .find({ ...(symbol ? { symbols: symbol } : { symbols: { $size: 0 } }), first_seen_at: { $gte: since }, severity: { $gte: d.thresholds().annotate } })
    .sort({ severity: -1, first_seen_at: -1 })
    .limit(limit)
    .toArray()
  return { lines: items.map((i) => `${i._id.slice(0, 12)} ${itemLine(d, i as WireItemDoc<C>)}`), urls: items.map((i) => i.url).filter((u): u is string => !!u) }
}

/** Brief subjects show this many of their latest items, from this far back. */
export const BRIEF_NEWS = { hours: 24, limit: 3 }

/** A brief's news for one subject: its latest items, fenced, or a line saying our feeds have none (a big move with no news behind it is worth knowing about too). */
export const briefNews = async <C extends string>(d: Pick<WireToolsDeps<C>, "col" | "price" | "timeLabel" | "thresholds">, symbol: string) => {
  const news = await recentNews(d, symbol, BRIEF_NEWS)
  const text = news.lines.length ? `- news in our feeds, last ${BRIEF_NEWS.hours} h, most severe first:\n${fenceUntrusted("wire", news.lines.join("\n"))}` : `- news: nothing in our feeds about it in the last ${BRIEF_NEWS.hours} h`
  return { text, urls: news.urls }
}

/** news, dossier and item. */
export const wireTools = <C extends string>(d: WireToolsDeps<C>): AgentTool[] => {
  return [
    defineTool({
      name: "news",
      description: `what our feeds saw about a ${d.noun.one} (or the market, symbol null) in the last N hours, most severe first, with article summaries. Args: {symbol|null, hours 1-72}.`,
      args: z.object({ symbol: d.symbolArg.nullable(), hours: z.number().describe("1-72") }),
      run: async ({ symbol, hours }, tc) => {
        const news = await recentNews(d, symbol, { hours: Math.min(72, Math.max(1, hours)), limit: 10 })
        for (const u of news.urls) tc.urls.add(u)
        if (!news.lines.length) return `no items about ${symbol ?? "the market"} in the last ${hours} h`
        return fenceUntrusted("wire", news.lines.join("\n"))
      },
    }),
    defineTool({
      name: "dossier",
      description: `our feeds' dossier on up to 5 ${d.noun.many}: the top items of the last 72 h, market-wide items, scheduled releases, moves nothing explains and items nobody confirmed. Args: {symbols}.`,
      args: z.object({ symbols: z.array(d.symbolArg).describe(`1-5 ${d.noun.many}`) }),
      run: async ({ symbols }, tc) => {
        const dossier = await buildDossier(d.col, {
          symbols: symbols.slice(0, 5),
          since: new Date(Date.now() - 72 * HOUR),
          now: new Date(),
          price: d.price,
          timeLabel: d.dossierTime,
          reviewThreshold: d.thresholds().review,
        })
        for (const u of dossier.urls) tc.urls.add(u)
        return dossier.text || "nothing relevant in our feeds"
      },
    }),
    defineTool({
      name: "item",
      description: "one news item in full by the id the news tool shows (its first 12 characters are enough): title, source, confirmations, article summary and key points. Args: {id}.",
      args: z.object({ id: z.string().describe("The item id, or its first 12 characters.") }),
      run: async ({ id }, tc) => {
        const clean = id.trim().replace(/[^a-f0-9]/gi, "").slice(0, 64)
        if (clean.length < 8) return "give at least 8 characters of the id"
        const i = (await d.col.wireItems.findOne({ _id: { $regex: `^${clean}` } })) as WireItemDoc<C> | null
        if (!i) return `no item ${clean}`
        if (i.url) tc.urls.add(i.url)
        const confirmations = i.confirmations.map((c) => `${c.domain} ${d.timeLabel(c.at)}`).join(", ") || "none"
        const points = i.article?.key_points?.length ? `\nkey points: ${i.article.key_points.join("; ")}` : ""
        return fenceUntrusted("wire", `${itemLine(d, i)}\nsymbols ${i.symbols.join(", ") || "market-wide"} · confirmations: ${confirmations}${i.summary ? `\nsource summary: ${cleanLine(i.summary, 600)}` : ""}${points}`)
      },
    }),
  ]
}

/** The scheduled US macro releases ahead. */
export const calendarTool = (timeLabel: (d: Date) => string): AgentTool =>
  defineTool({
    name: "calendar",
    description: "scheduled US macro releases (FOMC, CPI, jobs, PPI, PCE, GDP) in the next N days. Args: {days 1-14}.",
    args: z.object({ days: z.number().describe("1-14") }),
    run: async ({ days }) => {
      const events = upcomingMacro(new Date(), Math.min(14, Math.max(1, days)) * 24)
      return events.length ? events.map((e) => `- ${timeLabel(e.at)} ${e.title}`).join("\n") : `no scheduled releases in the next ${days} days`
    },
  })

/** history and past_news, from the history store. `barsPerWeek`: 7 for crypto, 5 for stocks. */
export const historyTools = <C extends string>(d: Pick<WireToolsDeps<C>, "history" | "noun" | "symbolArg" | "thresholds">, barsPerWeek: number): AgentTool[] => [
  defineTool({
    name: "history",
    description: `a ${d.noun.one}'s daily history from our history store (years deep): return, range, volatility, worst drawdown, biggest days, weekly closes. Args: {symbol, days 7-1825}.`,
    args: z.object({ symbol: d.symbolArg, days: z.number().describe("7-1825") }),
    run: async ({ symbol, days }) => {
      const bars = await d.history?.dailyBars(symbol, Math.min(1_825, Math.max(7, days)))
      return bars ? describeDailyBars(symbol, bars, barsPerWeek) : "the history store is not available"
    },
  }),
  defineTool({
    name: "past_news",
    description: `earlier news about a ${d.noun.one} from our archive (beyond the last 30 days too), most severe first, with the price move 1 h, 1 d and 5 d after each. Args: {symbol, days 7-730}.`,
    args: z.object({ symbol: d.symbolArg, days: z.number().describe("7-730") }),
    run: async ({ symbol, days }, tc) => {
      const rows = await d.history?.newsWithMoves(symbol, { days: Math.min(730, Math.max(7, days)), minSeverity: d.thresholds().review, limit: 10 })
      if (!rows) return "the history store is not available"
      if (!rows.length) return `no archived items about ${symbol} at review severity in the last ${days} days`
      for (const r of rows) if (r.url) tc.urls.add(r.url)
      return pastNewsText(rows)
    },
  }),
]

/** The least time web research is worth starting with, and the most it is given. */
const RESEARCH_MIN_MS = 45_000
const RESEARCH_MAX_MS = 180_000

/**
 * research: web research on one question, for what our feeds don't cover. The model plans the
 * searches, the search service runs them on its free engines only (never the metered providers or
 * the paid proxy), the scraper reads the best articles, and the model writes a short memo citing
 * them; every step streams to the live model feed. Slow, so only reviews and background episodes
 * are offered it, and it fits itself into the episode's tool time.
 */
export const researchTool = (research: LocalResearch | null, model: () => string, now: () => number = Date.now): AgentTool =>
  defineTool({
    name: "research",
    description:
      "web research on one question our feeds don't answer: it searches the web, reads the best articles and returns a short memo citing them. Slow (1-3 min), so ask one focused question. Args: {question}.",
    args: z.object({ question: z.string().describe("One focused question, e.g. why SOL/USD fell 8% today.") }),
    minPriority: 2,
    resultChars: 6_000,
    run: async ({ question }, tc) => {
      if (!research) return "web research is unavailable here (no search service)"
      const q = cleanLine(question, 300)
      if (q.length < 8) return "ask a full question"
      const left = (tc.deadline ?? now() + RESEARCH_MAX_MS) - now() - 5_000
      if (left < RESEARCH_MIN_MS) return "not enough time left in this episode for web research: answer from what you have"
      const fromDate = new Date(now() - 7 * 86_400_000).toISOString().slice(0, 10)
      const r = await research({ model: model(), prompt: q, fromDate, timeoutMs: Math.min(left, RESEARCH_MAX_MS), signal: tc.signal, label: cleanLine(q, 80), freeOnly: true })
      if (r.error) return `the research failed: ${r.error}`
      for (const s of r.sources) tc.urls.add(s.url)
      const sources = r.sources.slice(0, 10).map((s) => `- ${cleanLine(s.title, 120)} (${s.domain}) ${s.url}`)
      return [fenceUntrusted("research memo", r.memo), sources.length ? `SOURCES\n${sources.join("\n")}` : "No sources could be read."].join("\n\n")
    },
  })
