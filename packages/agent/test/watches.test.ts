import type { WatchRequest } from "@mb/core/agent"
import { describe, expect, it } from "vitest"
import { describeWatch, newsWatchFires, normalizeNote, normalizeWatch, watchFires, watchObservation } from "../src/watches"

const now = new Date("2026-10-28T14:00:00Z")
const prices: Record<string, number> = { "SOL/USD": 180, "BTC/USD": 65_000 }
const env = { now, price: (s: string) => prices[s] ?? null, known: (s: string) => s in prices, active: [] }
const req = (w: Partial<WatchRequest>): WatchRequest => ({ kind: "price_above", symbol: "SOL/USD", level: 182, at: null, hours: 24, priority: "opportunity", note: "breakout?", ...w })
const make = (w: Partial<WatchRequest>) => {
  const r = normalizeWatch(req(w), "e1", env)
  if ("rejected" in r) throw new Error(r.rejected)
  return r.watch
}

describe("watches", () => {
  it("stores a price watch with its priority, expiry and note", () => {
    const w = make({})
    expect(w).toMatchObject({ kind: "price_above", symbol: "SOL/USD", level: 182, priority: 1, status: "active", note: "breakout?" })
    expect(w.expires_at.toISOString()).toBe("2026-10-29T14:00:00.000Z")
    expect(describeWatch(w)).toBe("SOL/USD above 182")
  })

  it("refuses what can't work: unknown symbols, levels already crossed, past times, no symbol for a price", () => {
    const why = (w: Partial<WatchRequest>) => {
      const r = normalizeWatch(req(w), "e1", env)
      return "rejected" in r ? r.rejected : null
    }
    expect(why({ symbol: "XYZ/USD" })).toBe("unknown symbol XYZ/USD")
    expect(why({ level: 170 })).toMatch(/already above 170/)
    expect(why({ kind: "price_below", level: 190 })).toMatch(/already below 190/)
    expect(why({ symbol: null })).toBe("price_above needs a symbol")
    expect(why({ kind: "time", symbol: null, at: "2026-10-28T13:00:00Z" })).toMatch(/in the past/)
    expect(why({ kind: "time", symbol: null, at: "2026-11-20T13:00:00Z" })).toMatch(/more than 168 hours/)
  })

  it("refuses a watch identical to one already active, but not one with another level", () => {
    const existing = make({ kind: "price_below", level: 170, priority: "risk" })
    const again = normalizeWatch(req({ kind: "price_below", level: 170, priority: "review", note: "reassess" }), "e2", { ...env, active: [existing] })
    expect("rejected" in again && again.rejected).toBe("already watching: SOL/USD below 170")
    expect("watch" in normalizeWatch(req({ kind: "price_below", level: 165 }), "e2", { ...env, active: [existing] })).toBe(true)
    expect("watch" in normalizeWatch(req({ kind: "price_below", level: 170 }), "e2", { ...env, active: [{ ...existing, status: "fired" }] })).toBe(true)
  })

  it("enforces the per-symbol and total limits", () => {
    const five = Array.from({ length: 5 }, () => make({}))
    const r = normalizeWatch(req({}), "e1", { ...env, active: five })
    expect("rejected" in r && r.rejected).toBe("already 5 active watches on SOL/USD")
  })

  it("fires price, move and time watches; news watches fire on items", () => {
    const above = make({})
    const move = make({ kind: "move_pct", level: 5 })
    const time = make({ kind: "time", symbol: null, at: "2026-10-28T15:00:00Z" })
    const news = make({ kind: "news", symbol: "SOL/USD", level: 70 })
    expect(move.ref_price).toBe(180)
    const price = (p: number) => () => p
    expect(watchFires(above, now, price(181))).toBe(false)
    expect(watchFires(above, now, price(182.1))).toBe(true)
    expect(watchFires(move, now, price(170.9))).toBe(true)
    expect(watchFires(move, now, price(175))).toBe(false)
    expect(watchFires(time, new Date("2026-10-28T15:00:00Z"), price(0))).toBe(true)
    expect(newsWatchFires(news, { symbols: ["SOL/USD"], severity: 72 })).toBe(true)
    expect(newsWatchFires(news, { symbols: ["SOL/USD"], severity: 60 })).toBe(false)
    expect(newsWatchFires(make({ kind: "news", symbol: null, level: 50 }), { symbols: [], severity: 55 })).toBe(true)
  })

  it("becomes an urgent observation when it fires", () => {
    const o = watchObservation(make({ priority: "risk" }), now)
    expect(o).toMatchObject({ subject: "SOL/USD", kind: "watch", priority: 0, urgent: true })
    expect(o.summary).toContain("Your watch fired: SOL/USD above 182")
  })

  it("keeps notes on known subjects only, capped", () => {
    const r = normalizeNote({ subject: "market", text: "x".repeat(900) }, "e1", env)
    expect("note" in r && r.note.subject).toBe("MARKET")
    expect("note" in r && r.note.text.length).toBe(500)
    expect(normalizeNote({ subject: "DOGE/USD", text: "hi" }, "e1", env)).toEqual({ rejected: "unknown subject DOGE/USD" })
  })
})
