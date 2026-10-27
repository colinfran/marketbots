import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { sleep } from "@mb/engine-kit/util/async"
import type { Settings } from "@mb/stock-core/settings"
import type { WireSourceHealth } from "@mb/stock-core/wire"
import { AnomalyDetector, type AnomalySignal } from "@mb/wire/anomaly"
import type { Alpaca } from "../../alpaca/client"
import type { BoardBar } from "../../market/price-board"
import type { Emit, RawItem, SourceSpec, WireSource } from "../types"

/**
 * Our own market data as news: each closed minute's bars from
 * the PriceBoard (the best of the free price layers per symbol) feed the mirrored AnomalyDetector,
 * judged against SPY (a move the whole market shares is not news about one stock). SPY's own
 * 5-minute move is the market-wide shock.
 *
 * The tracked set is the scan universe plus what we hold and watch (market/price-layers.ts). A new
 * symbol is warmed up from IEX 1-minute bars over REST, paced so trading calls never wait behind
 * it; until then its live bars are skipped (the detector only takes bars in time order). The first
 * `open_buffer_minutes` of the session are ignored, and IEX volume is a small slice of real
 * volume, so price is the main signal.
 */

export const REFERENCE = "SPY"
const WARM_BATCH = 50
/** Between warm-up requests: the first few go quickly (held and watched symbols come first). */
const WARM_PAUSE_FAST_MS = 1_000
const WARM_PAUSE_MS = 6_000
const WARM_FAST_BATCHES = 4

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0) as -1 | 0 | 1
const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`

export const stockSignalItem = (s: AnomalySignal, threshold: number): RawItem => {
  const scale = Math.min(1.6, Math.max(1, Math.abs(s.z) / threshold))
  const minute = new Date(s.at).toISOString().slice(0, 16)
  const base = { kind: "anomaly" as const, tier: 1 as const, publishedAt: new Date(s.at + 60_000) }
  if (s.kind === "market") {
    return { ...base, sourceId: `market:${minute}`, title: `Market-wide move: SPY ${fmtPct(s.ret_pct)} in ${s.window_min} min (z ${s.z})`, category: "price_shock", symbols: [], marketWide: true, polarity: sign(s.ret_pct), baseSeverity: Math.round(55 * scale), meta: { anomaly: "market", reference: s.symbol, z: s.z, window_min: s.window_min, ret_pct: s.ret_pct } }
  }
  if (s.kind === "price") {
    return { ...base, sourceId: `price:${s.symbol}:${minute}`, title: `${s.symbol} ${fmtPct(s.ret_pct)} in ${s.window_min} min (z ${s.z} after removing SPY's move)`, category: "price_shock", symbols: [s.symbol], polarity: sign(s.ret_pct), baseSeverity: Math.round(55 * scale), meta: { anomaly: "price", z: s.z, window_min: s.window_min, ret_pct: s.ret_pct } }
  }
  return { ...base, sourceId: `volume:${s.symbol}:${minute}`, title: `${s.symbol} traded ${s.volume_multiple}× its median 1-minute IEX volume (${fmtPct(s.ret_pct)})`, category: "volume_shock", symbols: [s.symbol], polarity: 0, meta: { anomaly: "volume", volume_multiple: s.volume_multiple, ret_pct: s.ret_pct } }
}

export class StockMarketSignals implements WireSource {
  readonly id = "anomaly"
  readonly tier = 1 as const
  readonly detector: AnomalyDetector
  private emit: Emit | null = null
  private tracked = new Set<string>([REFERENCE])
  private lastBarAt: number | null = null
  private lastItemAt: Date | null = null
  private lastError: string | null = null
  private readonly warmed = new Set<string>()
  /** Waiting for their warm-up: live bars are skipped until it lands. */
  private readonly warming = new Set<string>()
  private warmRunning = false
  private abort = new AbortController()

  constructor(
    private readonly alpaca: Pick<Alpaca, "getBars">,
    private readonly settings: () => Settings,
    private readonly log: Logger,
    /** When the current regular session opened, or null outside it. */
    private readonly sessionOpen: () => Date | null,
    private readonly onAnomaly: (symbol: string, kind: "price" | "volume") => void,
    private readonly pauses = { fast: WARM_PAUSE_FAST_MS, slow: WARM_PAUSE_MS },
  ) {
    this.detector = new AnomalyDetector(REFERENCE, () => {
      const a = this.settings().wire.anomaly
      return { priceZ: a.price_z, volumeMultiple: a.volume_multiple, marketZ: a.market_z }
    })
  }

  spec(): SourceSpec {
    return { id: this.id, kind: "custom", interval_s: 60, tier: 1, wire_kind: "anomaly", default_enabled: true, create: () => this, note: "1-minute bars for the scan universe, held and watched symbols" }
  }

