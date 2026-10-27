import { settle, useFakeClock } from "@mb/engine-kit/testing/timers"
import type { EngineEvent } from "@mb/stock-core/events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Alpaca } from "../../src/alpaca/client"
import type { EngineContext } from "../../src/bot/context"
import { enforceOvernightRules as overnight, ensureProtection as protect, maintain as upkeep, recordDailyStats as dailyStats } from "../../src/bot/maintenance"
import type { Session } from "../../src/bot/session"
import type { EventBus } from "../../src/bus/event-bus"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx, type SentAlert } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { afterOpen, alpacaOrder, beforeClose, CLOSE, closedSession, cycleDoc, fill, planDoc, session } from "../helpers/factories"

const NOW = afterOpen(90) // 11:00 ET
const testDb = useTestDb()
let broker: FakeBroker
let alpaca: Alpaca
let ctx: EngineContext
let bus: EventBus
let alerts: SentAlert[]
let events: EngineEvent[]

beforeEach(async () => {
  useFakeClock(NOW)
  broker = fakeBroker()
  alpaca = broker.client
  ;({ ctx, bus, alerts, events } = await makeCtx(testDb.col, broker))
})

afterEach(async () => {
  vi.useRealTimers()
  await bus.stop()
})

const ensureProtection = () => protect(ctx)
const enforceOvernightRules = () => overnight(ctx)
const recordDailyStats = (day?: string) => dailyStats(ctx, day)
const closeCycleDone = async () => (await testDb.col.cycles.countDocuments({ phase: "close", status: "succeeded" })) > 0
const maintain = (s: Session, now: Date) => upkeep(ctx, s, { now, closeCycleDone })
const db = async () => testDb.col
const plan = async (symbol: string) => (await db()).plans.findOne({ _id: symbol })
const addPlan = async (symbol: string, overrides: Parameters<typeof planDoc>[1] = {}) => (await db()).plans.insertOne(planDoc(symbol, overrides))
const addExits = (symbol: string, qty: number) =>
  broker.addOrder(alpacaOrder({ symbol, side: "sell", type: "limit", order_class: "oco", qty: String(qty), status: "new", legs: [alpacaOrder({ symbol, side: "sell", type: "stop", qty: String(qty), status: "held" })] }))

