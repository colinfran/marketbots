import type { Settings } from "@mb/crypto-core/settings"
import type { WireSourceHealth } from "@mb/crypto-core/wire"
import { errorMessage, type Logger } from "../../log"
import type { MarketHub } from "../../market/hub"
import type { MinuteBar } from "../../venues/kraken/ws"
import { AnomalyDetector, type AnomalySignal } from "../anomaly"
import type { Emit, RawItem, SourceSpec, WireSource } from "../types"

/**
 * Our own market data as news (MASTER_PLAN §3.6, crypto):
 *   - `anomaly`: Kraken 1-minute bars for the universe → idiosyncratic price shocks (residual vs
 *     BTC), volume shocks, and BTC's own 5-minute move as the market-wide shock;
 *   - depeg: USDT/USD and USDC/USD tickers (data only, never tradable) off $1 by `depeg_pct`.
 *
 * It warms up from 720 REST bars per pair on start, so signals are live within a minute of a
 * restart, and signals from that history are never emitted. The anomaly detector also tells the
 * wire which symbols just moved, which raises the severity of news about them.
 */

export const REFERENCE = "BTC/USD"
export const STABLES = ["USDT/USD", "USDC/USD"]

/** Bars for one minute wait this long for BTC's bar (the residual reference) before scoring anyway. */
const FLUSH_MS = 20_000

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0) as -1 | 0 | 1
const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`

/** Item for an anomaly signal. Price shocks scale their base with z (55 at the threshold, up to 88). */
export const signalItem = (s: AnomalySignal, threshold: number): RawItem => {
  const scale = Math.min(1.6, Math.max(1, Math.abs(s.z) / threshold))
  const minute = new Date(s.at).toISOString().slice(0, 16)
  if (s.kind === "market") {
    return {
      sourceId: `market:${minute}`,
      title: `Market-wide move: ${s.symbol} ${fmtPct(s.ret_pct)} in ${s.window_min} min (z ${s.z})`,
      kind: "anomaly",
      category: "price_shock",
      tier: 1,
      symbols: [],
      marketWide: true,
      polarity: sign(s.ret_pct),
      baseSeverity: Math.round(55 * scale),
      publishedAt: new Date(s.at + 60_000),
      meta: { anomaly: "market", reference: s.symbol, z: s.z, window_min: s.window_min, ret_pct: s.ret_pct },
    }
  }
  if (s.kind === "price") {
    return {
      sourceId: `price:${s.symbol}:${minute}`,
      title: `${s.symbol} ${fmtPct(s.ret_pct)} in ${s.window_min} min (z ${s.z} after removing BTC's move)`,
      kind: "anomaly",
      category: "price_shock",
      tier: 1,
      symbols: [s.symbol],
      polarity: sign(s.ret_pct),
      baseSeverity: Math.round(55 * scale),
      publishedAt: new Date(s.at + 60_000),
      meta: { anomaly: "price", z: s.z, window_min: s.window_min, ret_pct: s.ret_pct },
    }
  }
  return {
    sourceId: `volume:${s.symbol}:${minute}`,
    title: `${s.symbol} traded ${s.volume_multiple}× its median 1-minute volume (${fmtPct(s.ret_pct)})`,
    kind: "anomaly",
    category: "volume_shock",
    tier: 1,
    symbols: [s.symbol],
    polarity: 0,
    publishedAt: new Date(s.at + 60_000),
    meta: { anomaly: "volume", volume_multiple: s.volume_multiple, ret_pct: s.ret_pct },
  }
}

