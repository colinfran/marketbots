import { BSON } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { createEngineStatus } from "../src/engine-status"

// Outside a request there is no connection to wait for.
vi.mock("next/server", () => ({ connection: async () => undefined }))

type Status = { _id: "engine"; at: Date; status: string; agent: { last_error_at: Date | null } }

const SECRET = "s".repeat(40)

/** The read bound to a fake engine: `answer` is its reply (rejecting: unreachable); without one it isn't set up. */
const setup = (answer: ((init: RequestInit) => Response | Promise<Response>) | null) => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return answer!(init)
  }) as typeof fetch
  const sign = vi.fn((_secret: string, r: { method: string; path: string; body: string }) => ({ "x-mb-signature": `sig:${r.method}:${r.path}`, "x-mb-timestamp": "1" }))
  const getEngine = createEngineStatus<Status>({ streamUrl: () => (answer ? "wss://engine.example.app/v1/stream" : null), secret: () => SECRET, sign }, fetchFn)
  return { getEngine, calls }
}

const status = (ageMs: number): Status => ({ _id: "engine", at: new Date(Date.now() - ageMs), status: "running", agent: { last_error_at: new Date("2026-11-02T15:34:16Z") } })
const ejson = (body: object) => new Response(BSON.EJSON.stringify(body, { relaxed: true }), { status: 200, headers: { "content-type": "application/json" } })

describe("createEngineStatus", () => {
  it("reads the status from the engine, signed, with its dates as dates, and calls it online while fresh", async () => {
    const sent = status(5_000)
    const { getEngine, calls } = setup(() => ejson(sent))
    const engine = await getEngine()
    expect(engine).toEqual({ status: sent, online: true, heartbeatAgeS: 5 })
    expect(engine.status!.at).toBeInstanceOf(Date)
    expect(engine.status!.agent.last_error_at).toBeInstanceOf(Date)
    expect([calls[0].url, calls[0].init.method, new Headers(calls[0].init.headers).get("x-mb-signature")]).toEqual(["https://engine.example.app/v1/status", "GET", "sig:GET:/v1/status"])
  })

  it("shows the engine offline when it is unreachable, isn't set up, has no status yet, or its last beat is stale", async () => {
    const offline = { status: null, online: false, heartbeatAgeS: null }
    expect(await setup(() => Promise.reject(new TypeError("fetch failed"))).getEngine()).toEqual(offline)
    expect(await setup(() => Promise.reject(new DOMException("timed out", "TimeoutError"))).getEngine()).toEqual(offline)
    const unset = setup(null)
    expect(await unset.getEngine()).toEqual(offline)
    expect(unset.calls).toEqual([])
    expect(await setup(() => new Response(JSON.stringify({ error: "engine starting" }), { status: 503 })).getEngine()).toEqual(offline)
    expect(await setup(() => ejson(status(45_000))).getEngine()).toMatchObject({ online: false, heartbeatAgeS: 45, status: { status: "running" } })
  })
})