describe("ensureProtection", () => {
  it("adds OCO exits at the plan's levels to an unprotected position", async () => {
    broker.setPosition("AAPL", 10, 100)
    await addPlan("AAPL", { stop_loss: 95, take_profit: 110, decision_id: "dec-7", thesis: "Original thesis" })
    const notes = await ensureProtection()
    expect(notes).toEqual(["protected AAPL: stop 95, target 110"])
    expect(broker.submitted).toEqual([expect.objectContaining({ symbol: "AAPL", qty: "10", order_class: "oco", take_profit: { limit_price: "110.00" }, stop_loss: { stop_price: "95.00" } })])
    expect(await plan("AAPL")).toMatchObject({ stop_loss: 95, take_profit: 110, thesis: "Original thesis", updated_at: NOW })
    const orders = await (await db()).orders.find().toArray()
    expect(orders.every((o) => o.decision_id === "dec-7")).toBe(true)
  })

  it("adopts a position with no plan using default exits", async () => {
    broker.setPosition("MSFT", 3, 400)
    expect(await ensureProtection()).toEqual(["protected MSFT: stop 392, target 416"])
    expect(await plan("MSFT")).toEqual({
      _id: "MSFT",
      decision_id: null,
      stop_loss: 392,
      take_profit: 416,
      horizon: "overnight",
      setup: "other",
      thesis: "Adopted position with no plan on record.",
      invalidation: "Stop-loss hit.",
      opened_at: NOW,
      updated_at: NOW,
    })
  })

  it("repairs a plan target the price has already passed", async () => {
    broker.setPosition("AAPL", 10, 100)
    await addPlan("AAPL", { stop_loss: 95, take_profit: 99 })
    await ensureProtection()
    expect(await plan("AAPL")).toMatchObject({ stop_loss: 95, take_profit: 110 })
  })

  it.each([
    ["through", 101],
    ["just under", 99.9], // within 0.15%: too close to place, and a repaired stop would be lower
  ])("sells instead of lowering the stop when the price is %s it", async (_label, stop) => {
    broker.setPosition("AAPL", 10, 100)
    await addPlan("AAPL", { stop_loss: stop })
    const notes = await settle(ensureProtection())
    const note = `flattened AAPL (price 100 reached its ${stop} stop with no exit orders)`
    expect(notes).toEqual([note])
    expect(broker.holdings.has("AAPL")).toBe(false)
    expect(broker.submitted).toEqual([expect.objectContaining({ symbol: "AAPL", qty: "10", side: "sell", type: "market" })])
    expect(await plan("AAPL")).toBeNull()
    expect(alerts).toContainEqual({ level: "warning", title: "AAPL sold: its stop was hit while unprotected", message: note, path: "/markets/AAPL" })
    expect(events.find((e) => e.type === "protection.triggered")).toMatchObject({ instrument: "AAPL", data: { kind: "unprotected_stop" } })
  })

  it("leaves protected, short and fractional positions alone", async () => {
    broker.setPosition("AAPL", 10, 100)
    addExits("AAPL", 10)
    broker.setPosition("SHRT", 5, 50, { side: "short" })
    broker.setPosition("FRAC", 0.4, 300)
    expect(await ensureProtection()).toEqual([])
    expect(broker.submitted).toEqual([])
  })

  it("protects only the shares that are available", async () => {
    broker.setPosition("AAPL", 10, 100, { qtyAvailable: 7.6 })
    await ensureProtection()
    expect(broker.submitted[0].qty).toBe("7")
  })

  it("gives a core holding a plain GTC stop at its plan's level, with no target", async () => {
    broker.setPosition("NVDA", 5, 200)
    await addPlan("NVDA", { book: "core", stop_loss: 170, take_profit: null, horizon: "multi_day", decision_id: "dec-core" })
    expect(await ensureProtection()).toEqual(["protected NVDA (core): stop 170"])
    expect(broker.submitted).toEqual([{ symbol: "NVDA", qty: "5", side: "sell", type: "stop", stop_price: "170.00", time_in_force: "gtc", client_order_id: expect.stringMatching(/^smb-core-stop-/) }])
    expect(await plan("NVDA")).toMatchObject({ book: "core", stop_loss: 170, take_profit: null })
  })

  it("gives a core holding without a stop the initial core stop (wider than any trading stop)", async () => {
    broker.setPosition("NVDA", 5, 200, { avg: 190 })
    await addPlan("NVDA", { book: "core", stop_loss: null, take_profit: null })
    expect(await ensureProtection()).toEqual(["protected NVDA (core): stop 161.5"]) // 190 × 0.85
    expect(await plan("NVDA")).toMatchObject({ stop_loss: 161.5 })
  })

  it("sells a core holding already through its stop", async () => {
    broker.setPosition("NVDA", 5, 165)
    await addPlan("NVDA", { book: "core", stop_loss: 170, take_profit: null })
    const notes = await settle(ensureProtection())
    expect(notes).toEqual(["flattened NVDA (core: price 165 reached its 170 stop with no stop order)"])
    expect(broker.holdings.has("NVDA")).toBe(false)
    expect(alerts).toContainEqual(expect.objectContaining({ level: "warning", title: "NVDA sold: its core stop was hit while unprotected", path: "/core" }))
  })

  it("reports and alerts when protection fails", async () => {
    broker.setPosition("AAPL", 10, 100)
    broker.setPosition("MSFT", 2, 400)
    broker.submitErrors.push(new Error("insufficient qty"))
    const notes = await ensureProtection()
    expect(notes).toEqual(["could not protect AAPL: insufficient qty", "protected MSFT: stop 392, target 416"])
    expect(alerts).toContainEqual({
      level: "error",
      title: "AAPL has no stop-loss",
      message: "Placing protective exit orders failed: insufficient qty",
      fields: { Shares: 10, Stop: 98, Target: 104 },
      path: "/markets/AAPL",
    })
    expect(await plan("AAPL")).toBeNull()
  })
})

