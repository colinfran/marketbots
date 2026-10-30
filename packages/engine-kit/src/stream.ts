import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { clientFrameSchema, eventForViewer, STREAM_PROTOCOL_VERSION, type EngineEvent, type EventVisibility, type ServerFrame } from "@mb/core/events"
import type { TokenCheck } from "@mb/core/stream-token"
import { WebSocketServer, type WebSocket } from "ws"
import type { EventBus } from "./bus"
import { errorMessage, type Logger } from "./log"

/**
 * The engine's only network listener. It serves:
 *   GET /healthz      liveness for Docker (no details)
 *   GET /readyz       200 once the engine is trading-ready, else 503
 *   WS  /v1/stream    the authenticated, read-only live event stream
 *
 * There are no control endpoints: commands go through MongoDB. Put it behind your reverse proxy
 * (TLS) and publish only this port.
 *
 * Connection protocol:
 *   1. client connects; within 5s it sends {"type":"auth","token":…,"since":<seq>?}
 *   2. server answers "hello", replays events after `since` (or recent history), then "replay_done"
 *   3. live events follow; the server pings every 15s and drops clients that stop answering
 * Public viewers never receive owner-only events (commands, errors, reconciliation details).
 */

type Client<M> = { ws: WebSocket; scope: EventVisibility; alive: boolean; ip: string; replaying: boolean; queue: EngineEvent<M>[] }

const AUTH_TIMEOUT_MS = 5_000
const PING_MS = 15_000
const MAX_BUFFERED_BYTES = 2_000_000
const MAX_CONNECTIONS_PER_IP = 10
const MAX_SESSION_MS = 12 * 3_600_000

export type StreamServerOptions = {
  host: string
  port: number
  secret: string
  allowedOrigins: string[]
  trustProxy: boolean
  maxClients: number
  ready: () => boolean
}

/** What the server needs from the bot: its stream-token check (bound to its HMAC prefix) and its owner-only events. */
export type StreamBinding<M> = {
  verifyToken: (token: string, secret: string) => TokenCheck
  ownerOnly: ReadonlySet<keyof M & string>
}

export class StreamServer<M> {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private readonly clients = new Set<Client<M>>()
  private pingTimer: NodeJS.Timeout | null = null
  private unsubscribe: (() => void) | null = null
  private snapshot: (() => EngineEvent<M>[]) | null = null

  constructor(
    private readonly bus: Pick<EventBus<M>, "subscribe" | "replay" | "lastSeq">,
    private readonly log: Logger,
    private readonly opts: StreamServerOptions,
    private readonly bot: StreamBinding<M>,
  ) {}

  get clientCount() {
    return this.clients.size
  }

  /** Live state no replay holds (the model calls running now and their text so far), sent to each viewer after its replay. */
  setSnapshot(fn: () => EngineEvent<M>[]) {
    this.snapshot = fn
  }

  get address() {
    const a = this.http?.address()
    return typeof a === "object" && a ? a : null
  }

