import { crc32 } from "node:zlib"

/**
 * A local copy of a Kraken WebSocket v2 order book, kept in sync with snapshot + update messages
 * and verified against Kraken's CRC32 checksum after every update. A mismatch means the local
 * book is wrong (missed or misapplied update), and the caller resubscribes instead of trading on it.
 */

export type Level = { price: number; qty: number }

const fmt = (value: number, decimals: number) => value.toFixed(decimals).replace(".", "").replace(/^0+/, "")

/** Kraken's checksum over the top 10 asks (low→high) then top 10 bids (high→low). */
export const bookChecksum = (asks: Level[], bids: Level[], priceDecimals: number, qtyDecimals: number): number => {
  const part = (levels: Level[]) => levels.slice(0, 10).map((l) => fmt(l.price, priceDecimals) + fmt(l.qty, qtyDecimals)).join("")
  return crc32(part(asks) + part(bids)) >>> 0
}

export class OrderBook {
  asks: Level[] = []
  bids: Level[] = []
  updatedAt = 0

  constructor(
    readonly symbol: string,
    private readonly depth: number,
    private readonly priceDecimals: number,
    private readonly qtyDecimals: number,
  ) {}

  private static apply(side: Level[], updates: Level[], ascending: boolean, depth: number): Level[] {
    const byPrice = new Map(side.map((l) => [l.price, l.qty]))
    for (const u of updates) {
      if (u.qty === 0) byPrice.delete(u.price)
      else byPrice.set(u.price, u.qty)
    }
    return [...byPrice.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => (ascending ? a.price - b.price : b.price - a.price))
      .slice(0, depth)
  }

  snapshot(asks: Level[], bids: Level[], at = Date.now()) {
    this.asks = OrderBook.apply([], asks, true, this.depth)
    this.bids = OrderBook.apply([], bids, false, this.depth)
    this.updatedAt = at
  }

  update(asks: Level[], bids: Level[], at = Date.now()) {
    if (asks.length) this.asks = OrderBook.apply(this.asks, asks, true, this.depth)
    if (bids.length) this.bids = OrderBook.apply(this.bids, bids, false, this.depth)
    this.updatedAt = at
  }

  checksum() {
    return bookChecksum(this.asks, this.bids, this.priceDecimals, this.qtyDecimals)
  }

  verify(expected: number | undefined): boolean {
    return expected === undefined || this.checksum() === expected
  }

  get bestBid() {
    return this.bids[0]?.price ?? null
  }

  get bestAsk() {
    return this.asks[0]?.price ?? null
  }

  get mid() {
    return this.bestBid !== null && this.bestAsk !== null ? (this.bestBid + this.bestAsk) / 2 : null
  }

  /** Bid/ask spread in basis points of the mid. */
  get spreadBps() {
    const mid = this.mid
    return mid && this.bestAsk !== null && this.bestBid !== null ? ((this.bestAsk - this.bestBid) / mid) * 10_000 : null
  }

  /** Copies of the levels, so simulations can't mutate the live book. */
  levels(): { asks: Level[]; bids: Level[] } {
    return { asks: this.asks.map((l) => ({ ...l })), bids: this.bids.map((l) => ({ ...l })) }
  }
}