describe("enforceOvernightRules", () => {
  it("sells only intraday positions, after canceling their exits", async () => {
    broker.setPosition("AAPL", 10, 100)
    addExits("AAPL", 10)
    await addPlan("AAPL", { horizon: "intraday" })
    broker.setPosition("MSFT", 2, 400)
    await addPlan("MSFT", { horizon: "overnight" })
    broker.setPosition("NOPLAN", 1, 50)

    expect(await settle(enforceOvernightRules())).toEqual(["flattened AAPL"])
    expect([...broker.holdings.keys()]).toEqual(["MSFT", "NOPLAN"])
    expect(broker.submitted).toEqual([
      { symbol: "AAPL", qty: "10", side: "sell", type: "market", time_in_force: "day", client_order_id: expect.stringMatching(/^smb-flat-/) },
    ])
    expect(await plan("AAPL")).toBeNull()
    expect(await plan("MSFT")).not.toBeNull()
  })

  it("keeps going after a failure and alerts about it", async () => {
    broker.setPosition("AAPL", 10, 100)
    addExits("AAPL", 10)
    broker.stuckCancels.add("AAPL")
    broker.setPosition("AMD", 4, 150)
    await addPlan("AAPL")
    await addPlan("AMD")

    const notes = await settle(enforceOvernightRules())
    expect(notes).toEqual(["failed to flatten AAPL: Timed out cancelling open orders for AAPL", "flattened AMD"])
    expect(alerts).toContainEqual({ level: "error", title: "Failed to sell AAPL", message: "Timed out cancelling open orders for AAPL", path: "/markets/AAPL" })
    expect(await plan("AAPL")).not.toBeNull()
  })

  it("ignores intraday plans for positions that are gone", async () => {
    await addPlan("GONE")
    expect(await settle(enforceOvernightRules())).toEqual([])
  })

  it("sells the weakest overnight positions until exposure fits the cap", async () => {
    // Equity 10,110; the 50% cap allows 5,055 overnight and 6,610 is held.
    broker.setPosition("WIN", 30, 105, { avg: 100 }) // 3,150 (+5%)
    broker.setPosition("LOSER", 25, 98, { avg: 100 }) // 2,450 (−2%)
    broker.setPosition("FLAT", 10, 101, { avg: 100 }) // 1,010 (+1%)
    for (const s of ["WIN", "LOSER", "FLAT"]) await addPlan(s, { horizon: "overnight" })

    expect(await settle(enforceOvernightRules())).toEqual(["flattened LOSER (over the 50% overnight cap)"])
    expect([...broker.holdings.keys()]).toEqual(["WIN", "FLAT"])
  })

  it("sells intraday positions first and counts only what's left toward the cap", async () => {
    broker.setPosition("DAY", 60, 100) // 6,000, would break the cap on its own
    await addPlan("DAY", { horizon: "intraday" })
    broker.setPosition("SWING", 20, 100) // 2,000
    await addPlan("SWING", { horizon: "multi_day" })

    expect(await settle(enforceOvernightRules())).toEqual(["flattened DAY"])
    expect([...broker.holdings.keys()]).toEqual(["SWING"])
  })
})

