import type { Settings } from "@mb/stock-core/settings"
import type { WireSourceHealth, WireSourceState } from "@mb/stock-core/wire"
import type { Alpaca } from "../alpaca/client"
import type { MarketStream } from "../alpaca/market-stream"
import { errorMessage, type Logger } from "../log"
import type { SourceSpec, WireSource } from "../wire/types"
import { FinnhubStream } from "./finnhub-stream"
import { type BoardBar, type Layer, PriceBoard } from "./price-board"
import type { ScanUniverseStore } from "./scan-universe"
import { YahooStream } from "./yahoo-stream"

/**
 * The stock price layers (MASTER_PLAN §3.13) and which symbols each one carries:
 *   tracked (bars and anomaly detection): the scan universe plus held stocks, option underlyings,
 *     benchmarks, the watchlist, today's movers and the news engine's focus
 *   Yahoo (C) and the snapshot fallback (E): the tracked set
 *   Finnhub (D): focus, then watchlist, then held (≤ 50)
 * Each layer is also a news-engine source, so its health shows beside the news sources, and the
 * owner can switch one off with wire.disabled_sources.
 */

const STALE_MS = 3 * 60_000
const UNIVERSE_EVERY_MS = 10 * 60_000
const SNAPSHOT_EVERY_MS = 60_000
/** Symbols beyond the scan universe (held, watchlist, movers, focus) at most. */
const MAX_EXTRA = 200

export type CoverageSymbols = { held: string[]; benchmarks: string[]; watch: string[]; movers: string[]; focus: string[] }

export type CoverageDeps = {
  alpaca: Pick<Alpaca, "getSnapshots">
  universe: Pick<ScanUniverseStore, "symbols" | "refresh" | "lastError">
  marketStream: Pick<MarketStream, "barsRejected" | "barsSubscribed">
  settings: () => Settings
  log: Logger
  finnhubKey?: string
  /** Whether the regular session is open now. */
  sessionOpen: () => boolean
  onBars: (t: number, bars: BoardBar[]) => void
  /** The tracked set changed: the anomaly detector warms up the new symbols. */
  onTracked: (symbols: string[]) => void
}

const ageText = (at: number | null) => (at === null ? "no data yet" : `data ${Math.round((Date.now() - at) / 1000)} s old`)

export class PriceCoverage {
  readonly board: PriceBoard
  readonly yahoo: YahooStream
  readonly finnhub: FinnhubStream
  private symbols: CoverageSymbols = { held: [], benchmarks: [], watch: [], movers: [], focus: [] }
  private tracked: string[] = []
  private universeTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private snapshotsActive = false
  private lastSnapshotAt: number | null = null
  private snapshotError: string | null = null

  constructor(private readonly d: CoverageDeps) {
    this.board = new PriceBoard(d.onBars)
    this.yahoo = new YahooStream(d.log.child({ component: "yahoo-stream" }), (t) => this.board.tick("C", t.symbol, t.price, t.at), d.sessionOpen)
    this.finnhub = new FinnhubStream(d.finnhubKey, d.log.child({ component: "finnhub-stream" }), (t) => this.board.tick("D", t.symbol, t.price, t.at))
    // Layers start off; each comes on when the news engine starts its source.
    for (const l of ["B", "C", "D", "E"] as const) this.board.setEnabled(l, false)
  }

  /** Starts the board and the daily universe refresh (the layers start as news-engine sources). */
  start() {
    this.board.start()
    const refresh = () => void this.d.universe.refresh().then((changed) => changed && this.recompute())
    refresh()
    this.universeTimer = setInterval(refresh, UNIVERSE_EVERY_MS)
    this.universeTimer.unref()
  }

  stop() {
    this.board.stop()
    if (this.universeTimer) clearInterval(this.universeTimer)
    this.stopSnapshots()
    this.yahoo.stop()
    this.finnhub.stop()
  }

  /** What the engine holds and watches (every few minutes, and when an event cycle starts). */
  setSymbols(symbols: CoverageSymbols) {
    this.symbols = symbols
    this.recompute()
  }

  get trackedSymbols(): readonly string[] {
    return this.tracked
  }

  private recompute() {
    const s = this.symbols
    const extras = [...new Set([...s.held, ...s.focus, ...s.benchmarks, ...s.watch, ...s.movers].map((x) => x.toUpperCase()))].slice(0, MAX_EXTRA)
    const max = this.d.settings().wire.scan_max_symbols + MAX_EXTRA
    const tracked = [...new Set(["SPY", ...extras, ...this.d.universe.symbols])].slice(0, max)
    const changed = tracked.length !== this.tracked.length || tracked.some((x, i) => x !== this.tracked[i])
    this.tracked = tracked
    this.board.setTracked(tracked)
    this.yahoo.setSymbols(tracked)
    this.finnhub.setSymbols([...s.focus, ...s.watch, ...s.held])
    if (changed) this.d.onTracked(tracked)
  }

  /** The best fresh price for a symbol from any layer (news-engine uses only). */
  price(symbol: string, maxAgeMs: number): number | null {
    return this.board.price(symbol, maxAgeMs)?.price ?? null
  }

  // ─── Layer E: snapshots, only while B and C are both quiet in session ──

  private startSnapshots() {
    if (this.snapshotTimer) return
    this.snapshotTimer = setInterval(() => void this.pollSnapshots(), SNAPSHOT_EVERY_MS)
    this.snapshotTimer.unref()
  }

  private stopSnapshots() {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    this.snapshotTimer = null
    this.snapshotsActive = false
  }

  private fresh(layer: Layer) {
    const at = this.board.stats(layer).last_at
    return at !== null && Date.now() - at < STALE_MS
  }

