import http from "node:http"
import { requestSignatures, streamTokens } from "@mb/core/stream-token"
import { BSON } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"
import { silentLogger } from "../src/log"
import { StreamServer, type CommandIntake } from "../src/stream"
import { makeTestBus } from "../src/testing/bus"
import { TEST_STREAM_SECRET as SECRET } from "../src/testing/env"
import { EPHEMERAL, OWNER_ONLY, useTestDb, type TestEvents } from "./helpers/bot"

// A bot's own tokens and requests: the server only accepts those signed with its HMAC prefixes.
const { sign: signStreamToken, verify: verifyToken } = streamTokens("test-stream.")
const { sign: signRequest, verify: verifyRequest } = requestSignatures("test-request.")
const db = useTestDb()
let server: StreamServer<TestEvents> | null = null

afterEach(async () => {
  await server?.stop()
  server = null
})

const start = async (allowedOrigins: string[] = []) => {
  const bus = await makeTestBus<TestEvents>(db.col, EPHEMERAL)
  server = new StreamServer(bus, silentLogger, { host: "127.0.0.1", port: 0, secret: SECRET, allowedOrigins, trustProxy: false, maxClients: 10, ready: () => true }, { verifyToken, verifyRequest, ownerOnly: OWNER_ONLY })
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

/** One HTTP request to the local server (fetch is stubbed out in tests). */
const call = (base: string, method: string, path: string, body = "", headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      let data = ""
      res.on("data", (chunk: Buffer) => (data += chunk.toString()))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }))
    })
    req.on("error", reject)
    req.end(body)
  })

/** A signed request, as the dashboard's server sends it. */
const signed = (base: string, method: string, path: string, body = "", { secret = SECRET, now = Date.now(), sign = signRequest } = {}) =>
  call(base, method, path, body, sign(secret, { method, path, body }, now))

describe("StreamServer command endpoints", () => {
  const intake = () => {
    const submit = vi.fn<CommandIntake["submit"]>(() => ({ ok: true }))
    const status = vi.fn<CommandIntake["status"]>((id) => (id === "c-1" ? { _id: "c-1", type: "pause", status: "done", result: "paused", error: null } : null))
    return { submit, status }
  }
  const body = JSON.stringify({ id: "c-1", actor: "owner", command: { type: "pause" } })

  it("takes a signed command and hands it to the engine, then answers its status", async () => {
    const { base } = await start()
    expect((await signed(base, "POST", "/v1/commands", body)).status).toBe(503)
    const commands = intake()
    server!.setCommands(commands)
    expect(await signed(base, "POST", "/v1/commands", body)).toEqual({ status: 202, body: { id: "c-1" } })
    expect(commands.submit).toHaveBeenCalledWith("c-1", { type: "pause" }, "owner")
    expect(await signed(base, "GET", "/v1/commands/c-1")).toEqual({ status: 200, body: { _id: "c-1", type: "pause", status: "done", result: "paused", error: null } })
    expect((await signed(base, "GET", "/v1/commands/c-2")).status).toBe(404)
  })

  it("answers nothing unsigned, signed for another bot, stale, or for another body", async () => {
    const { base } = await start()
    const commands = intake()
    server!.setCommands(commands)
    expect((await call(base, "POST", "/v1/commands", body)).status).toBe(401)
    expect((await call(base, "GET", "/v1/commands/c-1")).status).toBe(401)
    expect((await signed(base, "POST", "/v1/commands", body, { sign: requestSignatures("other-request.").sign })).status).toBe(401)
    expect((await signed(base, "POST", "/v1/commands", body, { now: Date.now() - 2 * 60_000 })).status).toBe(401)
    expect((await signed(base, "POST", "/v1/commands", body, { secret: "x".repeat(40) })).status).toBe(401)
    const headers = signRequest(SECRET, { method: "POST", path: "/v1/commands", body })
    expect((await call(base, "POST", "/v1/commands", body.replace("pause", "resume"), headers)).status).toBe(401)
    expect(commands.submit).not.toHaveBeenCalled()
  })

  it("passes on the engine's refusal, and refuses a body that isn't a command", async () => {
    const { base } = await start()
    const commands = intake()
    commands.submit.mockReturnValueOnce({ ok: false, status: 400, error: "type: Invalid input" })
    server!.setCommands(commands)
    expect(await signed(base, "POST", "/v1/commands", body)).toEqual({ status: 400, body: { error: "type: Invalid input" } })
    expect((await signed(base, "POST", "/v1/commands", "{not json")).status).toBe(400)
    expect((await signed(base, "POST", "/v1/commands", JSON.stringify({ id: "../x", actor: "owner", command: { type: "pause" } }))).status).toBe(400)
    expect((await signed(base, "POST", "/v1/commands", JSON.stringify({ id: "c-9", actor: "owner", command: { type: "pause" }, pad: "x".repeat(70_000) }))).status).toBe(413)
  })
})

describe("StreamServer status endpoint", () => {
  it("serves the latest status signed only, in Extended JSON that keeps its dates, and 503 before the first beat", async () => {
    const { base } = await start()
    expect((await signed(base, "GET", "/v1/status")).status).toBe(503)
    let latest: object | null = null
    server!.setStatus(() => latest)
    expect((await signed(base, "GET", "/v1/status")).status).toBe(503)
    const at = new Date("2026-11-02T22:00:00.000Z")
    latest = { _id: "engine", at, status: "running", agent: { last_error_at: null } }
    expect((await call(base, "GET", "/v1/status")).status).toBe(401)
    expect((await signed(base, "GET", "/v1/status", "", { sign: requestSignatures("other-request.").sign })).status).toBe(401)
    const res = await signed(base, "GET", "/v1/status")
    expect(res).toEqual({ status: 200, body: { _id: "engine", at: { $date: "2026-11-02T22:00:00Z" }, status: "running", agent: { last_error_at: null } } })
    expect(BSON.EJSON.parse(JSON.stringify(res.body), { relaxed: true })).toEqual(latest)
  })
})
