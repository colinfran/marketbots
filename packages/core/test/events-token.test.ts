import { describe, expect, it } from "vitest"
import { eventForViewer, type BaseEventDataMap, type EngineEvent } from "../src/events"
import { streamTokens } from "../src/stream-token"

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