  private async pollSnapshots() {
    this.snapshotsActive = this.d.sessionOpen() && !this.fresh("B") && !this.fresh("C")
    if (!this.snapshotsActive || !this.tracked.length) return
    try {
      const snaps = await this.d.alpaca.getSnapshots(this.tracked)
      for (const [symbol, snap] of Object.entries(snaps)) {
        const b = snap.minuteBar
        if (b) this.board.bar("E", symbol, Date.parse(b.t), b.c, b.v)
      }
      this.lastSnapshotAt = Date.now()
      this.snapshotError = null
    } catch (error) {
      this.snapshotError = errorMessage(error).slice(0, 200)
    }
  }

  // ─── News-engine sources (health and on/off) ────────────────────────────

  /** One catalog entry per layer B–E (layer A is the broker stream, shown with the broker). */
  specs(): SourceSpec[] {
    const spec = (id: string, layer: Layer, note: string, on: () => void, off: () => void, health: () => Omit<WireSourceHealth, "id" | "items_24h" | "dropped_24h" | "lag_s" | "last_item_at">, extra: Partial<SourceSpec> = {}): SourceSpec => ({
      id,
      kind: "custom",
      interval_s: 60,
      tier: 1,
      wire_kind: "anomaly",
      default_enabled: true,
      note,
      ...extra,
      create: () => new LayerSource(id, () => {
        this.board.setEnabled(layer, true)
        on()
      }, () => {
        this.board.setEnabled(layer, false)
        off()
      }, health),
    })
    const closed = () => !this.d.sessionOpen()
    return [
      spec("price:alpaca_bars", "B", "Alpaca IEX minute bars for every symbol (layer B)", () => undefined, () => undefined, () => {
        const st = this.board.stats("B")
        const state: WireSourceState = this.d.marketStream.barsRejected ? "down" : closed() || this.fresh("B") ? (st.disagreeing >= 5 ? "degraded" : "ok") : st.last_at === null ? "starting" : "degraded"
        return {
          state,
          last_ok_at: st.last_at ? new Date(st.last_at) : null,
          last_error: this.d.marketStream.barsRejected ? "the plan rejected bars for all symbols" : null,
          detail: `${closed() ? "market closed" : `${st.symbols_last_minute} tracked symbols last minute`}, ${ageText(st.last_at)}${st.disagreeing ? `, ${st.disagreeing} disagreeing` : ""}`,
        }
      }),
      spec("price:yahoo", "C", "Yahoo Finance streamer, unofficial (layer C)", () => this.yahoo.start(), () => this.yahoo.stop(), () => {
        const h = this.yahoo.health()
        const st = this.board.stats("C")
        const state: WireSourceState = h.state === "paused" ? "degraded" : h.state !== "connected" ? (h.last_message_at === null ? "starting" : "degraded") : closed() || this.fresh("C") ? (st.disagreeing >= 5 ? "degraded" : "ok") : "degraded"
        return {
          state,
          last_ok_at: h.last_message_at ? new Date(h.last_message_at) : null,
          last_error: h.state === "paused" ? `paused after repeated failures: ${h.last_error ?? "no messages"}` : h.last_error,
          detail: `${h.symbols} subscribed, ${st.symbols_last_minute} ticking last minute, ${ageText(st.last_at)}${st.disagreeing ? `, ${st.disagreeing} disagreeing` : ""}`,
        }
      }),
      spec(
        "price:finnhub",
        "D",
        "Finnhub trades for focus and watchlist, ≤ 50 symbols (layer D)",
        () => this.finnhub.start(),
        () => this.finnhub.stop(),
        () => {
          const h = this.finnhub.health()
          const st = this.board.stats("D")
          return {
            state: h.state === "connected" ? "ok" : h.state === "disabled" ? "disabled" : h.last_message_at === null ? "starting" : "degraded",
            last_ok_at: h.last_message_at ? new Date(h.last_message_at) : null,
            last_error: h.last_error,
            detail: `${h.symbols} symbols, ${ageText(st.last_at)}`,
          }
        },
        { key_env: "FINNHUB_API_KEY" },
      ),
      spec("price:snapshots", "E", "Alpaca snapshots, polled only while layers B and C are down (layer E)", () => this.startSnapshots(), () => this.stopSnapshots(), () => ({
        state: this.snapshotError && this.snapshotsActive ? "degraded" : "ok",
        last_ok_at: this.lastSnapshotAt ? new Date(this.lastSnapshotAt) : null,
        last_error: this.snapshotError ?? this.d.universe.lastError,
        detail: this.snapshotsActive ? `polling ${this.tracked.length} symbols, ${ageText(this.lastSnapshotAt)}` : `standby; tracking ${this.tracked.length} symbols`,
      })),
    ]
  }
}

/** A price layer as seen by the news engine: no items of its own, only health and on/off. */
class LayerSource implements WireSource {
  readonly tier = 1 as const
  private running = false

  constructor(
    readonly id: string,
    private readonly on: () => void,
    private readonly off: () => void,
    private readonly status: () => Omit<WireSourceHealth, "id" | "items_24h" | "dropped_24h" | "lag_s" | "last_item_at">,
  ) {}

  start() {
    this.running = true
    this.on()
  }

  stop() {
    this.running = false
    this.off()
  }

  health(): WireSourceHealth {
    const base = { id: this.id, last_item_at: null, items_24h: 0, dropped_24h: 0, lag_s: null }
    if (!this.running) return { ...base, state: "disabled", last_ok_at: null, last_error: null }
    return { ...base, ...this.status() }
  }
}
