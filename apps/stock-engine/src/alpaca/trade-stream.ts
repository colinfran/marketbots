import type { TradeUpdate } from "@mb/stock-core/alpaca"
import type { StreamHealth } from "@mb/stock-core/db"
import WebSocket from "ws"
import { errorMessage, type Logger } from "../log"
import { backoffMs } from "../util/async"
import type { AlpacaCredentials } from "./client"

/**
 * Alpaca's trade_updates stream: every order event on the paper account (accepted, filled,
 * partially filled, canceled, rejected, …) as it happens, including stop-loss and take-profit
 * legs that the broker triggers on its own. The paper endpoint sends JSON in binary frames.
 *
 * It only makes the books and the dashboard faster: the engine still syncs orders over REST every
 * minute, so a dropped connection never loses a fill.
 */

export const PAPER_STREAM_URL = "wss://paper-api.alpaca.markets/stream"

const PING_MS = 30_000

export class TradeStream {
  health: StreamHealth = { state: "disconnected", last_message_at: null, last_error: null }
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: NodeJS.Timeout | null = null
  private pinger: NodeJS.Timeout | null = null
  private alive = true
  private stopped = true

  constructor(
    private readonly creds: AlpacaCredentials,
    private readonly log: Logger,
    private readonly handlers: { onUpdate: (update: TradeUpdate) => void; onState?: (connected: boolean, reason: string) => void },
    private readonly url = PAPER_STREAM_URL,
  ) {}

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.pinger) clearInterval(this.pinger)
    this.ws?.close()
    this.ws = null
    this.health = { ...this.health, state: "disconnected" }
  }

  private connect() {
    this.health = { ...this.health, state: "connecting" }
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.on("open", () => ws.send(JSON.stringify({ action: "auth", key: this.creds.keyId, secret: this.creds.secret })))
    ws.on("message", (raw) => this.onMessage(ws, raw))
    ws.on("pong", () => (this.alive = true))
    ws.on("error", (error) => {
      this.health = { ...this.health, last_error: errorMessage(error) }
      this.log.debug("trade stream error", { error: errorMessage(error) })
    })
    ws.on("close", (code, reason) => {
      if (this.pinger) clearInterval(this.pinger)
      if (this.ws === ws) this.ws = null
      const wasConnected = this.health.state === "connected"
      this.health = { ...this.health, state: "disconnected" }
      if (wasConnected) this.handlers.onState?.(false, `closed (${code}${reason.length ? ` ${reason.toString()}` : ""})`)
      if (this.stopped) return
      this.attempt += 1
      this.timer = setTimeout(() => this.connect(), Math.max(1_000, backoffMs(this.attempt, 1_000, 60_000)))
    })
  }

  private onMessage(ws: WebSocket, raw: WebSocket.RawData) {
    this.health = { ...this.health, last_message_at: new Date() }
    let msg: { stream?: string; data?: Record<string, unknown> }
    try {
      msg = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw).toString("utf8"))
    } catch {
      return
    }
    if (msg.stream === "authorization") {
      if (msg.data?.status === "authorized") ws.send(JSON.stringify({ action: "listen", data: { streams: ["trade_updates"] } }))
      else {
        this.health = { ...this.health, last_error: "trade stream authorization failed (check the Alpaca keys)" }
        this.log.error("trade stream authorization failed")
        ws.close()
      }
    } else if (msg.stream === "listening") {
      this.attempt = 0
      this.health = { ...this.health, state: "connected", last_error: null }
      this.alive = true
      if (this.pinger) clearInterval(this.pinger)
      this.pinger = setInterval(() => {
        if (!this.alive) return ws.terminate()
        this.alive = false
        ws.ping()
      }, PING_MS)
      this.handlers.onState?.(true, "listening for trade updates")
    } else if (msg.stream === "trade_updates" && msg.data) {
      try {
        this.handlers.onUpdate(msg.data as unknown as TradeUpdate)
      } catch (error) {
        this.log.warn("handling a trade update failed", { error: errorMessage(error) })
      }
    }
  }
}
