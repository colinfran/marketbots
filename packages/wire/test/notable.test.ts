import { describe, expect, it } from "vitest"
import { isConfirmed, notableReasons } from "../src/notable"
import { WIRE_SETTINGS } from "./helpers"

const NOW = new Date("2026-10-27T12:00:00Z")

describe("notable rules", () => {
  const base = { _id: "x", cluster_id: "x", tier: 1 as const, kind: "news" as const, confirmations: [], severity_parts: {}, first_seen_at: NOW, severity: 60, symbols: ["BTC/USD"] }
  const ctx = { now: NOW, held: new Set(["BTC/USD"]), focus: new Set<string>(), thresholds: WIRE_SETTINGS.thresholds }
  it("needs a valid item and an applicable reason", () => {
    expect(notableReasons(base, ctx)).toEqual(["held"])
    expect(notableReasons({ ...base, severity: 40 }, ctx)).toEqual([])
    expect(notableReasons({ ...base, cluster_id: "y" }, ctx)).toEqual([])
    expect(notableReasons(base, { ...ctx, now: new Date(NOW.getTime() + 7 * 3_600_000) })).toEqual([])
    expect(notableReasons({ ...base, symbols: [] }, ctx)).toEqual(["market"])
    expect(notableReasons({ ...base, severity: 72 }, { ...ctx, held: new Set(), focus: new Set(["BTC/USD"]) })).toEqual(["focus"])
    expect(isConfirmed({ tier: 2, confirmations: [], severity_parts: { anomaly: 15 }, kind: "news" })).toBe(true)
    expect(isConfirmed({ tier: 3, confirmations: [{ domain: "a", url: null, at: NOW }], severity_parts: {}, kind: "news" })).toBe(false)
  })
})
