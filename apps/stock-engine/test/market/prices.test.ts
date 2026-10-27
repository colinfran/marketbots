import type { EngineEvent } from "@mb/stock-core/events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { EventBus } from "../../src/bus/event-bus"
import { LivePrices } from "../../src/market/prices"
import { makeBus } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"

const db = useTestDb()
let bus: EventBus
let events: EngineEvent[]
let now = 1_000_000

beforeEach(async () => {
  bus = await makeBus(db.col)
  events = []
  bus.subscribe((e) => events.push(e))
  now = 1_000_000
})

afterEach(async () => {
  await bus.stop()
})

describe("LivePrices", () => {
  it("prefers a tight, newer quote over a stale trade, and computes the day's change", () => {
    const p = new LivePrices(null, 2_000, () => now)
    p.setPrevClose("NVDA", 100)
    p.onTrade("NVDA", 101, now - 60_000)
    expect(p.get("NVDA")).toMatchObject({ price: 101, change_pct: 1 })
    p.onQuote("NVDA", 101.9, 102.1, now)
    expect(p.get("NVDA")).toMatchObject({ price: 102, bid: 101.9, ask: 102.1, change_pct: 2 })
    // A wide quote isn't trusted.
    p.onQuote("NVDA", 95, 110, now + 1)
    expect(p.get("NVDA")!.price).toBe(101)
  })

  it("only returns fresh prices from fresh()", () => {
    const p = new LivePrices(null, 2_000, () => now)
    p.onTrade("AAPL", 230, now - 120_000)
    expect(p.fresh("AAPL", 60_000)).toBeNull()
    expect(p.fresh("AAPL", 180_000)).toBe(230)
    expect(p.get("NONE")).toBeNull()
  })

  it("streams tickers at most every couple of seconds per symbol", () => {
    const p = new LivePrices(bus, 2_000, () => now)
    p.onTrade("AAPL", 230, now)
    p.onTrade("AAPL", 231, now)
    now += 2_500
    p.onTrade("AAPL", 232, now)
    expect(events.map((e) => [e.type, (e.data as { price: number }).price, e.seq])).toEqual([
      ["market.ticker", 230, 0],
      ["market.ticker", 232, 0],
    ])
  })
})
