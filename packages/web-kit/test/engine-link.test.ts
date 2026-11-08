import { describe, expect, it, vi } from "vitest"
import { callEngine, type EngineLink } from "../src/engine-link"

const SECRET = "s".repeat(40)

/** A link with the given stream URL and own address, and a fetch that records where it was sent. */
const setup = ({ streamUrl, url }: { streamUrl: string | null; url?: string | null }) => {
  const calls: string[] = []
  const fetchFn = (async (to: string | URL | Request) => {
    calls.push(String(to))
    return new Response("{}", { status: 200 })
  }) as typeof fetch
  const sign = vi.fn(() => ({ "x-mb-signature": "sig", "x-mb-timestamp": "1" }))
  const link: EngineLink = { streamUrl: () => streamUrl, ...(url === undefined ? {} : { url: () => url }), secret: () => SECRET, sign }
  return { call: () => callEngine(link, { method: "GET", path: "/v1/status", timeoutMs: 1_000, fetchFn }), calls }
}

describe("callEngine", () => {
  it("calls the engine at its own address (ENGINE_URL) when set, whatever the stream URL", async () => {
    const { call, calls } = setup({ streamUrl: "wss://engine.example.app/v1/stream", url: "http://host.docker.internal:8787" })
    expect(await call()).toBeInstanceOf(Response)
    expect(calls).toEqual(["http://host.docker.internal:8787/v1/status"])
  })

  it("ignores a path or trailing slash on the engine's address", async () => {
    const { call, calls } = setup({ streamUrl: null, url: "http://host.docker.internal:8788/" })
    await call()
    expect(calls).toEqual(["http://host.docker.internal:8788/v1/status"])
  })

  it("falls back to the stream URL's origin without one (unset, empty or unparsable)", async () => {
    for (const url of [undefined, null, "not a url"]) {
      const { call, calls } = setup({ streamUrl: "wss://engine.example.app/v1/stream", url })
      await call()
      expect(calls).toEqual(["https://engine.example.app/v1/status"])
    }
  })

  it("isn't set up without either address", async () => {
    const { call, calls } = setup({ streamUrl: null, url: null })
    expect(await call()).toBe("unconfigured")
    expect(calls).toEqual([])
  })
})
