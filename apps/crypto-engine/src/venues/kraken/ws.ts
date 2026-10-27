import WebSocket from "ws"
import { backoffMs } from "@mb/engine-kit/util/async"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { OrderBook, type Level } from "./book"
import type { PairInfo } from "./pairs"

/**
 * Kraken WebSocket v2 market data: ticker + order book for every symbol in the universe, plus
 * 1-minute OHLC bars for the news engine's anomaly detector, and ticker-only "data symbols"
 * (stablecoins watched for a depeg) that never enter the books, quotes or anything that trades.
 *
 * Resilience:
 * - reconnects with jittered exponential backoff and resubscribes everything;
 * - a watchdog drops the socket if nothing (not even Kraken's ~1s heartbeat) arrives for 15s;
 * - every book update is checked against Kraken's CRC32 checksum, and a mismatch resubscribes
 *   that symbol (until the fresh snapshot arrives, the book reads as stale and isn't traded on).
 */

export const KRAKEN_WS_URL = "wss://ws.kraken.com/v2"

export type TickerState = {
  symbol: string
  bid: number
  ask: number
  last: number
  volume: number
  vwap: number
  low: number
  high: number
  change_pct: number
  at: number
}

/** A closed 1-minute bar (interval start in ms). */
export type MinuteBar = { symbol: string; t: number; open: number; high: number; low: number; close: number; volume: number }

export type KrakenWsHandlers = {
  onTicker?: (ticker: TickerState) => void
  /** Ticker updates for data-only symbols. */
  onDataTicker?: (ticker: TickerState) => void
  /** Each 1-minute bar, once the next one starts. */
  onBar?: (bar: MinuteBar) => void
  onBook?: (book: OrderBook) => void
  onConnection?: (state: "connecting" | "connected" | "disconnected", reason?: string) => void
  onSymbolError?: (symbol: string, message: string) => void
}

type WsLevel = { price: number; qty: number }
type Message = {
  channel?: string
  type?: string
  method?: string
  success?: boolean
  error?: string
  symbol?: string
  result?: { channel?: string; symbol?: string }
  data?: Record<string, unknown>[]
}

const toLevels = (levels: unknown): Level[] =>
  Array.isArray(levels) ? (levels as WsLevel[]).filter((l) => Number.isFinite(l?.price) && Number.isFinite(l?.qty)).map((l) => ({ price: l.price, qty: l.qty })) : []

export class KrakenWs {
  readonly books = new Map<string, OrderBook>()
  readonly tickers = new Map<string, TickerState>()
  lastMessageAt = 0
  connected = false

  private socket: WebSocket | null = null
  private attempt = 0
  private stopped = true
  private watchdog: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private readonly lastResubscribe = new Map<string, number>()
  private readonly formingBars = new Map<string, MinuteBar>()
  private dataSymbols: string[] = []

  constructor(
    private symbols: string[],
    private readonly pairs: Map<string, PairInfo>,
    private readonly log: Logger,
    private readonly handlers: KrakenWsHandlers = {},
    private readonly depth: 10 | 25 | 100 = 25,
    private readonly url = KRAKEN_WS_URL,
  ) {}

  start() {
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    this.clearTimers()
    this.socket?.close(1000, "shutdown")
    this.socket = null
    this.connected = false
  }

  /** Changes the subscribed universe (e.g. after a settings update). */
  setSymbols(symbols: string[]) {
    const removed = this.symbols.filter((s) => !symbols.includes(s))
    const added = symbols.filter((s) => !this.symbols.includes(s))
    this.symbols = symbols
    for (const s of removed) {
      this.books.delete(s)
      this.tickers.delete(s)
      this.formingBars.delete(s)
    }
    if (this.connected) {
      if (removed.length) this.sendSubscriptions("unsubscribe", removed)
      if (added.length) this.sendSubscriptions("subscribe", added)
    }
  }

  /** Ticker-only symbols for data (never traded, never in `tickers` or `books`). */
  setDataSymbols(symbols: string[]) {
    const removed = this.dataSymbols.filter((s) => !symbols.includes(s))
    const added = symbols.filter((s) => !this.dataSymbols.includes(s))
    this.dataSymbols = symbols
    if (this.connected) {
      if (removed.length) this.send({ method: "unsubscribe", params: { channel: "ticker", symbol: removed } })
      if (added.length) this.send({ method: "subscribe", params: { channel: "ticker", symbol: added } })
    }
  }

  private clearTimers() {
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.watchdog = this.reconnectTimer = this.stableTimer = null
  }

