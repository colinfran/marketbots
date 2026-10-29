import { defineTool, type AgentTool } from "@mb/agent/tools"
import { calendarTool, historyTools, wireTools, type WireToolsDeps } from "@mb/agent/wire-tools"
import { cleanLine } from "@mb/engine-kit/util/text"
import type { Bar } from "@mb/stock-core/alpaca"
import { TICKER_PATTERN } from "@mb/stock-core/settings"
import { addDays, formatDateTime, formatTime, marketDay, marketTime } from "@mb/stock-core/time"
import type { WireCategory } from "@mb/stock-core/wire"
import { z } from "zod"
import { dailyTechnicals, intradayTechnicals, snapshotPrice } from "../market/indicators"
import { loadChain } from "../market/options-chain"
import { isLive, sidePrices, type StockAgentDeps } from "./book"
import { bookText } from "./view"

/**
 * The stock agent's tools (docs/plans/LOCAL-AI.md §8.3), all read-only: its own (the book, quotes,
 * technicals from Alpaca's bars, option menus, past decisions) and the ones both bots share
 * (@mb/agent/wire-tools: news, the dossier, an item, the calendar, history and past news).
 *
 * An option menu is the cycle's OPTION CHAINS for one stock; the contracts it shows are remembered
 * for the episode (`offered`), and an options entry may use only those.
 */

/** The most stocks one episode may load option menus for. */
const MAX_MENUS = 3

const symbolArg = z.string().describe("A US ticker in uppercase, e.g. NVDA.")

/** Technicals are cached a couple of minutes per ticker: the agent may ask twice in one episode. */
const TECHNICALS_MS = 2 * 60_000

const round = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : String(Math.round(v * 10 ** digits) / 10 ** digits))

