import WebSocket from "ws"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { backoffMs } from "@mb/engine-kit/util/async"

/**
 * Layer C of the stock price coverage (MASTER_PLAN §3.13): Yahoo Finance's streamer WebSocket, the
 * unofficial keyless feed yfinance uses. It streams consolidated prices tick by tick for every
 * symbol subscribed on one connection. Checked from the trading server on 2026-10-26: one
 * connection took 1,505 symbols, and each message is {"type":"pricing","message":<base64
 * PricingData protobuf>}.
 *
 * Unofficial, so nothing depends on it alone, and it never sets an order price. One connection,
 * subscribes in chunks, reconnects with backoff, and pauses for 15 minutes after repeated failures.
 */

export type YahooTick = { symbol: string; price: number; at: number; dayVolume: number | null }

const URL = "wss://streamer.finance.yahoo.com/?version=2"
const CHUNK = 250
const PAUSE_MS = 15 * 60_000
/** Connections in a row that closed without a single message before the long pause. */
const MAX_FAILURES = 5
/** In session, a connection this quiet is presumed dead and replaced. */
const IDLE_MS = 5 * 60_000

/** Alpaca writes class shares BRK.B, Yahoo BRK-B. */
export const toYahoo = (symbol: string) => symbol.replace(".", "-")

/**
 * The PricingData fields we use, read straight off the wire: 1 id (string), 2 price (float32),
 * 3 time (sint64 ms), 9 day volume (sint64). A full protobuf library isn't needed for four fields.
 */
export const decodePricing = (b64: string): Omit<YahooTick, "symbol"> & { id: string } | null => {
  const buf = Buffer.from(b64, "base64")
  let i = 0
  const varint = () => {
    let result = 0
    let mult = 1
    for (;;) {
      if (i >= buf.length) throw new Error("truncated varint")
      const b = buf[i++]
      result += (b & 0x7f) * mult
      if (b < 0x80) return result
      mult *= 128
    }
  }
  const zigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2)
  let id = ""
  let price = Number.NaN
  let at = Number.NaN
  let dayVolume: number | null = null
  try {
    while (i < buf.length) {
      const key = varint()
      const field = Math.floor(key / 8)
      const wire = key % 8
      if (wire === 0) {
        const v = varint()
        if (field === 3) at = zigzag(v)
        else if (field === 9) dayVolume = zigzag(v)
      } else if (wire === 1) i += 8
      else if (wire === 2) {
        const n = varint()
        if (field === 1) id = buf.toString("utf8", i, i + n)
        i += n
      } else if (wire === 5) {
        if (field === 2) price = buf.readFloatLE(i)
        i += 4
      } else return null
    }
  } catch {
    return null
  }
  if (!id || !(price > 0) || !Number.isFinite(at)) return null
  // float32 carries ~7 significant digits: round to the cent fraction it can represent.
  return { id, price: Math.round(price * 10_000) / 10_000, at, dayVolume }
}

export type YahooHealth = { state: "connected" | "connecting" | "disconnected" | "paused"; symbols: number; last_message_at: number | null; last_error: string | null; paused_until: number | null }

export class YahooStream {
  private ws: WebSocket | null = null
  private wanted = new Map<string, string>()
  private subscribed = new Set<string>()
  private stopped = true
  private attempt = 0
  private failures = 0
  private gotMessage = false
  private timer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private lastMessageAt: number | null = null
  private lastError: string | null = null
  private pausedUntil: number | null = null

  constructor(
    private readonly log: Logger,
    private readonly onTick: (tick: YahooTick) => void,
    /** Whether the market is in session (the idle watchdog only acts then). */
    private readonly active: () => boolean,
    private readonly url = URL,
  ) {}

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
    this.watchdog = setInterval(() => {
      if (this.ws && this.active() && this.lastMessageAt !== null && Date.now() - this.lastMessageAt > IDLE_MS) {
        this.lastError = "no messages for 5 minutes in session; reconnecting"
        this.ws.terminate()
      }
    }, 60_000)
    this.watchdog.unref()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.watchdog) clearInterval(this.watchdog)
    this.ws?.close()
    this.ws = null
  }

  /** Replaces the subscription set (Alpaca symbols). */
  setSymbols(symbols: string[]) {
    this.wanted = new Map(symbols.map((s) => [toYahoo(s.toUpperCase()), s.toUpperCase()]))
    this.sync()
  }

  health(): YahooHealth {
    const paused = this.pausedUntil !== null && Date.now() < this.pausedUntil
    return {
      state: paused ? "paused" : !this.ws ? "disconnected" : this.ws.readyState === WebSocket.OPEN ? "connected" : "connecting",
      symbols: this.subscribed.size,
      last_message_at: this.lastMessageAt,
      last_error: this.lastError,
      paused_until: paused ? this.pausedUntil : null,
    }
  }

  private sync() {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const add = [...this.wanted.keys()].filter((s) => !this.subscribed.has(s))
    const remove = [...this.subscribed].filter((s) => !this.wanted.has(s))
    for (let i = 0; i < remove.length; i += CHUNK) ws.send(JSON.stringify({ unsubscribe: remove.slice(i, i + CHUNK) }))
    for (let i = 0; i < add.length; i += CHUNK) ws.send(JSON.stringify({ subscribe: add.slice(i, i + CHUNK) }))
    for (const s of remove) this.subscribed.delete(s)
    for (const s of add) this.subscribed.add(s)
  }

  private connect() {
    this.subscribed = new Set()
    this.gotMessage = false
    const ws = new WebSocket(this.url, { headers: { origin: "https://finance.yahoo.com", "user-agent": "Mozilla/5.0" } })
    this.ws = ws
    ws.on("open", () => this.sync())
    ws.on("message", (raw) => this.onMessage(raw))
    ws.on("error", (error) => {
      this.lastError = errorMessage(error).slice(0, 200)
      this.log.debug("yahoo stream error", { error: this.lastError })
    })
    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = null
      this.subscribed = new Set()
      if (this.stopped) return
      this.failures = this.gotMessage ? 0 : this.failures + 1
      this.attempt = this.gotMessage ? 1 : this.attempt + 1
      let wait = Math.max(1_000, backoffMs(this.attempt, 1_000, 60_000))
      if (this.failures >= MAX_FAILURES) {
        this.failures = 0
        this.pausedUntil = Date.now() + PAUSE_MS
        wait = PAUSE_MS
        this.log.warn("yahoo stream keeps failing; pausing 15 min", { code, error: this.lastError })
      }
      this.timer = setTimeout(() => this.connect(), wait)
    })
  }

  private onMessage(raw: WebSocket.RawData) {
    this.lastMessageAt = Date.now()
    this.gotMessage = true
    this.pausedUntil = null
    let b64: string
    try {
      const text = raw.toString()
      b64 = text.startsWith("{") ? ((JSON.parse(text) as { message?: string }).message ?? "") : text
    } catch {
      return
    }
    const p = decodePricing(b64)
    if (!p) return
    const symbol = this.wanted.get(p.id)
    if (symbol) this.onTick({ symbol, price: p.price, at: p.at, dayVolume: p.dayVolume })
  }
}
