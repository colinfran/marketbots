import type { Settings } from "@mb/crypto-core/settings"
import type { WireSourceHealth } from "@mb/crypto-core/wire"
import WebSocket from "ws"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { backoffMs } from "@mb/engine-kit/util/async"
import { crossingId, crossingMeta, MetricWatcher } from "@mb/wire/metrics"
import type { Emit, RawItem, SourceSpec, WireSource } from "../types"
import { signed } from "./common"

/**
 * The Coinbase premium (`coinbase_ws`): Coinbase Exchange's public
 * WebSocket ticker for BTC-USD and ETH-USD (no auth), compared every 30 s with Kraken's mid from
 * the market hub. Coinbase at least `coinbase_premium_pct` above (US buyers paying up) or below
 * Kraken for 5 minutes → a `coinbase_premium` item, which the policy only annotates.
 *
 * Like the Kraken socket it reconnects with jittered exponential backoff, and a silent connection
 * (no ticker or heartbeat for 30 s) is torn down and reopened. Health is "ok" while messages flow.
 */

export const COINBASE_WS_URL = "wss://ws-feed.exchange.coinbase.com"
const PRODUCTS: Record<string, string> = { "BTC-USD": "BTC/USD", "ETH-USD": "ETH/USD" }
const CHECK_MS = 30_000
/** A Coinbase quote older than this isn't compared. */
const STALE_MS = 30_000
const SILENCE_MS = 30_000
const SUSTAIN_MIN = 5

type CoinbaseMessage = { type?: string; product_id?: string; best_bid?: string; best_ask?: string; price?: string; message?: string; reason?: string }

export class CoinbasePremium implements WireSource {
  readonly id = "coinbase_ws"
  readonly tier = 1 as const
  private readonly watch = new MetricWatcher({ historyMs: 60 * 60_000 })
  private readonly mids = new Map<string, { mid: number; at: number }>()
  private socket: WebSocket | null = null
  private emit: Emit | null = null
  private stopped = true
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private lastMessageAt: number | null = null
  private lastItemAt: Date | null = null
  private lastError: string | null = null

  constructor(
    /** Kraken's live mid for a symbol, or null when there is no fresh quote. */
    private readonly krakenMid: (symbol: string) => number | null,
    private readonly settings: () => Settings,
    private readonly log: Logger,
    private readonly url = COINBASE_WS_URL,
  ) {}

  /** The catalog entry, so the wire runs and reports it like any other source. */
  spec(): SourceSpec {
    return { id: this.id, kind: "custom", interval_s: 30, tier: 1, wire_kind: "sentiment", default_enabled: true, create: () => this, note: "Coinbase Exchange public WebSocket ticker (BTC-USD, ETH-USD) vs Kraken: the Coinbase premium" }
  }

  start(emit: Emit, signal: AbortSignal) {
    this.emit = emit
    if (!this.stopped) return
    this.stopped = false
    signal.addEventListener("abort", () => this.stop(), { once: true })
    this.connect()
    this.checkTimer = setInterval(() => {
      try {
        void this.push(this.check())
      } catch (error) {
        this.lastError = errorMessage(error)
      }
    }, CHECK_MS)
  }

  stop() {
    this.stopped = true
    this.emit = null
    for (const t of [this.reconnectTimer, this.stableTimer]) if (t) clearTimeout(t)
    for (const t of [this.watchdog, this.checkTimer]) if (t) clearInterval(t)
    this.reconnectTimer = this.stableTimer = this.watchdog = this.checkTimer = null
    this.socket?.close(1000, "shutdown")
    this.socket = null
  }