  /** The symbols to score, most important first; new ones are warmed up from REST. */
  setTracked(symbols: readonly string[]) {
    this.tracked = new Set([REFERENCE, ...symbols.map((s) => s.toUpperCase())])
    // Symbols that left (yesterday's universe) free their history.
    for (const s of this.warmed) {
      if (this.tracked.has(s)) continue
      this.detector.forget(s)
      this.warmed.delete(s)
    }
    if (this.emit) this.warmUp()
  }

  start(emit: Emit) {
    this.emit = emit
    this.abort = new AbortController()
    this.warmUp()
  }

  stop() {
    this.emit = null
    this.abort.abort()
  }

  /** Today's and the previous sessions' 1-minute bars for tracked symbols not yet warmed up, SPY first. */
  private warmUp() {
    const todo = [REFERENCE, ...this.tracked].filter((s, i, all) => all.indexOf(s) === i && !this.warmed.has(s) && !this.warming.has(s))
    for (const s of todo) this.warming.add(s)
    if (this.warmRunning) return
    this.warmRunning = true
    void this.runWarmUp().finally(() => (this.warmRunning = false))
  }

  private async runWarmUp() {
    const signal = this.abort.signal
    const start = new Date(Date.now() - 4 * 86_400_000)
    let batches = 0
    let symbols = 0
    while (this.warming.size && !signal.aborted) {
      // The queue keeps the tracked order: SPY, then held and watched, then the universe.
      const batch = [...this.warming].filter((s) => this.tracked.has(s)).slice(0, WARM_BATCH)
      for (const s of [...this.warming]) if (!this.tracked.has(s)) this.warming.delete(s)
      if (!batch.length) break
      try {
        const bars = await this.alpaca.getBars(batch, "1Min", start)
        for (const symbol of batch) {
          const list = (bars[symbol] ?? []).slice(-1_440).map((b) => ({ t: Date.parse(b.t), close: b.c, volume: b.v }))
          this.detector.backfill(symbol, list)
          this.warmed.add(symbol)
          this.warming.delete(symbol)
        }
        symbols += batch.length
      } catch (error) {
        this.lastError = `warm-up failed: ${errorMessage(error)}`
        this.log.warn("anomaly warm-up failed", { error: errorMessage(error) })
        // Live bars only for these, rather than retrying in a loop.
        for (const symbol of batch) {
          this.warmed.add(symbol)
          this.warming.delete(symbol)
        }
      }
      batches += 1
      await sleep(batches < WARM_FAST_BATCHES ? this.pauses.fast : this.pauses.slow, signal)
    }
    if (symbols) this.log.info("anomaly detector warmed up", { symbols, tracked: this.tracked.size, spy_bars: this.detector.barCount(REFERENCE) })
  }

  /** A closed minute from the PriceBoard, SPY first. */
  onBars(t: number, bars: readonly BoardBar[]) {
    if (!this.emit) return
    this.lastBarAt = Date.now()
    const open = this.sessionOpen()
    // The opening auction and the first minutes are noise: bars are recorded, signals ignored.
    const quiet = !open || t < open.getTime() + this.settings().schedule.open_buffer_minutes * 60_000
    const a = this.settings().wire.anomaly
    const items: RawItem[] = []
    for (const bar of bars) {
      if (!this.tracked.has(bar.symbol) || this.warming.has(bar.symbol)) continue
      for (const s of this.detector.addBar(bar.symbol, { t: bar.t, close: bar.close, volume: bar.volume })) {
        if (quiet) continue
        this.onAnomaly(s.symbol, s.kind === "volume" ? "volume" : "price")
        items.push(stockSignalItem(s, s.kind === "market" ? a.market_z : a.price_z))
      }
    }
    if (items.length && this.emit) {
      this.lastItemAt = new Date()
      void this.emit(items).catch((e) => this.log.warn("anomaly items failed", { error: errorMessage(e) }))
    }
  }

  health(): WireSourceHealth {
    const open = this.sessionOpen()
    const fresh = this.lastBarAt !== null && Date.now() - this.lastBarAt < 5 * 60_000
    return {
      id: this.id,
      state: !this.emit ? "disabled" : fresh || !open ? "ok" : this.lastBarAt === null ? "starting" : "degraded",
      last_item_at: this.lastItemAt,
      last_ok_at: this.lastBarAt ? new Date(this.lastBarAt) : null,
      last_error: this.lastError,
      items_24h: 0,
      dropped_24h: 0,
      lag_s: null,
      detail: `${this.tracked.size} tracked, ${this.warmed.size} warmed${this.warming.size ? `, ${this.warming.size} warming` : ""}`,
    }
  }
}
