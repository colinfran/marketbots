import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { clientFrameSchema, eventForViewer, STREAM_PROTOCOL_VERSION, type EngineEvent, type EventVisibility, type ServerFrame } from "@mb/core/events"
import { REQUEST_HEADERS, type SignedRequest, type TokenCheck } from "@mb/core/stream-token"
import { BSON } from "mongodb"
import { WebSocketServer, type WebSocket } from "ws"
import type { EventBus } from "./bus"
import type { CommandProcessor } from "./commands"
import { errorMessage, type Logger } from "./log"

/**
 * The engine's only network listener. It serves:
 *   GET  /healthz            liveness for Docker (no details)
 *   GET  /readyz             200 once the engine is trading-ready, else 503
 *   WS   /v1/stream          the authenticated, read-only live event stream
 *   POST /v1/commands        an owner command from the dashboard's server: { id, actor, command } → 202
 *   GET  /v1/commands/<id>   that command's progress or outcome
 *   GET  /v1/status          the heartbeat's latest status, in relaxed Extended JSON (its dates stay dates)
 *
 * The /v1 HTTP endpoints answer only requests signed with the stream secret and the bot's request
 * prefix (@mb/core/stream-token `requestSignatures`); the browser never calls them. Put it behind
 * your reverse proxy (TLS) and publish only this port.
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
/** A command's body (a settings patch is the largest). */
const MAX_COMMAND_BYTES = 64 * 1024

const COMMAND_PATH = /^\/v1\/commands\/([\w-]{1,64})$/

export type StreamServerOptions = {
  host: string
  port: number
  secret: string
  allowedOrigins: string[]
  trustProxy: boolean
  maxClients: number
  ready: () => boolean
}

/** What the server needs from the bot: its stream-token and request checks (bound to its HMAC prefixes) and its owner-only events. */
export type StreamBinding<M> = {
  verifyToken: (token: string, secret: string) => TokenCheck
  verifyRequest: (secret: string, request: SignedRequest, headers: { timestamp: string | undefined; signature: string | undefined }) => boolean
  ownerOnly: ReadonlySet<keyof M & string>
}

/** The commands the server hands on: the engine's processor, once it exists. */
export type CommandIntake = Pick<CommandProcessor<{ type: string }>, "submit" | "status">

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body))

/** The request's body, or null past `max` bytes (the rest is read and dropped, so the answer still goes out). */
const readBody = (req: IncomingMessage, max: number) =>
  new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= max) chunks.push(chunk)
    })
    req.on("end", () => resolve(size > max ? null : Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

export class StreamServer<M> {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private readonly clients = new Set<Client<M>>()
  private pingTimer: NodeJS.Timeout | null = null
  private unsubscribe: (() => void) | null = null
  private snapshot: (() => EngineEvent<M>[]) | null = null
  private commands: CommandIntake | null = null
  private status: (() => object | null) | null = null

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

  /** Where the command endpoints hand commands (the engine's processor); until set, they answer 503. */
  setCommands(intake: CommandIntake) {
    this.commands = intake
  }

  /** Where GET /v1/status reads the heartbeat's latest status; until set, or before the first beat, it answers 503. */
  setStatus(latest: () => object | null) {
    this.status = latest
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
    } else if ((req.method === "POST" && path === "/v1/commands") || (req.method === "GET" && (COMMAND_PATH.test(path) || path === "/v1/status"))) {
      void this.onSigned(req, res, path).catch((error) => {
        this.log.warn("engine request failed", { path, error: errorMessage(error) })
        if (!res.headersSent) json(res, 500, { error: "internal error" })
      })
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found")
    }
  }

  /** The /v1 HTTP endpoints: signed requests from the dashboard's server only. */
  private async onSigned(req: IncomingMessage, res: ServerResponse, path: string) {
    const body = req.method === "POST" ? await readBody(req, MAX_COMMAND_BYTES) : ""
    if (body === null) return json(res, 413, { error: "request too large" })
    const header = (name: string) => {
      const v = req.headers[name]
      return Array.isArray(v) ? v[0] : v
    }
    const signed = this.bot.verifyRequest(this.opts.secret, { method: req.method ?? "", path, body }, { timestamp: header(REQUEST_HEADERS.timestamp), signature: header(REQUEST_HEADERS.signature) })
    if (!signed) return json(res, 401, { error: "unauthorized" })
    if (path === "/v1/status") {
      const status = this.status?.()
      if (!status) return json(res, 503, { error: "engine starting" })
      return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(BSON.EJSON.stringify(status, { relaxed: true }))
    }
    if (!this.commands) return json(res, 503, { error: "engine starting" })
    if (req.method === "GET") {
      const view = this.commands.status(COMMAND_PATH.exec(path)![1])
      return view ? json(res, 200, view) : json(res, 404, { error: "not found" })
    }
    type Submission = { id?: unknown; actor?: unknown; command?: unknown } | null
    let input: Submission
    try {
      input = JSON.parse(body) as Submission
    } catch {
      return json(res, 400, { error: "not JSON" })
    }
    const id = input?.id
    const actor = input?.actor
    if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id) || typeof actor !== "string" || !actor || actor.length > 64) return json(res, 400, { error: "id and actor required" })
    const outcome = this.commands.submit(id, input?.command, actor)
    return outcome.ok ? json(res, 202, { id }) : json(res, outcome.status, { error: outcome.error })
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