describe("maintain", () => {
  it("syncs orders even when the market is closed", async () => {
    broker.addOrder(alpacaOrder({ id: "filled-stop", created_at: new Date(NOW.getTime() - 3_600_000).toISOString(), status: "filled" }))
    expect(await maintain(closedSession(), NOW)).toEqual([])
    expect(await (await db()).orders.findOne({ _id: "filled-stop" })).not.toBeNull()
    expect(alpaca.getAccount).not.toHaveBeenCalled()
  })

  it("does no trading upkeep outside the session", async () => {
    broker.setPosition("AAPL", 10, 100)
    expect(await maintain(session(), afterOpen(-30))).toEqual([])
    expect(await maintain(session(), new Date(CLOSE.getTime() + 60_000))).toEqual([])
    expect(broker.submitted).toEqual([])
  })

  it("liquidates everything when the daily loss limit trips", async () => {
    broker.setPosition("AAPL", 10, 100)
    broker.setPosition("MSFT", 2, 400)
    broker.lastEquity = 10_500 // -4.76% today
    await addPlan("AAPL")
    await addPlan("MSFT")

    const notes = await settle(maintain(session(), NOW))
    expect(broker.holdings.size).toBe(0)
    expect(await (await db()).plans.countDocuments()).toBe(0)
    expect(notes).toEqual([
      "DAILY LOSS LIMIT: day P&L -4.76% breached -4%; liquidated everything",
      "flattened AAPL (daily loss limit)",
      "flattened MSFT (daily loss limit)",
    ])
    expect(alerts).toContainEqual({
      level: "critical",
      title: "Daily loss limit: liquidated all positions",
      message: "Day P&L hit -4.76% (limit -4%). Every position was sold and buying is blocked for the rest of the day.",
      fields: { Equity: "$10,000.00", "Day P&L": "-$500.00", Positions: 2 },
      path: "/journal/2026-10-26",
    })
    // Only the two liquidating sells: nothing is re-protected after a liquidation.
    expect(broker.submitted.map((o) => [o.symbol, o.side, o.type])).toEqual([
      ["AAPL", "sell", "market"],
      ["MSFT", "sell", "market"],
    ])
  })

  it("doesn't liquidate when there's nothing to sell", async () => {
    broker.lastEquity = 10_500
    broker.cash = 10_000
    await maintain(session(), NOW)
    expect(broker.submitted).toEqual([])
  })

  it("stays calm just above the flatten limit", async () => {
    broker.setPosition("AAPL", 10, 100)
    broker.lastEquity = 10_400 // -3.85%
    await maintain(session(), NOW)
    expect(broker.submitted.filter((o) => o.type === "market")).toEqual([])
  })

  it("protects positions that lack exits", async () => {
    broker.setPosition("AAPL", 10, 100)
    expect(await maintain(session(), NOW)).toEqual(["protected AAPL: stop 98, target 104"])
  })

  it("sells intraday positions in the last 7 minutes if the closing cycle never ran", async () => {
    const now = beforeClose(6)
    vi.setSystemTime(now)
    broker.setPosition("AAPL", 10, 100)
    await addPlan("AAPL", { horizon: "intraday" })
    broker.setPosition("MSFT", 2, 400)
    await addPlan("MSFT", { horizon: "overnight" })
    addExits("MSFT", 2)

    const notes = await settle(maintain(session(), now))
    expect(notes).toEqual(["flattened AAPL"])
    expect(broker.holdings.has("AAPL")).toBe(false)
    expect(alerts).toContainEqual({
      level: "warning",
      title: "Closing cycle didn't run: sold intraday positions as a fallback",
      message: "flattened AAPL",
      path: "/journal/2026-10-26",
    })
  })

  it("leaves positions alone when the closing cycle succeeded", async () => {
    const now = beforeClose(6)
    vi.setSystemTime(now)
    await (await db()).cycles.insertOne(cycleDoc({ phase: "close", status: "succeeded" }))
    broker.setPosition("AAPL", 10, 100)
    addExits("AAPL", 10)
    await addPlan("AAPL", { horizon: "intraday" })
    expect(await settle(maintain(session(), now))).toEqual([])
    expect(broker.holdings.has("AAPL")).toBe(true)
  })

  it("doesn't fall back before the last 7 minutes, or alert when there's nothing to sell", async () => {
    broker.setPosition("AAPL", 10, 100)
    addExits("AAPL", 10)
    await addPlan("AAPL", { horizon: "intraday" })
    await settle(maintain(session(), beforeClose(8)))
    expect(broker.holdings.has("AAPL")).toBe(true)

    broker.holdings.clear()
    await settle(maintain(session(), beforeClose(5)))
    expect(alerts).toEqual([])
  })

  it("forgets plans of closed positions after a 10-minute grace period", async () => {
    broker.setPosition("HELD", 1, 50)
    addExits("HELD", 1)
    await addPlan("HELD", { updated_at: new Date(NOW.getTime() - 60 * 60_000) })
    await addPlan("STOPPED", { updated_at: new Date(NOW.getTime() - 11 * 60_000) })
    await addPlan("PENDING", { updated_at: new Date(NOW.getTime() - 5 * 60_000) })
    await maintain(session(), NOW)
    const left = (await (await db()).plans.find().toArray()).map((p) => p._id).sort()
    expect(left).toEqual(["HELD", "PENDING"])
  })
})

