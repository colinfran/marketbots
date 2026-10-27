import type { StreamHealth } from "@mb/stock-core/db"
import WebSocket from "ws"
import { errorMessage, type Logger } from "../log"
import { backoffMs } from "../util/async"
import type { AlpacaCredentials } from "./client"

/**
 * Alpaca's real-time stock market data stream (IEX on the free plan): trades and quotes for the
 * symbols the engine cares about right now (held stocks, option underlyings, the watchlist and
 * the main index ETFs). The free plan allows one connection and a limited number of symbols, so
 * the engine subscribes only to its most important ones (settings.universe.stream_max_symbols).
 */

/** A closed 1-minute IEX bar (start time in ms). */
export type MinuteBar = { symbol: string; t: number; open: number; high: number; low: number; close: number; volume: number }

export type MarketHandlers = {
  onTrade: (symbol: string, price: number, at: number) => void
  onQuote: (symbol: string, bid: number, ask: number, at: number) => void
  onState?: (connected: boolean, reason: string) => void
  /** 1-minute bars for every symbol on IEX (`bars: ["*"]`), for the news engine's breadth scan. */
  onBar?: (bar: MinuteBar) => void
}

type DataMessage = { T: string; S?: string; p?: number; bp?: number; ap?: number; t?: string; msg?: string; code?: number; o?: number; h?: number; l?: number; c?: number; v?: number }

export class MarketStream {
  health: StreamHealth = { state: "disconnected", last_message_at: null, last_error: null }
  private ws: WebSocket | null = null
  private authed = false
  private wanted = new Set<string>()
  private subscribed = new Set<string>()
  private attempt = 0
  private timer: NodeJS.Timeout | null = null
  private stopped = true
  /** Off for good once Alpaca rejects the all-symbols bar subscription on this plan. */
  barsRejected = false
  private barsSent = false
  barsSubscribed = false
  lastBarAt: number | null = null

  constructor(
    private readonly creds: AlpacaCredentials,
    private readonly log: Logger,
    private readonly handlers: MarketHandlers,
    private readonly url = `wss://stream.data.alpaca.markets/v2/${creds.feed ?? "iex"}`,
  ) {}

  get symbols() {
    return [...this.subscribed]
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
    this.health = { ...this.health, state: "disconnected" }
  }

  /** Replaces the subscription set (subscribes the new symbols, unsubscribes the dropped ones). */
  setSymbols(symbols: string[]) {
    this.wanted = new Set(symbols.map((s) => s.toUpperCase()))
    this.sync()
  }

  private sync() {
    const ws = this.ws
    if (!ws || !this.authed || ws.readyState !== WebSocket.OPEN) return
    const add = [...this.wanted].filter((s) => !this.subscribed.has(s))
    const remove = [...this.subscribed].filter((s) => !this.wanted.has(s))
    if (remove.length) ws.send(JSON.stringify({ action: "unsubscribe", trades: remove, quotes: remove }))
    if (add.length) ws.send(JSON.stringify({ action: "subscribe", trades: add, quotes: add }))
    // Minute bars for every symbol, sent on their own so a rejection can't touch trades and quotes.
    if (this.handlers.onBar && !this.barsRejected && !this.barsSent) {
      this.barsSent = true
      ws.send(JSON.stringify({ action: "subscribe", bars: ["*"] }))
    }
  }

  private connect() {
    this.health = { ...this.health, state: "connecting" }
    this.authed = false
    this.subscribed = new Set()
    this.barsSent = false
    this.barsSubscribed = false
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.on("message", (raw) => this.onMessage(ws, raw))
    ws.on("error", (error) => {
      this.health = { ...this.health, last_error: errorMessage(error) }
      this.log.debug("market data stream error", { error: errorMessage(error) })
    })
    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = null
      const wasConnected = this.health.state === "connected"
      this.authed = false
      this.subscribed = new Set()
      this.health = { ...this.health, state: "disconnected" }
      if (wasConnected) this.handlers.onState?.(false, `closed (${code})`)
      if (this.stopped) return
      this.attempt += 1
      // A "connection limit exceeded" means another client holds the plan's only connection: back off longer.
      const limited = /connection limit/i.test(this.health.last_error ?? "")
      this.timer = setTimeout(() => this.connect(), limited ? 60_000 : Math.max(1_000, backoffMs(this.attempt, 1_000, 60_000)))
    })
  }

  private onMessage(ws: WebSocket, raw: WebSocket.RawData) {
    this.health = { ...this.health, last_message_at: new Date() }
    let messages: DataMessage[]
    try {
      const parsed = JSON.parse(raw.toString())
      messages = Array.isArray(parsed) ? parsed : [parsed]
    } catch {
      return
    }
    for (const m of messages) {
      if (m.T === "b" && m.S && typeof m.c === "number" && m.t) {
        this.lastBarAt = Date.now()
        this.handlers.onBar?.({ symbol: m.S, t: Date.parse(m.t), open: m.o ?? m.c, high: m.h ?? m.c, low: m.l ?? m.c, close: m.c, volume: m.v ?? 0 })
      } else if (m.T === "t" && m.S && typeof m.p === "number") this.handlers.onTrade(m.S, m.p, m.t ? Date.parse(m.t) : Date.now())
      else if (m.T === "q" && m.S && typeof m.bp === "number" && typeof m.ap === "number") this.handlers.onQuote(m.S, m.bp, m.ap, m.t ? Date.parse(m.t) : Date.now())
      else if (m.T === "success" && m.msg === "connected") ws.send(JSON.stringify({ action: "auth", key: this.creds.keyId, secret: this.creds.secret }))
      else if (m.T === "success" && m.msg === "authenticated") {
        this.authed = true
        this.attempt = 0
        this.health = { ...this.health, state: "connected", last_error: null }
        this.handlers.onState?.(true, "streaming prices")
        this.sync()
      } else if (m.T === "subscription") {
        const sub = m as unknown as { trades?: string[]; bars?: string[] }
        this.subscribed = new Set(sub.trades ?? [])
        this.barsSubscribed = (sub.bars ?? []).includes("*")
      } else if (m.T === "error") {
        const message = `${m.code ?? ""} ${m.msg ?? "error"}`.trim()
        this.health = { ...this.health, last_error: message }
        // A limit error right after the wildcard bar request means this plan doesn't allow it.
        if (this.barsSent && !this.barsSubscribed && (m.code === 405 || m.code === 409 || /limit|insufficient|not allowed/i.test(m.msg ?? ""))) {
          this.barsRejected = true
          this.log.warn("all-symbol minute bars rejected; breadth scan off", { message })
        } else this.log.warn("market data stream error", { message })
      }
    }
  }
}