export class KrakenMarketSignals implements WireSource {
  readonly id = "anomaly"
  readonly tier = 1 as const
  readonly detector: AnomalyDetector
  private emit: Emit | null = null
  private hooked = false
  private lastBarAt: number | null = null
  private lastItemAt: Date | null = null
  private lastError: string | null = null
  private readonly pending = new Map<number, MinuteBar[]>()
  private readonly flushTimers = new Map<number, NodeJS.Timeout>()
  private readonly depegArmed = new Map<string, boolean>()
  private depegTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly hub: MarketHub,
    private readonly settings: () => Settings,
    private readonly log: Logger,
    /** Lets the wire raise the severity of news about a symbol that just moved. */
    private readonly onAnomaly: (symbol: string, kind: "price" | "volume") => void,
  ) {
    this.detector = new AnomalyDetector(REFERENCE, () => {
      const a = this.settings().wire.anomaly
      return { priceZ: a.price_z, volumeMultiple: a.volume_multiple, marketZ: a.market_z }
    })
  }

  /** The catalog entry, so the wire runs and reports it like any other source. */
  spec(): SourceSpec {
    return { id: this.id, kind: "custom", interval_s: 60, tier: 1, wire_kind: "anomaly", default_enabled: true, create: () => this, note: "Kraken 1-minute bars and stablecoin tickers" }
  }

  start(emit: Emit) {
    this.emit = emit
    if (!this.hooked) {
      this.hooked = true
      this.hub.setDataSymbols(STABLES)
      this.hub.onBar((bar) => this.onBar(bar))
    }
    if (!this.depegTimer) this.depegTimer = setInterval(() => void this.checkDepeg().catch((e) => (this.lastError = errorMessage(e))), 30_000)
    void this.warmUp().catch((e) => {
      this.lastError = `warm-up failed: ${errorMessage(e)}`
      this.log.warn("anomaly warm-up failed", { error: errorMessage(e) })
    })
  }

  stop() {
    this.emit = null
    if (this.depegTimer) clearInterval(this.depegTimer)
    this.depegTimer = null
    for (const t of this.flushTimers.values()) clearTimeout(t)
    this.flushTimers.clear()
  }

  /** 720 REST bars per pair, reference first, fed before any live bar for that pair is scored. */
  private async warmUp() {
    const symbols = [REFERENCE, ...this.hub.universe.filter((s) => s !== REFERENCE)]
    for (const symbol of symbols) {
      if (this.detector.barCount(symbol) >= 120) continue
      const bars = await this.hub.minuteHistory(symbol)
      this.detector.backfill(symbol, bars.map((b) => ({ t: b.t, close: b.close, volume: b.volume })))
    }
    this.log.info("anomaly detector warmed up", { symbols: symbols.length, bars: this.detector.barCount(REFERENCE) })
  }

  private onBar(bar: MinuteBar) {
    this.lastBarAt = Date.now()
    const list = this.pending.get(bar.t) ?? []
    list.push(bar)
    this.pending.set(bar.t, list)
    if (bar.symbol === REFERENCE) this.flush(bar.t)
    else if (!this.flushTimers.has(bar.t)) this.flushTimers.set(bar.t, setTimeout(() => this.flush(bar.t), FLUSH_MS))
  }

  /** Scores one minute's bars, reference first. Bars that arrive after their minute was flushed are scored alone. */
  private flush(t: number) {
    const timer = this.flushTimers.get(t)
    if (timer) clearTimeout(timer)
    this.flushTimers.delete(t)
    const bars = (this.pending.get(t) ?? []).sort((a, b) => (a.symbol === REFERENCE ? -1 : b.symbol === REFERENCE ? 1 : 0))
    this.pending.delete(t)
    const items: RawItem[] = []
    const a = this.settings().wire.anomaly
    for (const bar of bars) {
      for (const s of this.detector.addBar(bar.symbol, { t: bar.t, close: bar.close, volume: bar.volume })) {
        if (s.kind === "price" || s.kind === "market") this.onAnomaly(s.symbol, "price")
        else this.onAnomaly(s.symbol, "volume")
        items.push(signalItem(s, s.kind === "market" ? a.market_z : a.price_z))
      }
    }
    if (items.length) void this.push(items)
  }

  private async push(items: RawItem[]) {
    if (!this.emit) return
    this.lastItemAt = new Date()
    await this.emit(items).catch((e) => this.log.warn("anomaly items failed", { error: errorMessage(e) }))
  }

  private async checkDepeg() {
    const threshold = this.settings().wire.depeg_pct
    const items: RawItem[] = []
    for (const symbol of STABLES) {
      const t = this.hub.dataTicker(symbol)
      if (!t || Date.now() - t.at > 5 * 60_000) continue
      const mid = (t.bid + t.ask) / 2
      const offPct = (mid - 1) * 100
      const armed = this.depegArmed.get(symbol) ?? true
      if (Math.abs(offPct) >= threshold && armed) {
        this.depegArmed.set(symbol, false)
        items.push({
          sourceId: `depeg:${symbol}:${new Date().toISOString().slice(0, 16)}`,
          title: `${symbol.split("/")[0]} at $${mid.toFixed(4)}, ${fmtPct(offPct)} off its $1 peg`,
          kind: "anomaly",
          category: "depeg",
          tier: 1,
          symbols: [],
          marketWide: true,
          polarity: -1,
          meta: { stablecoin: symbol, mid, off_pct: Math.round(offPct * 1000) / 1000 },
        })
      } else if (Math.abs(offPct) < threshold / 2) {
        this.depegArmed.set(symbol, true)
      }
    }
    if (items.length) await this.push(items)
  }

  health(): WireSourceHealth {
    const fresh = this.lastBarAt !== null && Date.now() - this.lastBarAt < 5 * 60_000
    return {
      id: this.id,
      state: !this.emit ? "disabled" : fresh ? "ok" : this.lastBarAt === null ? "starting" : "degraded",
      last_item_at: this.lastItemAt,
      last_ok_at: this.lastBarAt ? new Date(this.lastBarAt) : null,
      last_error: this.lastError,
      items_24h: 0,
      dropped_24h: 0,
      lag_s: null,
    }
  }
}