  private connect() {
    if (this.stopped) return
    const socket = new WebSocket(this.url, { handshakeTimeout: 10_000 })
    this.socket = socket
    socket.on("open", () => {
      this.lastMessageAt = Date.now()
      socket.send(JSON.stringify({ type: "subscribe", product_ids: Object.keys(PRODUCTS), channels: ["ticker", "heartbeat"] }))
      // Only reset the backoff once the connection has proven stable.
      this.stableTimer = setTimeout(() => (this.attempt = 0), 60_000)
      this.watchdog = setInterval(() => {
        if (Date.now() - (this.lastMessageAt ?? 0) > SILENCE_MS) {
          this.log.warn("coinbase ws silent; reconnecting")
          socket.terminate()
        }
      }, 5_000)
    })
    socket.on("message", (raw) => this.handle(raw.toString()))
    socket.on("error", (error) => {
      this.lastError = errorMessage(error)
      this.log.debug("coinbase ws error", { error: this.lastError })
    })
    socket.on("close", (code) => {
      if (this.watchdog) clearInterval(this.watchdog)
      if (this.stableTimer) clearTimeout(this.stableTimer)
      this.watchdog = this.stableTimer = null
      // Quotes from a dead connection mustn't be compared.
      this.mids.clear()
      if (this.stopped) return
      this.attempt += 1
      this.lastError ??= `closed (code ${code})`
      this.reconnectTimer = setTimeout(() => this.connect(), Math.max(1_000, backoffMs(this.attempt, 1_000, 60_000)))
    })
  }

  /** One WebSocket message. Exposed for tests. */
  handle(raw: string, now = Date.now()) {
    let m: CoinbaseMessage
    try {
      m = JSON.parse(raw) as CoinbaseMessage
    } catch {
      return
    }
    this.lastMessageAt = now
    if (m.type === "error") {
      this.lastError = `${m.message ?? "error"}${m.reason ? `: ${m.reason}` : ""}`.slice(0, 300)
      return
    }
    if (m.type !== "ticker" || !m.product_id || !PRODUCTS[m.product_id]) return
    const bid = Number(m.best_bid)
    const ask = Number(m.best_ask)
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(m.price)
    if (Number.isFinite(mid) && mid > 0) {
      this.mids.set(m.product_id, { mid, at: now })
      this.lastError = null
    }
  }

  /** Compares each product with Kraken and returns items for sustained premiums. Exposed for tests. */
  check(now = Date.now()): RawItem[] {
    const threshold = this.settings().wire.coinbase_premium_pct
    const items: RawItem[] = []
    for (const [product, symbol] of Object.entries(PRODUCTS)) {
      const cb = this.mids.get(product)
      const kraken = this.krakenMid(symbol)
      if (!cb || now - cb.at > STALE_MS || kraken === null || !(kraken > 0)) continue
      const premium = (cb.mid / kraken - 1) * 100
      for (const c of this.watch.observe(`coinbase:premium:${symbol}`, premium, now, [{ id: "premium", kind: "level", abs: threshold, forMin: SUSTAIN_MIN }])) {
        items.push({
          sourceId: crossingId(c),
          title: `Coinbase ${c.value > 0 ? "premium" : "discount"} on ${symbol}: ${signed(c.value, 2)}% vs Kraken for ${SUSTAIN_MIN}+ min`,
          url: `https://exchange.coinbase.com/trade/${product}`,
          symbols: [symbol],
          category: "coinbase_premium",
          kind: "sentiment",
          tier: 1,
          // Coinbase above Kraken: US buyers paying up.
          polarity: c.value > 0 ? 1 : -1,
          publishedAt: new Date(now),
          meta: { ...crossingMeta(c), coinbase_mid: cb.mid, kraken_mid: kraken },
        })
      }
    }
    return items
  }

  private async push(items: RawItem[]) {
    if (!items.length || !this.emit) return
    this.lastItemAt = new Date()
    await this.emit(items).catch((e) => this.log.warn("coinbase premium items failed", { error: errorMessage(e) }))
  }

  health(): WireSourceHealth {
    const fresh = this.lastMessageAt !== null && Date.now() - this.lastMessageAt < 60_000
    return {
      id: this.id,
      state: !this.emit ? "disabled" : fresh ? "ok" : this.lastMessageAt === null ? "starting" : "degraded",
      last_item_at: this.lastItemAt,
      last_ok_at: this.lastMessageAt ? new Date(this.lastMessageAt) : null,
      last_error: this.lastError,
      items_24h: 0,
      dropped_24h: 0,
      lag_s: null,
    }
  }
}