  async start() {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4_096 })
    this.http = createServer((req, res) => this.onRequest(req, res))
    this.http.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket as Socket, head))
    this.unsubscribe = this.bus.subscribe((event) => this.broadcast(event))
    this.pingTimer = setInterval(() => this.heartbeat(), PING_MS)
    await new Promise<void>((resolve) => this.http!.listen(this.opts.port, this.opts.host, resolve))
    this.log.info("stream server listening", { host: this.opts.host, port: this.address?.port })
  }

  async stop() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.unsubscribe?.()
    for (const c of this.clients) c.ws.close(1001, "engine shutting down")
    this.clients.clear()
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()))
    this.wss?.close()
  }

  private ipOf(req: IncomingMessage) {
    const forwarded = this.opts.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : ""
    return forwarded || req.socket.remoteAddress || "unknown"
  }

  private onRequest(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? "/").split("?")[0]
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end('{"ok":true}')
    } else if (req.method === "GET" && path === "/readyz") {
      const ready = this.opts.ready()
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ ready }))
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found")
    }
  }

  private reject(socket: Socket, status: number, message: string) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    const path = (req.url ?? "/").split("?")[0]
    if (path !== "/v1/stream") return this.reject(socket, 404, "Not Found")
    // Browsers always send Origin; refusing unknown origins stops other sites from embedding the stream.
    const origin = String(req.headers.origin ?? "").replace(/\/$/, "")
    if (this.opts.allowedOrigins.length && origin && !this.opts.allowedOrigins.includes(origin)) return this.reject(socket, 403, "Forbidden")
    if (this.clients.size >= this.opts.maxClients) return this.reject(socket, 503, "Service Unavailable")
    const ip = this.ipOf(req)
    if ([...this.clients].filter((c) => c.ip === ip).length >= MAX_CONNECTIONS_PER_IP) return this.reject(socket, 429, "Too Many Requests")
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip))
  }

  private send(client: Client<M>, frame: ServerFrame<EngineEvent<M>>) {
    if (client.ws.readyState !== client.ws.OPEN) return
    client.ws.send(JSON.stringify(frame))
  }

  /** The event as this client may see it, or null when it is owner-only. */
  private shown(event: EngineEvent<M>, scope: EventVisibility) {
    return eventForViewer(event as EngineEvent<M> & { type: string }, scope, this.bot.ownerOnly)
  }

  private onConnection(ws: WebSocket, ip: string) {
    let client: Client<M> | null = null
    const authTimer = setTimeout(() => {
      if (!client) ws.close(4001, "auth timeout")
    }, AUTH_TIMEOUT_MS)
    const sessionTimer = setTimeout(() => ws.close(4002, "session expired; reconnect"), MAX_SESSION_MS)

    ws.on("message", async (raw) => {
      let frame
      try {
        frame = clientFrameSchema.parse(JSON.parse(raw.toString()))
      } catch {
        ws.close(4000, "bad frame")
        return
      }
      if (frame.type === "pong") {
        if (client) client.alive = true
        return
      }
      if (client) return // already authenticated; ignore repeated auth
      const check = this.bot.verifyToken(frame.token, this.opts.secret)
      if (!check.ok) {
        ws.close(4003, `auth failed: ${check.reason}`)
        return
      }
      clearTimeout(authTimer)
      client = { ws, scope: check.payload.scope, alive: true, ip, replaying: true, queue: [] }
      this.clients.add(client)
      this.send(client, { type: "hello", protocol: STREAM_PROTOCOL_VERSION, scope: client.scope, server_time: new Date().toISOString(), last_seq: this.bus.lastSeq })
      try {
        const { events, truncated } = await this.bus.replay(frame.since)
        for (const e of events) {
          const shown = this.shown(e, client.scope)
          if (shown) this.send(client, { type: "event", event: shown })
        }
        // Events that arrived during the replay, in order, without duplicates.
        const lastReplayed = events.at(-1)?.seq ?? frame.since ?? 0
        for (const e of client.queue) if (e.seq === 0 || e.seq > lastReplayed) this.deliver(client, e)
        for (const e of this.snapshot?.() ?? []) this.deliver(client, e)
        this.send(client, { type: "replay_done", last_seq: this.bus.lastSeq, truncated })
      } catch (error) {
        this.log.warn("stream replay failed", { error: errorMessage(error) })
        this.send(client, { type: "error", code: "replay_failed", message: "history unavailable; showing live events only" })
      } finally {
        client.replaying = false
        client.queue = []
      }
    })
    // Browsers answer protocol-level pings automatically; either kind of pong proves liveness.
    ws.on("pong", () => {
      if (client) client.alive = true
    })
    ws.on("close", () => {
      clearTimeout(authTimer)
      clearTimeout(sessionTimer)
      if (client) this.clients.delete(client)
    })
    ws.on("error", (error) => this.log.debug("stream client error", { error: errorMessage(error) }))
  }

  private deliver(client: Client<M>, event: EngineEvent<M>) {
    const shown = this.shown(event, client.scope)
    if (!shown) return
    // A slow client gets high-frequency events dropped first, then is disconnected.
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      if (event.seq === 0) return
      client.ws.close(4008, "client too slow")
      return
    }
    this.send(client, { type: "event", event: shown })
  }

  private broadcast(event: EngineEvent<M>) {
    for (const client of this.clients) {
      if (client.replaying) client.queue.push(event)
      else this.deliver(client, event)
    }
  }

  private heartbeat() {
    for (const client of this.clients) {
      if (!client.alive) {
        client.ws.terminate()
        this.clients.delete(client)
        continue
      }
      client.alive = false
      client.ws.ping()
      this.send(client, { type: "ping", t: Date.now() })
    }
  }
}
