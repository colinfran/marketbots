import type { Settings } from "@mb/stock-core/settings"
import { marketDay } from "@mb/stock-core/time"
import type { Alpaca } from "../../alpaca/client"
import { PollingSource } from "../poller"
import type { RawItem, SourceSpec } from "../types"

/**
 * News-engine sources served by the Alpaca client (its auth, retries and rate limits):
 *   - alpaca_news: Benzinga news for every symbol, polled every 20 s. Headlines and links only:
 *     Alpaca offers the feed for headlines shown to end users, so Benzinga's summaries aren't kept.
 *   - movers: the screener's top gainers and losers during the session, as market-data items, so
 *     a big move the news hasn't explained can be checked.
 */

/** Overlap between polls, so an item published while a request was in flight isn't missed. */
const OVERLAP_MS = 2 * 60_000
/** Round-ups tag a dozen tickers; past this many, the item is about none of them in particular. */
const MAX_SYMBOLS = 6

export const alpacaNewsSpec = (alpaca: Pick<Alpaca, "getNews">): SourceSpec => ({
  id: "alpaca_news",
  kind: "custom",
  interval_s: 20,
  tier: 2,
  default_enabled: true,
  note: "Alpaca news (Benzinga), REST every 20 s",
  create: (spec, ctx) => {
    let since = new Date(ctx.now().getTime() - 60 * 60_000)
    return new PollingSource(spec, ctx, async () => {
      const news = await alpaca.getNews(null, since, 50)
      const newest = Math.max(since.getTime() + OVERLAP_MS, ...news.map((n) => Date.parse(n.created_at)).filter(Number.isFinite))
      since = new Date(newest - OVERLAP_MS)
      return news
        .filter((n) => n.symbols.length <= MAX_SYMBOLS)
        .map(
          (n): RawItem => ({
            sourceId: String(n.id),
            title: n.headline,
            summary: null,
            url: n.url,
            publishedAt: new Date(n.created_at),
            symbols: n.symbols.map((s) => s.toUpperCase()),
            meta: { publisher: n.source || "benzinga" },
          }),
        )
    })
  },
})

export const moversSpec = (alpaca: Pick<Alpaca, "getMovers">, settings: () => Settings, isOpen: () => boolean): SourceSpec => ({
  id: "movers",
  kind: "custom",
  interval_s: 60,
  tier: 1,
  wire_kind: "anomaly",
  default_enabled: true,
  note: "Alpaca screener top movers, regular session only",
  create: (spec, ctx) =>
    new PollingSource(spec, ctx, async () => {
      if (!isOpen()) return []
      const { gainers, losers } = await alpaca.getMovers(20)
      const minPrice = settings().risk.min_price
      const day = marketDay(ctx.now())
      return [...gainers, ...losers]
        .filter((m) => m.price >= minPrice && Math.abs(m.percent_change) >= 10)
        .map(
          (m): RawItem => ({
            sourceId: `mover:${day}:${m.symbol}:${m.percent_change > 0 ? "up" : "down"}`,
            title: `${m.symbol} ${m.percent_change > 0 ? "+" : ""}${m.percent_change.toFixed(1)}% today at $${m.price} (top ${m.percent_change > 0 ? "gainer" : "loser"})`,
            symbols: [m.symbol],
            kind: "anomaly",
            category: "price_shock",
            tier: 1,
            polarity: m.percent_change > 0 ? 1 : -1,
            baseSeverity: Math.round(40 + Math.min(30, Math.abs(m.percent_change) / 2)),
            meta: { anomaly: "mover", change_pct: m.percent_change, price: m.price },
          }),
        )
    }),
})
