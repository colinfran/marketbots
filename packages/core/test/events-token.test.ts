import { describe, expect, it } from "vitest"
import { eventForViewer, type BaseEventDataMap, type EngineEvent } from "../src/events"
import { REQUEST_HEADERS, requestSignatures, streamTokens } from "../src/stream-token"

const SECRET = "x".repeat(40)

type Events = BaseEventDataMap<"general", "running", "idle">

const alert: EngineEvent<Events, "alert"> = {
  v: 1,
  seq: 3,
  ts: "2026-10-27T12:00:00.000Z",
  type: "alert",
  level: "info",
  visibility: "public",
  summary: "Seed scheduled",
  data: { level: "info", title: "Seed", message: "Scheduled for 09:45 ET" },
}

describe("eventForViewer", () => {
  const ownerOnly = new Set<keyof Events>(["command.completed", "error"])

  it("shows owners everything and the public what isn't owner-only", () => {
    expect(eventForViewer(alert, "owner", ownerOnly)).toBe(alert)
    expect(eventForViewer(alert, "public", ownerOnly)).toBe(alert)
  })

  it("hides the bot's owner-only events and owner-visibility events from the public", () => {
    const error = { ...alert, type: "error", data: { scope: "x", message: "y" } } as EngineEvent<Events>
    expect(eventForViewer(error, "public", ownerOnly)).toBeNull()
    expect(eventForViewer(error, "owner", ownerOnly)).toBe(error)
    expect(eventForViewer({ ...alert, visibility: "owner" }, "public", ownerOnly)).toBeNull()
  })
})

describe("stream tokens", () => {
  const crypto = streamTokens("cmb-stream.")
  const stock = streamTokens("smb-stream.")

  it("round-trips under the same context prefix", () => {
    const { token } = crypto.sign("owner", SECRET, { now: 1_000_000 })
    const check = crypto.verify(token, SECRET, 1_000_000 + 30_000)
    expect(check.ok && check.payload.scope).toBe("owner")
  })

  it("never verifies a token minted under another context prefix, even with the same secret", () => {
    const { token } = stock.sign("owner", SECRET, { now: 1_000_000 })
    expect(crypto.verify(token, SECRET, 1_000_000)).toEqual({ ok: false, reason: "bad_signature" })
    expect(stock.verify(token, SECRET, 1_000_000).ok).toBe(true)
  })
})

describe("signed requests", () => {
  const cmb = requestSignatures("cmb-request.")
  const smb = requestSignatures("smb-request.")
  const KEY = "k".repeat(40)
  const request = { method: "POST", path: "/v1/commands", body: '{"id":"c1","actor":"owner","command":{"type":"pause"}}' }
  const NOW = 1_800_000_000_000
  const headersOf = (h: Record<string, string>) => ({ timestamp: h[REQUEST_HEADERS.timestamp], signature: h[REQUEST_HEADERS.signature] })

  it("verifies the request it signed, within a minute either way", () => {
    const h = headersOf(cmb.sign(KEY, request, NOW))
    expect(cmb.verify(KEY, request, h, NOW)).toBe(true)
    expect(cmb.verify(KEY, request, h, NOW + 59_000)).toBe(true)
    expect(cmb.verify(KEY, request, h, NOW - 59_000)).toBe(true)
    expect(cmb.verify(KEY, request, h, NOW + 61_000)).toBe(false)
  })

  it("refuses another body, path, method, secret or bot, and missing headers", () => {
    const h = headersOf(cmb.sign(KEY, request, NOW))
    expect(cmb.verify(KEY, { ...request, body: request.body.replace("pause", "resume") }, h, NOW)).toBe(false)
    expect(cmb.verify(KEY, { ...request, path: "/v1/commands/c1" }, h, NOW)).toBe(false)
    expect(cmb.verify(KEY, { ...request, method: "GET" }, h, NOW)).toBe(false)
    expect(cmb.verify("j".repeat(40), request, h, NOW)).toBe(false)
    expect(smb.verify(KEY, request, h, NOW)).toBe(false)
    expect(cmb.verify(KEY, request, { timestamp: h.timestamp, signature: undefined }, NOW)).toBe(false)
    expect(cmb.verify(KEY, request, { timestamp: "soon", signature: h.signature }, NOW)).toBe(false)
  })
})
