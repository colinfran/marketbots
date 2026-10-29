import { defineTool, type AgentTool } from "@mb/agent/tools"
import { calendarTool, historyTools, wireTools, type WireToolsDeps } from "@mb/agent/wire-tools"
import { roundTo } from "@mb/crypto-core/math"
import type { WireCategory } from "@mb/crypto-core/wire"
import { cleanLine } from "@mb/engine-kit/util/text"
import { z } from "zod"
import { featuresForPrompt } from "../market/features"
import { loadFeatures } from "../orchestrator/crypto-cycle"
import { walkBook } from "../risk/sizing"
import { bookText, type CryptoAgentDeps } from "./book"

/**
 * The crypto agent's tools (docs/plans/LOCAL-AI.md §8.3), all read-only: its own (the book, quotes,
 * features, depth, past decisions) and the ones both bots share (@mb/agent/wire-tools: news, the
 * dossier, an item, the calendar, history and past news).
 */

const utcTime = (d: Date) => `${d.toISOString().slice(5, 16).replace("T", " ")}Z`
const symbolArg = z.string().describe("A pair exactly as listed, e.g. SOL/USD.")

const known = (d: CryptoAgentDeps, symbol: string) => d.ctx.hub.universe.includes(symbol) || d.ctx.hub.pairs.has(symbol)

export const cryptoAgentTools = (d: CryptoAgentDeps): AgentTool[] => {
  const { ctx } = d
  const wire: WireToolsDeps<WireCategory> = {
    // Read when a tool runs: the contract test builds the tools without an engine.
    get col() {
      return ctx.col
    },
    price: (s) => ctx.hub.quote(s)?.mid ?? null,
    timeLabel: utcTime,
    dossierTime: (t) => `${t.toISOString().slice(11, 16)}Z`,
    thresholds: () => ctx.settings.current.wire.thresholds,
    get history() {
      return d.history
    },
    noun: { one: "pair", many: "pairs" },
    symbolArg,
  }

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
    ...wireTools(wire),
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
    calendarTool(utcTime),
    ...historyTools(wire, 7),
  ]
}
