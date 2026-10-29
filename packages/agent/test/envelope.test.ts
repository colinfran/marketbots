import { describe, expect, it } from "vitest"
import { trippedBreakers } from "../src/breakers"
import { checkEntry, entryRoomUsd, type EnvelopeHistory } from "../src/envelope"
import { SETTINGS } from "./helpers"

const now = Date.parse("2026-10-28T14:00:00Z")
const MIN = 60_000
const e = SETTINGS.envelope
const history = (h: Partial<EnvelopeHistory> = {}): EnvelopeHistory => ({ equityUsd: 10_000, openPositions: 0, entries: [], lastAction: new Map(), lastExit: new Map(), lastStopOut: new Map(), ...h })

describe("agent envelope", () => {
  it("approves a first entry and records every check", () => {
    const r = checkEntry("SOL/USD", history(), e, now)
    expect(r.approved).toBe(true)
    expect(r.checks.map((c) => c.name)).toEqual(["agent entries per day", "agent entries per hour", "this hour's budget", "agent open positions", "one action per symbol", "no re-entry after a stop-out", "no flips"])
  })

  it("counts the hour's budget as used up when what is left can't fund a worthwhile entry", () => {
    // $1,000 an hour on $10,000; an entry needs at least 1% of equity ($100).
    const spent = (usd: number) => history({ entries: [{ symbol: "X", at: now - 30 * MIN, notionalUsd: usd }] })
    expect(checkEntry("SOL/USD", spent(998.5), e, now).reason).toBe("$2 of this hour's $1000 left (an entry needs at least $100)")
    expect(checkEntry("SOL/USD", spent(900), e, now).approved).toBe(true)
    expect(checkEntry("SOL/USD", history({ entries: [{ symbol: "X", at: now - 61 * MIN, notionalUsd: 998.5 }] }), e, now).approved).toBe(true)
  })

  it("rate-limits entries per hour and per day, and caps open positions", () => {
    const entry = (minutesAgo: number) => ({ symbol: "X", at: now - minutesAgo * MIN, notionalUsd: 100 })
    expect(checkEntry("SOL/USD", history({ entries: [entry(10), entry(20)] }), e, now).reason).toBe("2/2 in the last hour")
    expect(checkEntry("SOL/USD", history({ entries: [entry(100), entry(200), entry(300), entry(400)] }), e, now).reason).toBe("4/4 in the last 24 h")
    expect(checkEntry("SOL/USD", history({ openPositions: 4 }), e, now).reason).toBe("4/4 open")
  })

  it("refuses churn on one symbol: a recent action, a re-entry after a stop-out, a flip", () => {
    expect(checkEntry("SOL/USD", history({ lastAction: new Map([["SOL/USD", now - 10 * MIN]]) }), e, now).reason).toBe("last action 10 min ago (min 30)")
    expect(checkEntry("SOL/USD", history({ lastStopOut: new Map([["SOL/USD", now - 120 * MIN]]) }), e, now).reason).toBe("stopped out 120 min ago (wait 24 h)")
    expect(checkEntry("SOL/USD", history({ lastExit: new Map([["SOL/USD", now - 60 * MIN]]) }), e, now).reason).toBe("exited 60 min ago (wait 6 h)")
    expect(checkEntry("ETH/USD", history({ lastExit: new Map([["SOL/USD", now - 60 * MIN]]) }), e, now).approved).toBe(true)
  })

  it("sizes an entry at its share of what risk allows, within the hour's commitment budget", () => {
    expect(entryRoomUsd(1_000, history(), e, now)).toBe(500)
    expect(entryRoomUsd(4_000, history(), e, now)).toBe(1_000)
    expect(entryRoomUsd(4_000, history({ entries: [{ symbol: "X", at: now - 5 * MIN, notionalUsd: 800 }] }), e, now)).toBe(200)
    expect(entryRoomUsd(4_000, history({ entries: [{ symbol: "X", at: now - 5 * MIN, notionalUsd: 1_200 }] }), e, now)).toBe(0)
  })
})

describe("circuit breakers", () => {
  const base = { episodes: [], entries: [], envelopeBlocksToday: 0, dayPnlPct: 0, totalPnlPct: 0, speeds: [] }

  it("trips on five risk rejections in a row and on a bad hour", () => {
    const rejected = Array.from({ length: 5 }, (_, i) => ({ at: now - i * MIN, outcome: "rejected" as const }))
    expect(trippedBreakers({ ...base, entries: rejected }, now).map((b) => b.name)).toEqual(["risk_rejections", "rejection_rate"])
    const episodes = [...Array.from({ length: 8 }, () => ({ at: now - MIN, status: "answered" as const })), { at: now - MIN, status: "invalid" as const }]
    expect(trippedBreakers({ ...base, episodes }, now).map((b) => b.name)).toEqual(["invalid_answers"])
  })

  it("trips on envelope blocks, losses and a slow model", () => {
    expect(trippedBreakers({ ...base, envelopeBlocksToday: 3, dayPnlPct: -3.2, totalPnlPct: -6.5, speeds: [30, 28, 31, 29, 27] }, now).map((b) => b.name)).toEqual([
      "envelope_blocks",
      "daily_loss",
      "total_loss",
      "slow_model",
    ])
    expect(trippedBreakers({ ...base, speeds: [30, 28, 44, 29, 27] }, now)).toEqual([])
  })
})
