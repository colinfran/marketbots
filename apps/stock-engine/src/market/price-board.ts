/**
 * One price view across the free feeds (MASTER_PLAN §3.13), for the news engine only. Order
 * prices, stops and every risk check keep using the broker's own data.
 *
 *   A  Alpaca IEX trades (the 30-symbol MarketStream)            ticks
 *   B  Alpaca IEX minute bars for every symbol (bars: ["*"])     closed 1-minute bars with IEX volume
 *   C  Yahoo streamer (the scan universe)                        ticks
 *   D  Finnhub trades (focus and top watchlist, ≤ 50)            ticks
 *   E  Alpaca snapshots, polled only while B and C are down     the latest 1-minute bar
 *
 * Each closed minute becomes one bar per tracked symbol. The close comes from the best layer that
 * saw the symbol that minute (A > D > C > B > E). The volume comes from IEX only (B, else E), so the
 * volume baseline never mixes IEX with consolidated volume; with neither it's NaN and the bar
 * scores price only. When a lower layer's close is more than 1% off the chosen one for two minutes
 * running, that layer is counted as disagreeing on the symbol.
 */

export type Layer = "A" | "B" | "C" | "D" | "E"

export const PRECEDENCE: readonly Layer[] = ["A", "D", "C", "B", "E"]

export type BoardBar = { symbol: string; t: number; close: number; volume: number; layer: Layer }

export type LayerStats = { last_at: number | null; symbols_last_minute: number; disagreeing: number }

const MIN = 60_000
/** A minute closes this long after it ends: B's bars arrive a few seconds late. */
const SETTLE_MS = 12_000
const DISAGREE_PCT = 1
const DISAGREE_WINDOW_MS = 15 * MIN

type Cell = { close: number; at: number; volume?: number }
type Cells = Partial<Record<Layer, Cell>>

const LAYERS: readonly Layer[] = ["A", "B", "C", "D", "E"]

export class PriceBoard {
  /** Minute start → symbol → what each layer saw. */
  private readonly open = new Map<number, Map<string, Cells>>()
  private readonly latest = new Map<string, Partial<Record<Layer, { price: number; at: number }>>>()
  private tracked = new Set<string>()
  private readonly enabled = new Set<Layer>(LAYERS)
  /** `${layer}|${symbol}` → minutes in a row the layer was more than 1% off. */
  private readonly streak = new Map<string, number>()
  private readonly disagreeing = new Map<Layer, Map<string, number>>(LAYERS.map((l) => [l, new Map()]))
  private readonly lastAt = new Map<Layer, number>()
  private readonly seen = new Map<Layer, number>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly onBars: (t: number, bars: BoardBar[]) => void,
    private readonly reference = "SPY",
    private readonly now: () => number = () => Date.now(),
  ) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), 5_000)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Only these symbols get bars (B alone sends thousands a minute). */
  setTracked(symbols: Iterable<string>) {
    this.tracked = new Set(symbols)
  }

  isTracked(symbol: string) {
    return this.tracked.has(symbol)
  }

  setEnabled(layer: Layer, on: boolean) {
    if (on) this.enabled.add(layer)
    else this.enabled.delete(layer)
  }

  /** A trade or price tick from A, C or D. */
  tick(layer: Layer, symbol: string, price: number, at: number) {
    this.put(layer, symbol, Math.floor(at / MIN) * MIN, { close: price, at })
  }

  /** A closed 1-minute bar from B or E (`t` = the minute's start). */
  bar(layer: Layer, symbol: string, t: number, close: number, volume: number) {
    this.put(layer, symbol, t, { close, at: t + MIN - 1, volume })
  }

  private put(layer: Layer, symbol: string, minute: number, cell: Cell) {
    if (!this.enabled.has(layer) || !this.tracked.has(symbol) || !(cell.close > 0) || !Number.isFinite(cell.at)) return
    const latest = this.latest.get(symbol) ?? {}
    if (!latest[layer] || cell.at >= latest[layer]!.at) latest[layer] = { price: cell.close, at: cell.at }
    this.latest.set(symbol, latest)
    this.lastAt.set(layer, Math.max(this.lastAt.get(layer) ?? 0, this.now()))
    // Too late for its minute (already closed), or from the future: price only.
    if (minute + MIN + SETTLE_MS <= this.now() || minute > this.now() + MIN) return
    let symbols = this.open.get(minute)
    if (!symbols) this.open.set(minute, (symbols = new Map()))
    const cells = symbols.get(symbol) ?? {}
    const prev = cells[layer]
    if (!prev || cell.at >= prev.at) cells[layer] = cell
    symbols.set(symbol, cells)
  }

  /** The freshest price from the best layer, within `maxAgeMs`. */
  price(symbol: string, maxAgeMs: number): { price: number; layer: Layer; at: number } | null {
    const latest = this.latest.get(symbol)
    if (!latest) return null
    const cutoff = this.now() - maxAgeMs
    for (const layer of PRECEDENCE) {
      const p = latest[layer]
      if (p && p.at >= cutoff) return { price: p.price, layer, at: p.at }
    }
    return null
  }

  stats(layer: Layer): LayerStats {
    const cutoff = this.now() - DISAGREE_WINDOW_MS
    const symbols = this.disagreeing.get(layer)!
    for (const [s, at] of symbols) if (at < cutoff) symbols.delete(s)
    return { last_at: this.lastAt.get(layer) ?? null, symbols_last_minute: this.seen.get(layer) ?? 0, disagreeing: symbols.size }
  }

  /** Closes every minute that has settled, oldest first. */
  flush() {
    const now = this.now()
    for (const minute of [...this.open.keys()].sort((a, b) => a - b)) {
      if (minute + MIN + SETTLE_MS > now) break
      const symbols = this.open.get(minute)!
      this.open.delete(minute)
      const counts = new Map<Layer, number>()
      const bars: BoardBar[] = []
      for (const [symbol, cells] of symbols) {
        const layer = PRECEDENCE.find((l) => cells[l])
        if (!layer) continue
        for (const l of LAYERS) if (cells[l]) counts.set(l, (counts.get(l) ?? 0) + 1)
        const close = cells[layer]!.close
        bars.push({ symbol, t: minute, close, volume: cells.B?.volume ?? cells.E?.volume ?? Number.NaN, layer })
        this.compare(symbol, layer, close, cells, now)
      }
      for (const l of LAYERS) this.seen.set(l, counts.get(l) ?? 0)
      // The reference goes first, so the other symbols' residuals use its move.
      bars.sort((a, b) => (a.symbol === this.reference ? -1 : b.symbol === this.reference ? 1 : 0))
      if (bars.length) this.onBars(minute, bars)
    }
  }

  private compare(symbol: string, chosen: Layer, close: number, cells: Cells, now: number) {
    for (const layer of LAYERS) {
      const cell = cells[layer]
      if (layer === chosen || !cell) continue
      const key = `${layer}|${symbol}`
      if (Math.abs(cell.close / close - 1) * 100 <= DISAGREE_PCT) {
        this.streak.delete(key)
        continue
      }
      const n = (this.streak.get(key) ?? 0) + 1
      this.streak.set(key, n)
      if (n >= 2) this.disagreeing.get(layer)!.set(symbol, now)
    }
  }
}
