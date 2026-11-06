import { describe, expect, it } from "vitest"
import { selfClearing, trippedBreakers, type BreakerHistory } from "../src/breakers"
import { checkEntry, type EnvelopeHistory } from "../src/envelope"
import { SETTINGS } from "./helpers"

const now = Date.parse("2026-10-28T14:00:00Z")
const MIN = 60_000
const e = SETTINGS.envelope
const history = (h: Partial<EnvelopeHistory> = {}): EnvelopeHistory => ({ openPositions: 0, entries: [], lastAction: new Map(), lastExit: new Map(), lastStopOut: new Map(), ...h })
const entry = (minutesAgo: number, symbol = "X") => ({ symbol, at: now - minutesAgo * MIN })

describe("agent envelope", () => {
  it("approves a first entry and records every check", () => {
    const r = checkEntry("SOL/USD", history(), e, now)
    expect(r.approved).toBe(true)
    expect(r.checks.map((c) => c.name)).toEqual(["agent entries per day", "agent entries per hour", "agent open positions", "one action per symbol", "no re-entry after a stop-out", "no flips"])
  })

  it("never limits by money: sizing is the bot's risk engine's, and two entries in the hour pass however large", () => {
    // Until 2026-11-06 an hour could commit 10% of equity and an entry was half of what risk allowed:
    // stock buys of ~1% of equity that couldn't buy one share of a $350 stock.
    expect(checkEntry("SOL/USD", history({ entries: [entry(10), entry(20)] }), e, now).approved).toBe(true)
    expect(Object.keys(e).sort()).toEqual(["entries_per_day", "entries_per_hour", "flip_hours", "max_open_positions", "reentry_after_stop_hours", "symbol_action_minutes"])
  })

  it("rate-limits entries per hour and per day, and caps open positions", () => {
    expect(checkEntry("SOL/USD", history({ entries: [entry(10), entry(20), entry(30)] }), e, now).reason).toBe("3/3 in the last hour")
    expect(checkEntry("SOL/USD", history({ entries: [100, 200, 300, 400, 500, 600, 700, 800].map((m) => entry(m)) }), e, now).reason).toBe("8/8 in the last 24 h")
    expect(checkEntry("SOL/USD", history({ entries: [entry(25 * 60)] }), e, now).approved).toBe(true)
    expect(checkEntry("SOL/USD", history({ openPositions: 4 }), e, now).reason).toBe("4/4 open")
  })

  it("refuses churn on one symbol: a recent action, a re-entry after a stop-out, a flip", () => {
    expect(checkEntry("SOL/USD", history({ lastAction: new Map([["SOL/USD", now - 10 * MIN]]) }), e, now).reason).toBe("last action 10 min ago (min 30)")
    expect(checkEntry("SOL/USD", history({ lastStopOut: new Map([["SOL/USD", now - 120 * MIN]]) }), e, now).reason).toBe("stopped out 120 min ago (wait 6 h)")
    expect(checkEntry("SOL/USD", history({ lastExit: new Map([["SOL/USD", now - 60 * MIN]]) }), e, now).reason).toBe("exited 60 min ago (wait 2 h)")
    expect(checkEntry("ETH/USD", history({ lastExit: new Map([["SOL/USD", now - 60 * MIN]]) }), e, now).approved).toBe(true)
  })

  it("lets a symbol in again once its waits are over", () => {
    const h = history({ lastAction: new Map([["SOL/USD", now - 7 * 60 * MIN]]), lastStopOut: new Map([["SOL/USD", now - 7 * 60 * MIN]]), lastExit: new Map([["SOL/USD", now - 7 * 60 * MIN]]) })
    expect(checkEntry("SOL/USD", h, e, now).approved).toBe(true)
  })
})

describe("circuit breakers", () => {
  const base: BreakerHistory = { episodes: [], drawdownPct: 0, speeds: [] }
  const episodes = (answered: number, invalid: number, minutesAgo = 1) => [
    ...Array.from({ length: answered }, () => ({ at: now - minutesAgo * MIN, status: "answered" as const })),
    ...Array.from({ length: invalid }, () => ({ at: now - minutesAgo * MIN, status: "invalid" as const })),
  ]

  it("trips on a 20% drawdown from the peak, a pause only the owner lifts", () => {
    expect(trippedBreakers({ ...base, drawdownPct: -19.9 }, now)).toEqual([])
    expect(trippedBreakers({ ...base, drawdownPct: -20 }, now)).toEqual([{ name: "drawdown", detail: "the paper account is 20.00% below its peak", owner: true }])
  })

  it("counts invalid answers only when most of at least ten in the hour are invalid, and lets that clear by itself", () => {
    // One bad answer in five tripped the old breaker and paused crypto's entries for two days.
    expect(trippedBreakers({ ...base, episodes: episodes(4, 1) }, now)).toEqual([])
    expect(trippedBreakers({ ...base, episodes: episodes(0, 9) }, now)).toEqual([])
    expect(trippedBreakers({ ...base, episodes: episodes(5, 5) }, now)).toEqual([])
    expect(trippedBreakers({ ...base, episodes: episodes(4, 6) }, now)).toEqual([{ name: "invalid_answers", detail: "6 of 10 answers invalid in the last hour", owner: false }])
    expect(selfClearing({ episodes: episodes(4, 6), speeds: [] }, now)?.name).toBe("invalid_answers")
    expect(selfClearing({ episodes: episodes(4, 6, 61), speeds: [] }, now)).toBeNull()
  })

  it("trips on a slow model while it lasts", () => {
    expect(trippedBreakers({ ...base, speeds: [30, 28, 31, 29, 27] }, now).map((b) => [b.name, b.owner])).toEqual([["slow_model", false]])
    expect(trippedBreakers({ ...base, speeds: [30, 28, 44, 29, 27] }, now)).toEqual([])
    expect(selfClearing({ episodes: [], speeds: [30, 28, 31, 29, 27, 44] }, now)).toBeNull()
  })
})
