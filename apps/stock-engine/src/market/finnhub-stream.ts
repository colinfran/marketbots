import WebSocket from "ws"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { backoffMs } from "@mb/engine-kit/util/async"

/**
 * Layer D of the stock price coverage (MASTER_PLAN §3.13): Finnhub's trade WebSocket (free key).
 * The free plan takes 50 symbols per connection (checked 2026-10-26: the 51st gets "Subscribing
 * to too many symbols"), so it carries the news engine's focus and the top of the watchlist, in
 * that order. Consolidated trades, tick by tick; a backup when Yahoo throttles.
 */

export const FINNHUB_MAX_SYMBOLS = 50

export type FinnhubTrade = { symbol: string; price: number; at: number; volume: number }

type Message = { type: string; msg?: string; data?: { s: string; p: number; t: number; v: number }[] }

export type FinnhubHealth = { state: "connected" | "connecting" | "disconnected" | "disabled"; symbols: number; last_message_at: number | null; last_error: string | null }

export class FinnhubStream {
  private ws: WebSocket | null = null
  private wanted: string[] = []
  private subscribed = new Set<string>()
  private stopped = true
  private attempt = 0
  private timer: NodeJS.Timeout | null = null
  private lastMessageAt: number | null = null
  private lastError: string | null = null

  constructor(
    private readonly token: string | undefined,
    private readonly log: Logger,
    private readonly onTrade: (trade: FinnhubTrade) => void,
    private readonly url = "wss://ws.finnhub.io",
  ) {}

  start() {
    if (!this.stopped || !this.token) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  /** Most important first; anything past the free limit is left out. */
  setSymbols(symbols: string[]) {
    this.wanted = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, FINNHUB_MAX_SYMBOLS)
    this.sync()
  }

  health(): FinnhubHealth {
    if (!this.token) return { state: "disabled", symbols: 0, last_message_at: null, last_error: "FINNHUB_API_KEY not set" }
    return {
      state: !this.ws ? "disconnected" : this.ws.readyState === WebSocket.OPEN ? "connected" : "connecting",
      symbols: this.subscribed.size,
      last_message_at: this.lastMessageAt,
      last_error: this.lastError,
    }
  }

  private sync() {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const want = new Set(this.wanted)
    // Unsubscribe first so the count never passes the limit.
    for (const s of [...this.subscribed].filter((x) => !want.has(x))) {
      ws.send(JSON.stringify({ type: "unsubscribe", symbol: s }))
      this.subscribed.delete(s)
    }
    for (const s of this.wanted.filter((x) => !this.subscribed.has(x))) {
      ws.send(JSON.stringify({ type: "subscribe", symbol: s }))
      this.subscribed.add(s)
    }
  }

  private connect() {
    this.subscribed = new Set()
    const ws = new WebSocket(`${this.url}?token=${encodeURIComponent(this.token!)}`)
    this.ws = ws
    ws.on("open", () => {
      this.attempt = 0
      this.sync()
    })
    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now()
      let m: Message
      try {
        m = JSON.parse(raw.toString()) as Message
      } catch {
        return
      }
      if (m.type === "trade") for (const d of m.data ?? []) if (d.p > 0) this.onTrade({ symbol: d.s, price: d.p, at: d.t, volume: d.v })
      if (m.type === "error") this.lastError = (m.msg ?? "error").slice(0, 200)
    })
    ws.on("error", (error) => {
      this.lastError = errorMessage(error).slice(0, 200)
      this.log.debug("finnhub stream error", { error: this.lastError })
    })
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null
      this.subscribed = new Set()
      if (this.stopped) return
      this.attempt += 1
      this.timer = setTimeout(() => this.connect(), Math.max(2_000, backoffMs(this.attempt, 2_000, 120_000)))
    })
  }
}