describe("recordDailyStats", () => {
  const seedFills = async () =>
    (await db()).orders.insertMany([
      fill("AAPL", "buy", 10, 100, "2026-10-23T14:00:00Z"), // bought on Friday
      fill("AAPL", "sell", 10, 105, "2026-10-26T14:30:00Z"), // +50 today
      fill("MSFT", "buy", 2, 400, "2026-10-26T15:00:00Z"),
      fill("MSFT", "sell", 2, 390, "2026-10-26T16:00:00Z"), // −20 today
      fill("NVDA", "buy", 4, 50, "2026-10-26T17:00:00Z"),
      fill("NVDA", "sell", 4, 52.5, "2026-10-26T18:00:00Z"), // +10 today
      fill("OLD", "sell", 1, 10, "2026-10-26T18:30:00Z"), // no recorded buy
      fill("TSLA", "buy", 1, 250, "2026-10-27T14:00:00Z"), // tomorrow
    ])

  it("records the day's equity, P&L and trade results", async () => {
    broker.cash = 10_100
    broker.lastEquity = 10_000
    await seedFills()
    await recordDailyStats("2026-10-26")
    expect(await (await db()).dailyStats.findOne({ _id: "2026-10-26" })).toEqual({
      _id: "2026-10-26",
      trading_day: "2026-10-26",
      start_equity: 10_000,
      end_equity: 10_100,
      pnl: 100,
      pnl_pct: 1,
      total_return_pct: 1,
      orders_filled: 6,
      buys: 2,
      sells: 4,
      realized_pnl: 40,
      wins: 2,
      losses: 1,
      best: { symbol: "AAPL", pnl: 50 },
      worst: { symbol: "MSFT", pnl: -20 },
      spy_pct: null,
      updated_at: NOW,
    })
    expect(events.find((e) => e.type === "daily.stats")).toMatchObject({ data: { day: "2026-10-26", pnl: 100, pnl_pct: 1, spy_pct: null } })
  })

  it("records SPY's move that day as the benchmark", async () => {
    const bar = (t: string, c: number) => ({ t, o: c, h: c, l: c, c, v: 1, vw: c, n: 1 })
    broker.snapshots.set("SPY", { dailyBar: bar("2026-10-26T04:00:00Z", 584.35), prevDailyBar: bar("2026-10-23T04:00:00Z", 580) })
    await recordDailyStats("2026-10-26")
    expect(await (await db()).dailyStats.findOne({ _id: "2026-10-26" })).toMatchObject({ spy_pct: 0.75 })

    // A bar from another day isn't that day's move.
    await recordDailyStats("2026-10-27")
    expect(await (await db()).dailyStats.findOne({ _id: "2026-10-27" })).toMatchObject({ spy_pct: null })
  })

  it("still records the day when the SPY snapshot fails", async () => {
    vi.mocked(alpaca.getSnapshots).mockRejectedValue(new Error("data API down"))
    await recordDailyStats("2026-10-26")
    expect(await (await db()).dailyStats.findOne({ _id: "2026-10-26" })).toMatchObject({ spy_pct: null })
  })

  it("defaults to today and overwrites the record when run again", async () => {
    broker.cash = 10_000
    await recordDailyStats()
    broker.cash = 10_250
    broker.lastEquity = 10_000
    await recordDailyStats()
    const all = await (await db()).dailyStats.find().toArray()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ _id: "2026-10-26", end_equity: 10_250, pnl: 250, pnl_pct: 2.5, total_return_pct: 2.5 })
  })

  it("handles a day without closed trades", async () => {
    broker.cash = 9_900
    broker.lastEquity = 0 // unknown: treated as a flat start
    await recordDailyStats("2026-10-26")
    expect(await (await db()).dailyStats.findOne({ _id: "2026-10-26" })).toMatchObject({
      start_equity: 9_900,
      pnl: 0,
      pnl_pct: 0,
      total_return_pct: -1,
      orders_filled: 0,
      realized_pnl: 0,
      wins: 0,
      losses: 0,
      best: null,
      worst: null,
    })
  })
})