export const stockAgentTools = (d: StockAgentDeps): AgentTool[] => {
  const { ctx } = d
  const cache = new Map<string, { at: number; text: string }>()
  const wire: WireToolsDeps<WireCategory> = {
    // Read when a tool runs: the contract test builds the tools without an engine.
    get col() {
      return ctx.col
    },
    price: (s) => d.price(s),
    timeLabel: (t) => formatDateTime(t),
    dossierTime: (t) => formatTime(t),
    thresholds: () => ctx.settings.current.wire.thresholds,
    get history() {
      return d.history
    },
    noun: { one: "stock", many: "stocks" },
    symbolArg,
  }
  const valid = (symbol: string) => TICKER_PATTERN.test(symbol)

  return [
    defineTool({
      name: "book",
      description: "your book again (positions, cash, P&L), the session and the limits code enforces right now. Args: {}.",
      args: z.object({}),
      run: async () => bookText(d),
    }),
    defineTool({
      name: "option_menu",
      description: "the liquid option contracts you may buy on a stock: calls and puts in the allowed expirations, with bid, ask, delta, IV and open interest. A buy_option must copy its contracts from this list. Level auto only. Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }, t) => {
        if (!isLive(d)) return "options are traded only at level auto: the shadow book has none"
        const o = ctx.settings.current.options
        if (!o.enabled) return "options trading is disabled"
        if (!valid(symbol)) return `${symbol} is not a ticker`
        const offered = d.offered.get(t.episodeId) ?? new Map()
        const menus = new Set([...offered.values()].map((c) => c.symbol.slice(0, -15)))
        if (menus.size >= MAX_MENUS && !menus.has(symbol)) return `at most ${MAX_MENUS} option menus per episode`
        const price = d.price(symbol)
        if (price === null) return `${symbol}: no price`
        if (price < ctx.settings.current.risk.min_price) return `${symbol} at ${price} is below the $${ctx.settings.current.risk.min_price} minimum`
        const chain = await loadChain(ctx.alpaca, symbol, price, marketDay(new Date()), o)
        if (!chain.contracts.length) return `${symbol}: no contracts pass the liquidity filters (${o.min_dte}-${o.max_dte} days, spread ≤ ${o.max_spread_pct}%, open interest ≥ ${o.min_open_interest})`
        for (const c of chain.contracts) offered.set(c.symbol, c)
        d.offered.set(t.episodeId, offered)
        return [
          `${symbol} @ ${price} (prices per share, × 100 per contract):`,
          ...chain.contracts.map((x) => `  ${x.symbol} ${x.type} ${x.expiration} (${x.dte}d) K=${x.strike} bid ${x.bid} ask ${x.ask} mid ${x.mid} spread ${x.spread_pct}% Δ ${x.delta ?? "?"} iv ${x.iv ?? "?"} OI ${x.open_interest ?? "?"}`),
        ].join("\n")
      },
    }),
    defineTool({
      name: "quote",
      description: "the live price of a stock, its bid and ask when the broker streams it, and the day's change. Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }) => {
        if (!valid(symbol)) return `${symbol} is not a ticker`
        const p = sidePrices(d, symbol)
        const live = ctx.prices.get(symbol)
        if (p) return `${symbol}: ${p.last}${live?.bid && live.ask ? ` (bid ${live.bid}, ask ${live.ask})` : ""}, ${live?.change_pct === null || live?.change_pct === undefined ? "change n/a" : `${live.change_pct >= 0 ? "+" : ""}${live.change_pct}% today`}${live ? `, ${Math.round((Date.now() - live.at) / 1000)} s old` : ", from the price layers"}.`
        const snap = (await ctx.alpaca.getSnapshots([symbol]))[symbol]
        const price = snapshotPrice(snap)
        return price === null ? `${symbol}: no price` : `${symbol}: ${price} (Alpaca snapshot; not streamed live)`
      },
    }),
    defineTool({
      name: "technicals",
      description: "a stock's technicals from Alpaca's bars: daily (20/50/200-day averages, 52-week high, 5/20-day returns, ATR, RSI, 20-day range) and today's 5-minute (VWAP, opening range, RSI, EMA trend). Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }) => {
        if (!valid(symbol)) return `${symbol} is not a ticker`
        const hit = cache.get(symbol)
        if (hit && Date.now() - hit.at < TECHNICALS_MS) return hit.text
        const now = new Date()
        const day = marketDay(now)
        const session = d.session()
        const started = session?.open && session.open <= now
        const [daily, intraday] = await Promise.all([
          ctx.alpaca.getBars([symbol], "1Day", marketTime(addDays(day, -380), "00:00"), marketTime(day, "00:00")).catch(() => ({}) as Record<string, Bar[]>),
          started ? ctx.alpaca.getBars([symbol], "5Min", session!.open!, session!.close && session!.close < now ? session!.close : now).catch(() => ({}) as Record<string, Bar[]>) : Promise.resolve({} as Record<string, Bar[]>),
        ])
        const price = d.price(symbol)
        const dt = dailyTechnicals(daily[symbol] ?? [], price)
        const it = intradayTechnicals(intraday[symbol] ?? [])
        const text = [
          `${symbol} at ${price ?? "n/a"}.`,
          dt
            ? `Daily: SMA20 ${round(dt.sma20)} (${round(dt.pct_from_sma20)}%), SMA50 ${round(dt.sma50)} (${round(dt.pct_from_sma50)}%), SMA200 ${round(dt.sma200)} (${round(dt.pct_from_sma200)}%), 52-week high ${round(dt.high_52w)} (${round(dt.pct_from_high_52w)}%), 5 d ${round(dt.return_5d_pct)}%, 20 d ${round(dt.return_20d_pct)}%, ATR14 ${round(dt.atr14)} (${round(dt.atr_pct)}%), RSI14 ${round(dt.rsi14_daily, 1)}, 20-day range ${round(dt.low_20d)}-${round(dt.high_20d)}.`
            : "Daily: no bars.",
          it
            ? `Today (5 min): VWAP ${round(it.vwap)} (${round(it.pct_from_vwap)}%), opening range ${round(it.opening_range_low)}-${round(it.opening_range_high)}, day ${round(it.day_low)}-${round(it.day_high)}, RSI14 ${round(it.rsi14_5m, 1)}, EMA9/21 ${round(it.ema9_5m)}/${round(it.ema21_5m)} (${it.trend_5m ?? "n/a"}), last 30 min ${round(it.change_30m_pct)}%.`
            : "Today: no intraday bars (the session hasn't started, or none came back).",
        ].join("\n")
        cache.set(symbol, { at: Date.now(), text })
        return text
      },
    }),
    ...wireTools(wire),
    defineTool({
      name: "past_decisions",
      description: "the bot's last decisions on a stock and its options (yours on the paper account, the timed cycles' before you, and yours in the shadow book), with what came of them. Args: {symbol}.",
      args: z.object({ symbol: symbolArg }),
      run: async ({ symbol }) => {
        const [cycles, shadow] = await Promise.all([
          ctx.col.decisions
            .find({ symbol }, { projection: { created_at: 1, action: 1, status: 1, reason: 1, price: 1, agent_episode_id: 1, "request.conviction": 1, "request.rationale": 1 } })
            .sort({ created_at: -1 })
            .limit(6)
            .toArray(),
          ctx.col.shadowPositions.find({ symbol }).sort({ opened_at: -1 }).limit(5).toArray(),
        ])
        const a = cycles.map(
          (x) =>
            `- ${formatDateTime(x.created_at)} ${x.agent_episode_id ? "you" : "cycle"}: ${x.action.replace(/_/g, " ")} at ${x.price ?? "?"} (conviction ${x.request.conviction}/10, ${x.status}${x.reason ? `: ${cleanLine(x.reason, 100)}` : ""}): ${cleanLine(x.request.rationale, 160)}`,
        )
        const b = shadow.map((p) => `- ${formatDateTime(p.opened_at)} you (shadow): bought ${p.qty || ""} at ${p.entry_price.toFixed(2)}${p.status === "closed" ? `, sold at ${p.exit_price?.toFixed(2)} (${p.exit_reason}) for ${p.realized_pnl_usd >= 0 ? "+" : ""}$${p.realized_pnl_usd.toFixed(2)}` : ", still open"}: ${cleanLine(p.thesis, 160)}`)
        return [...a, ...b].join("\n") || `no decisions on ${symbol} yet`
      },
    }),
    calendarTool((t) => formatDateTime(t)),
    ...historyTools(wire, 5),
  ]
}
