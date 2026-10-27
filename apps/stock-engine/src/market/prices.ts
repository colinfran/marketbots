import { roundTo } from "@mb/stock-core/math"
import type { EventBus } from "../bus/event-bus"

/**
 * The latest price per symbol from Alpaca's market data stream. Like `snapshotPrice`, it prefers
 * the quote midpoint when the quote is two-sided, tight and newer than the last trade (IEX's last
 * trade can be minutes old on quieter names), otherwise the last trade.
 *
 * Every update is turned into a `market.ticker` event for the dashboard, at most once per symbol
 * every couple of seconds.
 */

export type LivePrice = { symbol: string; price: number; bid: number | null; ask: number | null; at: number; change_pct: number | null }

type Entry = { trade: number | null; tradeAt: number; bid: number | null; ask: number | null; quoteAt: number }

const MAX_QUOTE_SPREAD_PCT = 0.5

export class LivePrices {
  private readonly entries = new Map<string, Entry>()
  private readonly prevClose = new Map<string, number>()
  private readonly lastEmit = new Map<string, number>()

  constructor(
    private readonly bus: EventBus | null,
    private readonly emitEveryMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  setPrevClose(symbol: string, close: number | null | undefined) {
    if (close && close > 0) this.prevClose.set(symbol, close)
  }

  hasPrevClose(symbol: string) {
    return this.prevClose.has(symbol)
  }

  onTrade(symbol: string, price: number, at: number) {
    if (!(price > 0)) return
    const e = this.entry(symbol)
    e.trade = price
    e.tradeAt = at
    this.changed(symbol)
  }

  onQuote(symbol: string, bid: number, ask: number, at: number) {
    const e = this.entry(symbol)
    e.bid = bid > 0 ? bid : null
    e.ask = ask > 0 ? ask : null
    e.quoteAt = at
    this.changed(symbol)
  }

  get(symbol: string): LivePrice | null {
    const e = this.entries.get(symbol)
    if (!e) return null
    let price = e.trade
    let at = e.tradeAt
    if (e.bid && e.ask && e.ask >= e.bid) {
      const mid = (e.ask + e.bid) / 2
      const tight = ((e.ask - e.bid) / mid) * 100 <= MAX_QUOTE_SPREAD_PCT
      if (tight && (price === null || e.quoteAt > e.tradeAt)) {
        price = roundTo(mid, 4)
        at = e.quoteAt
      }
    }
    if (price === null) return null
    const prev = this.prevClose.get(symbol)
    return { symbol, price, bid: e.bid, ask: e.ask, at, change_pct: prev ? roundTo((price / prev - 1) * 100, 2) : null }
  }

  /** The price if it's newer than `maxAgeMs`, else null. */
  fresh(symbol: string, maxAgeMs: number): number | null {
    const p = this.get(symbol)
    return p && this.now() - p.at <= maxAgeMs ? p.price : null
  }

  all(): LivePrice[] {
    return [...this.entries.keys()].map((s) => this.get(s)).filter((p): p is LivePrice => p !== null)
  }

  private entry(symbol: string): Entry {
    let e = this.entries.get(symbol)
    if (!e) {
      e = { trade: null, tradeAt: 0, bid: null, ask: null, quoteAt: 0 }
      this.entries.set(symbol, e)
    }
    return e
  }

  private changed(symbol: string) {
    if (!this.bus) return
    const now = this.now()
    if (now - (this.lastEmit.get(symbol) ?? 0) < this.emitEveryMs) return
    const p = this.get(symbol)
    if (!p) return
    this.lastEmit.set(symbol, now)
    this.bus.emit("market.ticker", { symbol, price: p.price, bid: p.bid, ask: p.ask, change_pct: p.change_pct }, { summary: `${symbol} ${p.price}`, level: "debug", instrument: symbol })
  }
}