  private connect() {
    if (this.stopped) return
    this.handlers.onConnection?.("connecting")
    const socket = new WebSocket(this.url, { handshakeTimeout: 10_000 })
    this.socket = socket

    socket.on("open", () => {
      this.connected = true
      this.lastMessageAt = Date.now()
      this.handlers.onConnection?.("connected")
      this.sendSubscriptions("subscribe", this.symbols)
      if (this.dataSymbols.length) this.send({ method: "subscribe", params: { channel: "ticker", symbol: this.dataSymbols } })
      // Only reset the backoff once the connection has proven stable.
      this.stableTimer = setTimeout(() => (this.attempt = 0), 60_000)
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastMessageAt > 15_000) {
          this.log.warn("kraken ws silent for 15s; reconnecting")
          socket.terminate()
        }
      }, 5_000)
    })
    socket.on("message", (raw) => this.handleMessage(raw.toString()))
    socket.on("error", (error) => this.log.warn("kraken ws error", { error: errorMessage(error) }))
    socket.on("close", (code, reason) => {
      this.connected = false
      this.clearTimers()
      // Books from a dead connection can't be trusted once updates stop.
      this.books.clear()
      this.handlers.onConnection?.("disconnected", `code ${code}${reason.length ? ` ${reason.toString()}` : ""}`)
      if (this.stopped) return
      this.attempt += 1
      const delay = Math.max(1_000, backoffMs(this.attempt, 1_000, 30_000))
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    })
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload))
  }

  private sendSubscriptions(method: "subscribe" | "unsubscribe", symbols: string[]) {
    if (!symbols.length) return
    this.send({ method, params: { channel: "ticker", symbol: symbols } })
    this.send({ method, params: { channel: "book", symbol: symbols, depth: this.depth } })
    this.send({ method, params: { channel: "ohlc", symbol: symbols, interval: 1, snapshot: false } })
  }

  private resubscribeBook(symbol: string) {
    const last = this.lastResubscribe.get(symbol) ?? 0
    if (Date.now() - last < 5_000) return
    this.lastResubscribe.set(symbol, Date.now())
    this.books.delete(symbol)
    this.send({ method: "unsubscribe", params: { channel: "book", symbol: [symbol], depth: this.depth } })
    this.send({ method: "subscribe", params: { channel: "book", symbol: [symbol], depth: this.depth } })
  }

  /** Public for tests: processes one raw frame. */
  handleMessage(raw: string) {
    this.lastMessageAt = Date.now()
    let msg: Message
    try {
      msg = JSON.parse(raw) as Message
    } catch {
      return
    }
    if (msg.method && msg.success === false) {
      const symbol = msg.symbol ?? msg.result?.symbol ?? "?"
      this.log.warn("kraken ws request rejected", { method: msg.method, symbol, error: msg.error })
      this.handlers.onSymbolError?.(symbol, msg.error ?? "rejected")
      return
    }
    if (msg.channel === "ticker" && Array.isArray(msg.data)) {
      for (const d of msg.data) this.onTicker(d)
    } else if (msg.channel === "book" && Array.isArray(msg.data)) {
      for (const d of msg.data) this.onBook(msg.type === "snapshot", d)
    } else if (msg.channel === "ohlc" && Array.isArray(msg.data)) {
      for (const d of msg.data) this.onOhlc(d)
    }
  }

  private onOhlc(d: Record<string, unknown>) {
    const symbol = String(d.symbol ?? "")
    if (!this.symbols.includes(symbol) || d.interval !== 1) return
    const t = Date.parse(String(d.interval_begin ?? ""))
    const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : Number.NaN)
    const bar: MinuteBar = { symbol, t, open: n("open"), high: n("high"), low: n("low"), close: n("close"), volume: n("volume") }
    if (!Number.isFinite(t) || !Number.isFinite(bar.close)) return
    const forming = this.formingBars.get(symbol)
    // A bar is final once the next minute's bar starts.
    if (forming && t > forming.t) this.handlers.onBar?.(forming)
    if (!forming || t >= forming.t) this.formingBars.set(symbol, bar)
  }

  private onTicker(d: Record<string, unknown>) {
    const symbol = String(d.symbol ?? "")
    const isData = this.dataSymbols.includes(symbol)
    if (!this.symbols.includes(symbol) && !isData) return
    const n = (k: string) => (typeof d[k] === "number" ? (d[k] as number) : Number.NaN)
    const ticker: TickerState = {
      symbol,
      bid: n("bid"),
      ask: n("ask"),
      last: n("last"),
      volume: n("volume"),
      vwap: n("vwap"),
      low: n("low"),
      high: n("high"),
      change_pct: n("change_pct"),
      at: Date.now(),
    }
    if (!Number.isFinite(ticker.bid) || !Number.isFinite(ticker.ask)) return
    if (isData) {
      this.handlers.onDataTicker?.(ticker)
      return
    }
    this.tickers.set(symbol, ticker)
    this.handlers.onTicker?.(ticker)
  }

  private onBook(isSnapshot: boolean, d: Record<string, unknown>) {
    const symbol = String(d.symbol ?? "")
    const pair = this.pairs.get(symbol)
    if (!pair || !this.symbols.includes(symbol)) return
    let book = this.books.get(symbol)
    if (isSnapshot || !book) {
      if (!isSnapshot) return // an update without a snapshot can't be applied
      book = new OrderBook(symbol, this.depth, pair.priceDecimals, pair.lotDecimals)
      this.books.set(symbol, book)
      book.snapshot(toLevels(d.asks), toLevels(d.bids))
    } else {
      book.update(toLevels(d.asks), toLevels(d.bids))
    }
    const checksum = typeof d.checksum === "number" ? d.checksum : undefined
    if (!book.verify(checksum)) {
      this.log.warn("kraken book checksum mismatch; resubscribing", { symbol })
      this.resubscribeBook(symbol)
      return
    }
    this.handlers.onBook?.(book)
  }
}
