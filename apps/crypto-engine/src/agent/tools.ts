import { describeDailyBars, pastNewsText } from "@mb/agent/history"
import { defineTool, type AgentTool } from "@mb/agent/tools"
import { roundTo } from "@mb/crypto-core/math"
import type { WireItemDoc } from "@mb/crypto-core/wire"
import { cleanLine, fenceUntrusted } from "@mb/engine-kit/util/text"
import { upcomingMacro } from "@mb/wire/calendar"
import { renderLine, summaryLine } from "@mb/wire/dossier"
import { z } from "zod"
import { featuresForPrompt } from "../market/features"
import { loadFeatures } from "../orchestrator/crypto-cycle"
import { walkBook } from "../risk/sizing"
import { buildDossier } from "../wire/dossier"
import { bookText, type CryptoAgentDeps } from "./book"

/**
 * The crypto agent's tools (docs/plans/LOCAL-AI.md §8.3), all read-only. News comes back fenced as
 * untrusted, and every URL a tool shows is added to the episode's seen URLs (evidence may cite only
 * those). The history tools answer from the history store, years deep, or say it isn't available.
 */

const HOUR = 3_600_000
const utcTime = (d: Date) => `${d.toISOString().slice(5, 16).replace("T", " ")}Z`
const symbolArg = z.string().describe("A pair exactly as listed, e.g. SOL/USD.")

const known = (d: CryptoAgentDeps, symbol: string) => d.ctx.hub.universe.includes(symbol) || d.ctx.hub.pairs.has(symbol)

