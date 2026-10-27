import { describe, expect, it } from "vitest"
import { eventForViewer, type EngineEvent } from "../src/events"
import { signStreamToken, verifyStreamToken } from "../src/stream-token"

const SECRET = "x".repeat(40)

const fill: EngineEvent<"order.filled"> = {
  v: 1,
  seq: 7,
  ts: "2026-10-26T15:00:00.000Z",
  type: "order.filled",
  level: "info",
  visibility: "public",
  summary: "Filled: buy 10 NVDA at $140.00",
  data: { order_id: "o1", symbol: "NVDA", side: "buy", qty: 10, price: 140, partial: false, asset_class: "us_equity" },
}

describe("eventForViewer", () => {
  it("shows owners everything", () => {
    expect(eventForViewer(fill, "owner")).toBe(fill)
  })

  it("shows paper amounts publicly", () => {
    expect(eventForViewer(fill, "public")?.data).toEqual(fill.data)
  })

  it("never sends owner-only events to the public", () => {
    const command = { ...fill, type: "command.completed", data: { command_id: "c", type: "pause", result: "ok" } } as EngineEvent
    expect(eventForViewer(command, "public")).toBeNull()
    expect(eventForViewer({ ...fill, type: "broker.error", data: { scope: "x", message: "y" } } as EngineEvent, "public")).toBeNull()
    expect(eventForViewer({ ...fill, visibility: "owner" }, "public")).toBeNull()
  })
})

describe("stream tokens", () => {
  it("round-trips scope and expiry", () => {
    const { token } = signStreamToken("owner", SECRET, { now: 1_000_000 })
    const check = verifyStreamToken(token, SECRET, 1_000_000 + 30_000)
    expect(check.ok && check.payload.scope).toBe("owner")
  })

  it("expires after the ttl", () => {
    const { token } = signStreamToken("public", SECRET, { now: 1_000_000, ttlSeconds: 60 })
    expect(verifyStreamToken(token, SECRET, 1_000_000 + 61_000)).toEqual({ ok: false, reason: "expired" })
  })

  it("rejects tampered payloads and foreign secrets", () => {
    const { token } = signStreamToken("public", SECRET)
    const [v, , sig] = token.split(".")
    const forged = `${v}.${Buffer.from(JSON.stringify({ v: 1, scope: "owner", iat: 0, exp: 9e9, jti: "x" })).toString("base64url")}.${sig}`
    expect(verifyStreamToken(forged, SECRET)).toEqual({ ok: false, reason: "bad_signature" })
    expect(verifyStreamToken(token, "y".repeat(40))).toEqual({ ok: false, reason: "bad_signature" })
    expect(verifyStreamToken("garbage", SECRET)).toEqual({ ok: false, reason: "malformed" })
  })

  it("refuses weak secrets", () => {
    expect(() => signStreamToken("public", "short")).toThrow(/at least 32/)
  })
})
