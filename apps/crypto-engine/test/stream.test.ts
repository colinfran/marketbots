import { signStreamToken } from "@mb/crypto-core/stream-token"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { silentLogger } from "../src/log"
import { StreamServer } from "../src/stream/server"
import { useTestDb } from "./helpers/db"
import { makeBus } from "./helpers/fakes"

const SECRET = "test-stream-secret-0123456789-abcdefghij"
const db = useTestDb()
let server: StreamServer | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

const start = async (allowedOrigins: string[] = []) => {
  const bus = await makeBus(db.col)
  server = new StreamServer(bus, silentLogger, { host: "127.0.0.1", port: 0, secret: SECRET, allowedOrigins, trustProxy: false, maxClients: 10, ready: () => true })
  await server.start()
  return { bus, url: `ws://127.0.0.1:${server.address!.port}/v1/stream`, base: `http://127.0.0.1:${server.address!.port}` }
}

/** Opens a socket, sends the auth frame, and collects frames until `until` matches. */
const connect = (url: string, auth: Record<string, unknown> | null, until: (frames: Record<string, unknown>[]) => boolean, headers: Record<string, string> = {}) =>
  new Promise<{ frames: Record<string, unknown>[]; close: number | null; ws: WebSocket }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    const frames: Record<string, unknown>[] = []
    const timer = setTimeout(() => resolve({ frames, close: null, ws }), 3_000)
    ws.on("open", () => auth && ws.send(JSON.stringify(auth)))
    ws.on("message", (raw) => {
      frames.push(JSON.parse(raw.toString()))
      if (until(frames)) {
        clearTimeout(timer)
        resolve({ frames, close: null, ws })
      }
    })
    ws.on("close", (code) => {
      clearTimeout(timer)
      resolve({ frames, close: code, ws })
    })
    ws.on("error", (e) => {
      clearTimeout(timer)
      if (!frames.length) resolve({ frames, close: -1, ws })
      else reject(e)
    })
  })

describe("StreamServer", () => {
  it("serves health checks without auth", async () => {
    const { base } = await start()
    // fetch is stubbed out in tests (no network), so use node:http for the local server.
    const http = await import("node:http")
    const status = await new Promise<number>((resolve) => http.get(`${base}/healthz`, (res) => resolve(res.statusCode ?? 0)))
    expect(status).toBe(200)
  })

  it("closes connections that send a bad token", async () => {
    const { url } = await start()
    const r = await connect(url, { type: "auth", token: "v1.bogus.token" }, () => false)
    expect(r.close).toBe(4003)
  })

  it("replays after `since`, then streams live events, hiding owner-only ones from the public", async () => {
    const { bus, url } = await start()
    const first = bus.emit("alert", { level: "info", title: "one", message: "1" }, { summary: "one" })
    bus.emit("alert", { level: "info", title: "two", message: "2" }, { summary: "two" })
    bus.emit("command.completed", { command_id: "c", type: "pause", result: "ok" }, { summary: "owner only", visibility: "owner" })
    const { token } = signStreamToken("public", SECRET)
    const r = await connect(url, { type: "auth", token, since: first.seq }, (f) => f.some((x) => x.type === "replay_done"))
    expect(r.frames[0]).toMatchObject({ type: "hello", scope: "public" })
    const events = r.frames.filter((f) => f.type === "event").map((f) => (f.event as { summary: string }).summary)
    expect(events).toEqual(["two"])
    const live = new Promise<string>((resolve) => r.ws.on("message", (raw) => {
      const f = JSON.parse(raw.toString())
      if (f.type === "event") resolve(f.event.summary)
    }))
    bus.emit("alert", { level: "info", title: "three", message: "3" }, { summary: "three" })
    expect(await live).toBe("three")
    r.ws.close()
  })

  it("gives owners the owner-only events", async () => {
    const { bus, url } = await start()
    bus.emit("command.completed", { command_id: "c", type: "pause", result: "ok" }, { summary: "owner only", visibility: "owner" })
    const { token } = signStreamToken("owner", SECRET)
    const r = await connect(url, { type: "auth", token }, (f) => f.some((x) => x.type === "replay_done"))
    expect(r.frames.some((f) => f.type === "event" && (f.event as { summary: string }).summary === "owner only")).toBe(true)
    r.ws.close()
  })

  it("rejects browsers from other origins", async () => {
    const { url } = await start(["https://dash.example.com"])
    const r = await connect(url, null, () => false, { Origin: "https://evil.example" })
    expect(r.close).toBe(-1)
  })
})