export const cryptoAgentTools = (d: CryptoAgentDeps): AgentTool[] => {
  const { ctx } = d
  const price = (s: string) => ctx.hub.quote(s)?.mid ?? null
  const itemLine = (i: WireItemDoc) => [renderLine(i, { price, timeLabel: utcTime }), ...(i.article?.status === "ok" && i.article.summary ? [summaryLine(i)] : [])].join("\n")

  return [
    defineTool({
      name: "book",
      description: "your shadow book again (positions, cash, P&L) and the limits code enforces right now. Args: {}.",
      args: z.object({}),
      run: async () => bookText(d),
    }),
    defineTool({
      name: "quote",
      description: "the live bid, ask, spread, 24 h change and data age of a pair. Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }) => {
        const q = ctx.hub.quote(symbol)
        if (!q) return `${symbol}: no live quote`
        return `${symbol}: bid ${q.bid}, ask ${q.ask}, mid ${q.mid}, spread ${q.spreadBps.toFixed(1)} bps, 24 h ${q.changePct === null ? "n/a" : `${q.changePct.toFixed(2)}%`}, ${q.ageS.toFixed(1)} s old (${q.source}).`
      },
    }),
    defineTool({
      name: "features",
      description: "the indicators the screens use for a pair: returns over 1 h-30 d, EMAs and trends on 1 h/4 h/1 d, RSI, ATR, Bollinger position, 20×4 h range, volatility, volume ratio. Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }) => {
        if (!known(d, symbol)) return `${symbol} is not a known pair`
        const { features, failures } = await loadFeatures(ctx, [symbol])
        const f = features[0]
        if (!f) return `${symbol}: ${failures[0] ?? "no features"}`
        const shown = Object.entries(featuresForPrompt(f)).map(([k, v]) => `${k} ${typeof v === "number" ? roundTo(v, 6) : v}`)
        return `${symbol}: ${shown.join(", ")}`
      },
    }),
    defineTool({
      name: "depth",
      description: "the order book of a pair: the top levels each side and what a buy of $1,000 / $5,000 would pay above the mid. Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }) => {
        const q = ctx.hub.quote(symbol)
        if (!q?.book) return `${symbol}: no live order book`
        const levels = (side: { price: number; qty: number }[]) => side.slice(0, 5).map((l) => `${l.price} × ${roundTo(l.qty, 6)}`).join(", ")
        const cost = (usd: number) => {
          const w = walkBook(q.book!.asks, usd / q.ask, null, "buy")
          return w.avgPrice ? `${(((w.avgPrice - q.mid) / q.mid) * 10_000).toFixed(1)} bps${w.filledQty * q.ask < usd * 0.99 ? " (book too thin to fill it)" : ""}` : "n/a"
        }
        return `${symbol} asks: ${levels(q.book.asks)}\nbids: ${levels(q.book.bids)}\nbuying $1,000 pays ${cost(1_000)} over the mid; $5,000 pays ${cost(5_000)}.`
      },
    }),
    defineTool({
      name: "news",
      description: "what our feeds saw about a pair (or the market, symbol null) in the last N hours, most severe first, with article summaries. Args: {symbol|null, hours 1-72}.",
      args: z.object({ symbol: symbolArg.nullable(), hours: z.number().describe("1-72") }),
      run: async ({ symbol, hours }, tc) => {
        const since = new Date(Date.now() - Math.min(72, Math.max(1, hours)) * HOUR)
        const items = await ctx.col.wireItems
          .find({ ...(symbol ? { symbols: symbol } : { symbols: { $size: 0 } }), first_seen_at: { $gte: since }, severity: { $gte: ctx.settings.current.wire.thresholds.annotate } })
          .sort({ severity: -1, first_seen_at: -1 })
          .limit(10)
          .toArray()
        for (const i of items) if (i.url) tc.urls.add(i.url)
        if (!items.length) return `no items about ${symbol ?? "the market"} in the last ${hours} h`
        return fenceUntrusted("wire", items.map((i) => `${i._id.slice(0, 12)} ${itemLine(i)}`).join("\n"))
      },
    }),
    defineTool({
      name: "dossier",
      description: "our feeds' dossier on up to 5 pairs: the top items of the last 72 h, market-wide items, scheduled releases, moves nothing explains and items nobody confirmed. Args: {symbols}.",
      args: z.object({ symbols: z.array(symbolArg).describe("1-5 pairs") }),
      run: async ({ symbols }, tc) => {
        const dossier = await buildDossier(ctx.col, {
          symbols: symbols.slice(0, 5),
          since: new Date(Date.now() - 72 * HOUR),
          now: new Date(),
          price,
          timeLabel: (t) => `${t.toISOString().slice(11, 16)}Z`,
          reviewThreshold: ctx.settings.current.wire.thresholds.review,
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
        const i = await ctx.col.wireItems.findOne({ _id: { $regex: `^${clean}` } })
        if (!i) return `no item ${clean}`
        if (i.url) tc.urls.add(i.url)
        const confirmations = i.confirmations.map((c) => `${c.domain} ${utcTime(c.at)}`).join(", ") || "none"
        const points = i.article?.key_points?.length ? `\nkey points: ${i.article.key_points.join("; ")}` : ""
        return fenceUntrusted("wire", `${itemLine(i)}\nsymbols ${i.symbols.join(", ") || "market-wide"} · confirmations: ${confirmations}${i.summary ? `\nsource summary: ${cleanLine(i.summary, 600)}` : ""}${points}`)
      },
    }),
    defineTool({
      name: "past_decisions",
      description: "the bot's last decisions on a pair (the timed cycles' and yours in the shadow book), with how they turned out. Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }) => {
        const [cycles, shadow] = await Promise.all([
          ctx.col.decisions.find({ symbol }, { projection: { created_at: 1, action: 1, "ai.conviction": 1, "ai.thesis": 1, "execution.status": 1, outcome: 1 } }).sort({ created_at: -1 }).limit(6).toArray(),
          ctx.col.shadowPositions.find({ symbol }).sort({ opened_at: -1 }).limit(5).toArray(),
        ])
        const a = cycles.map(
          (x) =>
            `- ${utcTime(x.created_at)} cycle: ${x.action} (conviction ${x.ai.conviction}, ${x.execution.status})${x.outcome ? `; after ${x.outcome.horizon_hours} h ${x.outcome.forward_return_pct ?? "?"}%, ${x.outcome.hit ?? "?"} hit, ${x.outcome.correct === null ? "unscored" : x.outcome.correct ? "right" : "wrong"}` : ""}: ${cleanLine(x.ai.thesis, 160)}`,
        )
        const b = shadow.map((p) => `- ${utcTime(p.opened_at)} you (shadow): bought at ${p.entry_price}${p.status === "closed" ? `, sold at ${p.exit_price} (${p.exit_reason}) for ${p.realized_pnl_usd >= 0 ? "+" : ""}$${p.realized_pnl_usd.toFixed(2)}` : ", still open"}: ${cleanLine(p.thesis, 160)}`)
        return [...a, ...b].join("\n") || `no decisions on ${symbol} yet`
      },
    }),
    defineTool({
      name: "calendar",
      description: "scheduled US macro releases (FOMC, CPI, jobs, PPI, PCE, GDP) in the next N days. Args: {days 1-14}.",
      args: z.object({ days: z.number().describe("1-14") }),
      run: async ({ days }) => {
        const events = upcomingMacro(new Date(), Math.min(14, Math.max(1, days)) * 24)
        return events.length ? events.map((e) => `- ${utcTime(e.at)} ${e.title}`).join("\n") : `no scheduled releases in the next ${days} days`
      },
    }),
    defineTool({
      name: "history",
      description: "a pair's daily history from our history store (years deep): return, range, volatility, worst drawdown, biggest days, weekly closes. Args: {symbol, days 7-1825}.",
      args: z.object({ symbol: symbolArg, days: z.number().describe("7-1825") }),
      run: async ({ symbol, days }) => {
        const bars = await d.history?.dailyBars(symbol, Math.min(1_825, Math.max(7, days)))
        return bars ? describeDailyBars(symbol, bars) : "the history store is not available"
      },
    }),
    defineTool({
      name: "past_news",
      description: "earlier news about a pair from our archive (beyond the last 30 days too), most severe first, with the price move 1 h, 1 d and 5 d after each. Args: {symbol, days 7-730}.",
      args: z.object({ symbol: symbolArg, days: z.number().describe("7-730") }),
      run: async ({ symbol, days }, tc) => {
        const rows = await d.history?.newsWithMoves(symbol, { days: Math.min(730, Math.max(7, days)), minSeverity: ctx.settings.current.wire.thresholds.review, limit: 10 })
        if (!rows) return "the history store is not available"
        if (!rows.length) return `no archived items about ${symbol} at review severity in the last ${days} days`
        for (const r of rows) if (r.url) tc.urls.add(r.url)
        return pastNewsText(rows)
      },
    }),
  ]
}
