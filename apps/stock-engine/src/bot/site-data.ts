import type { Bar } from "@mb/stock-core/alpaca"
import type { AccountSnapshot, ChartBars, HistoryRangeKey } from "@mb/stock-core/db"
import { addDays, marketDay, marketTime } from "@mb/stock-core/time"
import type { TradingContext } from "./context"
import { getCalendar } from "./session"

/**
 * The dashboard never calls Alpaca (it holds no broker keys), so the engine copies what the
 * website shows into MongoDB's `cache` collection: the account and positions, the equity history
 * per range, and chart-ready price bars for every symbol the bot has touched recently.
 */

const DAY_MS = 86_400_000

const put = (ctx: Pick<TradingContext, "col">, key: string, data: unknown, keepMs = 7 * DAY_MS) => {
  const now = Date.now()
  return ctx.col.cache.updateOne({ _id: key }, { $set: { data, fetched_at: new Date(now), expires_at: new Date(now + keepMs) } }, { upsert: true })
}

export const ACCOUNT_KEY = "alpaca:account"

export const writeAccountSnapshot = async (ctx: Pick<TradingContext, "col" | "alpaca">): Promise<AccountSnapshot> => {
  const [account, positions, clock] = await Promise.all([ctx.alpaca.getAccount(), ctx.alpaca.getPositions(), ctx.alpaca.getClock()])
  const snapshot: AccountSnapshot = { account, positions, clock, as_of: new Date().toISOString() }
  await put(ctx, ACCOUNT_KEY, snapshot)
  return snapshot
}

export const HISTORY_RANGES: { key: HistoryRangeKey; period: string; timeframe: string }[] = [
  { key: "1D", period: "1D", timeframe: "5Min" },
  { key: "1W", period: "1W", timeframe: "1H" },
  { key: "1M", period: "1M", timeframe: "1D" },
  { key: "1A", period: "1A", timeframe: "1D" },
]

export const refreshHistory = async (ctx: Pick<TradingContext, "col" | "alpaca">, keys: HistoryRangeKey[]) => {
  for (const range of HISTORY_RANGES.filter((r) => keys.includes(r.key))) {
    const history = await ctx.alpaca.getPortfolioHistory(range.period, range.timeframe)
    await put(ctx, `alpaca:history:${range.key}`, history)
  }
}

/** Symbols with a page on the site: anything traded or decided on in the last 90 days, plus what's held. */
export const chartSymbols = async (ctx: Pick<TradingContext, "col">, held: string[], limit = 80): Promise<string[]> => {
  const since = new Date(Date.now() - 90 * DAY_MS)
  const [decided, traded, underlyings] = await Promise.all([
    ctx.col.decisions.distinct("symbol", { created_at: { $gte: since } }),
    ctx.col.orders.distinct("symbol", { asset_class: "us_equity", created_at: { $gte: since } }),
    ctx.col.optionPositions.distinct("underlying", { opened_at: { $gte: since } }),
  ])
  return [...new Set([...held, ...decided, ...traded, ...underlyings])].filter((s) => /^[A-Z][A-Z.]{0,9}$/.test(s)).slice(0, limit)
}

/** Regular-session bars for the last day, the last week and six months, per symbol. */
export const refreshCharts = async (ctx: Pick<TradingContext, "col" | "alpaca">, symbols: string[], now = new Date()) => {
  if (!symbols.length) return
  const today = marketDay(now)
  const sessions = (await getCalendar(ctx.alpaca, addDays(today, -14), today))
    .map((c) => ({ open: marketTime(c.date, c.open), close: marketTime(c.date, c.close) }))
    .filter((s) => s.open <= now)
  const lastDay = sessions.slice(-1)
  const lastWeek = sessions.slice(-5)
  const inSessions = (list: typeof sessions) => (bar: Bar) => {
    const t = new Date(bar.t)
    return list.some((s) => t >= s.open && t < s.close)
  }
  const empty: Record<string, Bar[]> = {}
  const [intraday, week, days] = await Promise.all([
    lastDay.length ? ctx.alpaca.getBars(symbols, "5Min", lastDay[0].open, now) : empty,
    lastWeek.length ? ctx.alpaca.getBars(symbols, "30Min", lastWeek[0].open, now) : empty,
    ctx.alpaca.getBars(symbols, "1Day", marketTime(addDays(today, -185), "00:00"), now),
  ])
  for (const symbol of symbols) {
    const data: ChartBars = {
      ranges: {
        "1D": (intraday[symbol] ?? []).filter(inSessions(lastDay)),
        "1W": (week[symbol] ?? []).filter(inSessions(lastWeek)),
        "6M": days[symbol] ?? [],
      },
      as_of: now.toISOString(),
    }
    await put(ctx, `chart:${symbol}`, data, 30 * DAY_MS)
  }
}
