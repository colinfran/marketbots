import { settle, useFakeClock } from "@mb/engine-kit/testing/timers"
import type { DecisionDoc } from "@mb/stock-core/db"
import type { Decision } from "@mb/stock-core/report"
import { DEFAULT_SETTINGS, type Phase } from "@mb/stock-core/settings"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AlpacaError, type Alpaca } from "../../src/alpaca/client"
import type { EngineContext } from "../../src/bot/context"
import { cancelSymbolOrders, executeDecisions, heldExitBounds, placeExitOrders, resolveExits as resolve } from "../../src/bot/execute"
import type { EventBus } from "../../src/bus/event-bus"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { alpacaOrder, decision, decisionDoc, fill, planDoc, report } from "../helpers/factories"

const db = useTestDb()
const R = DEFAULT_SETTINGS.risk
const HELD_EXIT_BOUNDS = heldExitBounds(R)
const resolveExits = (price: number, stop: number | null, target: number | null, bounds?: { minStopPct?: number; maxStopPct?: number }) => resolve(price, stop, target, R, bounds)
const collections = async () => db.col

const NOW = new Date("2026-10-26T15:00:00.000Z") // Monday 11:00 ET
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

const RUN = "cycle-under-test"
let broker: FakeBroker
let alpaca: Alpaca
let ctx: EngineContext
let bus: EventBus

beforeEach(async () => {
  useFakeClock(NOW)
  broker = fakeBroker()
  alpaca = broker.client
  ;({ ctx, bus } = await makeCtx(db.col, broker))
  broker.setPrice("AAPL", 100).setPrice("MSFT", 400).setPrice("NVDA", 50).setPrice("AMD", 150).setPrice("TSLA", 250)
})

afterEach(async () => {
  vi.useRealTimers()
  await bus.stop()
})

const execute = (decisions: Decision[], phase: Phase = "intraday") =>
  settle(executeDecisions(ctx, { cycleId: RUN, reportId: "rep-1", phase, report: report({ decisions }), chains: new Map(), entriesBlocked: () => null }))

/** Decisions recorded by the cycle under test (seeded history uses other cycle ids). */
const records = async () => (await collections()).decisions.find({ cycle_id: RUN }).toArray()
const recordFor = async (symbol: string): Promise<DecisionDoc> => {
  const found = (await records()).filter((r) => r.symbol === symbol)
  expect(found).toHaveLength(1)
  return found[0]
}
const plan = async (symbol: string) => (await collections()).plans.findOne({ _id: symbol })

/** A held position with resting OCO exits, like the bot leaves it after a buy. */
const holdWithExits = async (symbol: string, qty: number, price: number, { stop = 95, target = 110, avg = price } = {}) => {
  broker.setPosition(symbol, qty, price, { avg })
  const stopLeg = alpacaOrder({ symbol, side: "sell", type: "stop", order_class: "oco", qty: String(qty), stop_price: String(stop), status: "held" })
  broker.addOrder(alpacaOrder({ symbol, side: "sell", type: "limit", order_class: "oco", qty: String(qty), limit_price: String(target), status: "new", legs: [stopLeg] }))
  await (await collections()).plans.insertOne(planDoc(symbol, { stop_loss: stop, take_profit: target, opened_at: minutesAgo(60), updated_at: minutesAgo(60) }))
}

describe("resolveExits", () => {
  it("keeps valid levels", () => {
    expect(resolveExits(100, 97, 106)).toEqual({ stop: 97, target: 106, rewardRisk: 2, notes: [] })
  })

  it("defaults a missing stop to 2% and a missing target to 2R", () => {
    expect(resolveExits(100, null, null)).toEqual({
      stop: 98,
      target: 104,
      rewardRisk: 2,
      notes: ["no stop given; default 2% stop", "no target given; default 2R target"],
    })
  })

  it("replaces a stop above, at or too close to the price", () => {
    for (const stop of [101, 100, 99.7]) {
      const exits = resolveExits(100, stop, 106)
      expect(exits.stop).toBe(98)
      expect(exits.notes).toEqual([`stop ${stop} too close/above price; default 2% stop`])
    }
    expect(resolveExits(100, 99.6, 106).stop).toBe(99.6) // exactly the 0.4% minimum
  })

  it("caps a stop that is too wide at 8%", () => {
    expect(resolveExits(100, 90, 120)).toEqual({ stop: 92, target: 120, rewardRisk: 2.5, notes: ["stop 90 too wide; capped at 8%"] })
  })

  it("replaces a target that isn't meaningfully above the price", () => {
    const exits = resolveExits(100, 97, 100.1)
    expect(exits.target).toBe(106)
    expect(exits.notes).toEqual(["target 100.1 not above price; default 2R target"])
  })

  it("rounds the stop down and the target up, and reports the true reward:risk", () => {
    const exits = resolveExits(33.33, null, null)
    expect(exits.stop).toBe(32.66)
    expect(exits.target).toBe(34.67)
    expect(exits.rewardRisk).toBeCloseTo(2, 5)
    expect(resolveExits(100, 95, 102).rewardRisk).toBeCloseTo(0.4)
  })

  it("accepts tighter and wider stops on held positions", () => {
    expect(HELD_EXIT_BOUNDS).toEqual({ minStopPct: 0.15, maxStopPct: 12 })
    expect(resolveExits(100, 99.8, 105, HELD_EXIT_BOUNDS).stop).toBe(99.8)
    expect(resolveExits(100, 89, 105, HELD_EXIT_BOUNDS).stop).toBe(89)
    expect(resolveExits(100, 85, 105, HELD_EXIT_BOUNDS)).toMatchObject({ stop: 88, notes: ["stop 85 too wide; capped at 12%"] })
    expect(resolveExits(100, 99.9, 105, HELD_EXIT_BOUNDS).stop).toBe(98)
  })
})

describe("cancelSymbolOrders", () => {
  it("returns at once when nothing is open", async () => {
    await settle(cancelSymbolOrders(alpaca, "AAPL"))
    expect(alpaca.listOrders).toHaveBeenCalledTimes(1)
    expect(alpaca.listOrders).toHaveBeenCalledWith({ status: "open", symbols: "AAPL", limit: 100 })
  })

  it("cancels the symbol's open orders and waits until they're gone", async () => {
    await holdWithExits("AAPL", 10, 100)
    await holdWithExits("MSFT", 2, 400)
    await settle(cancelSymbolOrders(alpaca, "AAPL"))
    expect(broker.openOrders("AAPL")).toEqual([])
    expect(broker.openOrders("MSFT")).toHaveLength(2)
  })

  it("re-requests cancellation when the first request fails", async () => {
    await holdWithExits("AAPL", 10, 100)
    vi.mocked(alpaca.cancelOrder).mockRejectedValueOnce(new Error("busy")).mockRejectedValueOnce(new Error("busy"))
    await settle(cancelSymbolOrders(alpaca, "AAPL"))
    expect(broker.openOrders("AAPL")).toEqual([])
  })

  it("gives up after ~10 seconds, re-requesting every 2 seconds", async () => {
    await holdWithExits("AAPL", 10, 100)
    broker.stuckCancels.add("AAPL")
    await expect(settle(cancelSymbolOrders(alpaca, "AAPL"))).rejects.toThrow("Timed out cancelling open orders for AAPL")
    expect(alpaca.listOrders).toHaveBeenCalledTimes(20)
    // Two open orders (OCO parent + leg), cancel requested on attempts 0, 4, 8, 12, 16.
    expect(alpaca.cancelOrder).toHaveBeenCalledTimes(10)
  })
})

describe("placeExitOrders", () => {
  it("places a GTC OCO sell and records it against the decision", async () => {
    broker.setPosition("AAPL", 7, 100)
    const order = await placeExitOrders(ctx, "AAPL", 7, 95, 110.5, "dec-9")
    expect(broker.submitted).toEqual([
      {
        symbol: "AAPL",
        qty: "7",
        side: "sell",
        type: "limit",
        time_in_force: "gtc",
        order_class: "oco",
        take_profit: { limit_price: "110.50" },
        stop_loss: { stop_price: "95.00" },
        client_order_id: expect.stringMatching(/^smb-oco-[0-9a-f-]{18}$/),
      },
    ])
    const saved = await (await collections()).orders.find().toArray()
    expect(saved.map((o) => [o._id === order.id || o.parent_id === order.id, o.decision_id, o.role])).toEqual([
      [true, "dec-9", "take_profit"],
      [true, "dec-9", "stop_loss"],
    ])
  })
})

describe("executeDecisions: phases and market hours", () => {
  it("never trades in planning phases", async () => {
    for (const phase of ["premarket", "postmarket"] as const) {
      expect(await execute([decision()], phase)).toEqual({ executed: 0, rejected: 0, failed: 0, noop: 0, notes: [] })
    }
    expect(alpaca.getAccount).not.toHaveBeenCalled()
    expect(await records()).toEqual([])
  })

  it("records but doesn't execute anything while the market is closed", async () => {
    broker.clock.is_open = false
    await holdWithExits("MSFT", 2, 400)
    const summary = await execute([decision({ symbol: "AAPL" }), decision({ symbol: "MSFT", action: "sell" })])
    expect(summary).toMatchObject({ executed: 0, noop: 2 })
    expect((await recordFor("AAPL")).reason).toBe("market closed; not executed")
    expect(broker.submitted).toEqual([])
  })
})

describe("executeDecisions: holds", () => {
  it("records holds as no-ops", async () => {
    await holdWithExits("MSFT", 2, 400)
    const summary = await execute([decision({ symbol: "MSFT", action: "hold" }), decision({ symbol: "TSLA", action: "hold" })])
    expect(summary).toMatchObject({ noop: 2, executed: 0 })
    expect((await recordFor("MSFT")).reason).toBe("holding")
    expect((await recordFor("TSLA")).reason).toBe("hold on a symbol that is not held")
  })

  it("logs a default hold for any position Grok didn't mention", async () => {
    await holdWithExits("MSFT", 2, 400)
    await (await collections()).plans.updateOne({ _id: "MSFT" }, { $set: { horizon: "overnight", invalidation: "Loses 380." } })
    broker.setPosition("TSLA", 1, 250)
    const summary = await execute([])
    expect(summary.noop).toBe(2)
    expect(summary.notes).toEqual(["No decision returned for MSFT, TSLA; held by default."])
    const msft = await recordFor("MSFT")
    expect(msft).toMatchObject({ action: "hold", status: "noop", reason: "holding" })
    expect(msft.request).toMatchObject({ horizon: "overnight", invalidation: "Loses 380.", conviction: 5, setup: "other" })
    expect(msft.request.rationale).toContain("held by default")
    expect((await recordFor("TSLA")).request).toMatchObject({ horizon: "intraday", invalidation: "Stop-loss hit." })
    // The protective orders are left alone.
    expect(broker.openOrders("MSFT")).toHaveLength(2)
  })
})

describe("executeDecisions: buys", () => {
  it("buys whole shares with a bracket order and records the plan", async () => {
    const summary = await execute([decision({ symbol: "AAPL", allocation_pct: 10, stop_loss: 97, take_profit: 106 })])
    expect(summary).toEqual({ executed: 1, rejected: 0, failed: 0, noop: 0, notes: [] })

    expect(broker.submitted).toEqual([
      {
        symbol: "AAPL",
        qty: "10",
        side: "buy",
        type: "market",
        time_in_force: "gtc",
        order_class: "bracket",
        take_profit: { limit_price: "106.00" },
        stop_loss: { stop_price: "97.00" },
        client_order_id: expect.stringMatching(/^smb-buy-/),
      },
    ])
    expect(broker.holdings.get("AAPL")).toMatchObject({ qty: 10 })

    const record = await recordFor("AAPL")
    expect(record).toMatchObject({
      cycle_id: RUN,
      report_id: "rep-1",
      phase: "intraday",
      trading_day: "2026-10-26",
      action: "buy",
      status: "executed",
      reason: "bought 10 shares",
      price: 100,
      qty: 10,
      notional: 1000,
      stop_loss: 97,
      take_profit: 106,
    })
    expect(record.order_ids).toHaveLength(1)

    expect(await plan("AAPL")).toMatchObject({
      decision_id: record._id,
      stop_loss: 97,
      take_profit: 106,
      horizon: "intraday",
      setup: "momentum",
      thesis: "Holding VWAP with SPY green.",
      invalidation: "Loses VWAP.",
      opened_at: NOW,
    })

    const orders = await (await collections()).orders.find().toArray()
    expect(orders).toHaveLength(3)
    expect(orders.every((o) => o.decision_id === record._id)).toBe(true)
  })

  it("notes default exits in the reason", async () => {
    await execute([decision({ symbol: "AAPL" })])
    expect(await recordFor("AAPL")).toMatchObject({
      reason: "bought 10 shares; no stop given; default 2% stop; no target given; default 2R target",
      stop_loss: 98,
      take_profit: 104,
    })
  })

  it("caps the allocation at the max position size", async () => {
    await execute([decision({ symbol: "AAPL", allocation_pct: 60 })])
    expect((await recordFor("AAPL")).qty).toBe(20)
  })

  it("halves the max position size once the profit lock is on", async () => {
    broker.lastEquity = 9_800 // +2% today
    await execute([decision({ symbol: "AAPL", allocation_pct: 20 })])
    expect((await recordFor("AAPL")).qty).toBe(10)
  })

  it("only spends deployable cash, and tracks it across buys in one cycle", async () => {
    broker.setPosition("MSFT", 20, 400) // $8,000 invested, $2,000 cash, $1,500 deployable
    await execute([
      decision({ symbol: "AAPL", allocation_pct: 20, conviction: 9 }),
      decision({ symbol: "NVDA", allocation_pct: 20, conviction: 8 }),
      decision({ symbol: "MSFT", action: "hold" }),
    ])
    expect((await recordFor("AAPL")).qty).toBe(15)
    expect(await recordFor("NVDA")).toMatchObject({ status: "rejected", reason: "budget $0 buys less than 1 share at $50" })
  })

  it("records the actual fill price", async () => {
    broker.snapshots.set("AAPL", { latestTrade: { p: 100, t: NOW.toISOString() } })
    broker.setPrice("AAPL", 101)
    await execute([decision({ symbol: "AAPL", allocation_pct: 10 })])
    expect(await recordFor("AAPL")).toMatchObject({ qty: 10, price: 101, notional: 1010 })
  })

  it("allows overnight buys with conviction 8+ in the closing window", async () => {
    await execute([decision({ symbol: "AAPL", horizon: "overnight", conviction: 8 })], "close")
    expect(await recordFor("AAPL")).toMatchObject({ status: "executed", phase: "close" })
    expect((await plan("AAPL"))!.horizon).toBe("overnight")
  })

  it("marks a broker rejection as failed and keeps no plan", async () => {
    broker.fillMode = "reject"
    const summary = await execute([decision({ symbol: "AAPL" })])
    expect(summary).toMatchObject({ failed: 1, executed: 0, notes: ["BUY AAPL: order rejected by broker"] })
    const record = await recordFor("AAPL")
    expect(record).toMatchObject({ status: "failed", reason: "order rejected by broker" })
    expect(record.order_ids).toHaveLength(1)
    expect(await plan("AAPL")).toBeNull()
    expect((await (await collections()).orders.findOne({ _id: record.order_ids[0] }))!.status).toBe("rejected")
  })

  it("records a buy that hasn't filled after 15 seconds as submitted", async () => {
    broker.fillMode = "accept"
    await execute([decision({ symbol: "AAPL", allocation_pct: 10 })])
    expect(alpaca.getOrder).toHaveBeenCalledTimes(20) // polled every 750ms
    expect(await recordFor("AAPL")).toMatchObject({ status: "executed", reason: expect.stringMatching(/^buy submitted \(status accepted\)/), price: 100 })
    expect(await plan("AAPL")).not.toBeNull()
  })

  it("fails cleanly when the order request throws", async () => {
    broker.submitErrors.push(new AlpacaError(403, "Alpaca POST /v2/orders failed (403): insufficient buying power"))
    const summary = await execute([decision({ symbol: "AAPL" })])
    expect(summary.failed).toBe(1)
    expect(summary.notes).toEqual(["BUY AAPL: Alpaca POST /v2/orders failed (403): insufficient buying power"])
    expect(await plan("AAPL")).toBeNull()
  })
})

describe("executeDecisions: pricing", () => {
  it("prices from a tight IEX quote when the last IEX trade is older", async () => {
    broker.setPrice("AAPL", 102)
    broker.snapshots.set("AAPL", {
      latestTrade: { p: 100, t: minutesAgo(6).toISOString() },
      latestQuote: { bp: 101.95, ap: 102.05, t: NOW.toISOString() },
    })
    await execute([decision({ symbol: "AAPL", allocation_pct: 10 })])
    // Sized and protected from 102, not the stale 100.
    expect(broker.submitted[0]).toMatchObject({ qty: "9", stop_loss: { stop_price: "99.96" }, take_profit: { limit_price: "106.09" } })
  })
})

describe("executeDecisions: buy rejections", () => {
  const rejected = async (d: Decision, reason: string, phase: Phase = "intraday") => {
    const summary = await execute([d], phase)
    expect(summary.rejected).toBe(1)
    expect(await recordFor(d.symbol)).toMatchObject({ status: "rejected", reason, order_ids: [] })
    expect(broker.submitted).toEqual([])
  }

  it("blocks buys once the daily loss circuit breaker trips", async () => {
    broker.lastEquity = 10_300 // -2.9% today
    await rejected(decision({ symbol: "AAPL" }), "daily loss circuit breaker is active")
  })

  it("blocks new intraday trades in the closing window", async () => {
    await rejected(decision({ symbol: "AAPL", horizon: "intraday", conviction: 9 }), "no new intraday buys in the closing window", "close")
  })

  it("requires conviction 8+ for closing-window buys", async () => {
    await rejected(decision({ symbol: "AAPL", horizon: "multi_day", conviction: 7 }), "closing-window buys need conviction >= 8", "close")
  })

  it("never adds to a position", async () => {
    await holdWithExits("AAPL", 5, 100)
    const summary = await execute([decision({ symbol: "AAPL" })])
    expect(summary.rejected).toBe(1)
    expect((await recordFor("AAPL")).reason).toBe("already held: the bot never adds to positions")
  })

  it("respects the max number of open positions", async () => {
    for (const s of ["A1", "A2", "A3", "A4", "A5", "A6"]) broker.setPosition(s, 1, 10)
    broker.cash = 10_000
    await execute([decision({ symbol: "AAPL" })])
    expect((await recordFor("AAPL")).reason).toBe("max open positions (6) reached")
  })

  it("opens at most 3 new positions per cycle, highest conviction first", async () => {
    await execute([
      decision({ symbol: "AAPL", conviction: 6, allocation_pct: 5 }),
      decision({ symbol: "MSFT", conviction: 9, allocation_pct: 5 }),
      decision({ symbol: "NVDA", conviction: 7, allocation_pct: 5 }),
      decision({ symbol: "AMD", conviction: 8, allocation_pct: 5 }),
    ])
    expect(broker.submitted.map((o) => o.symbol)).toEqual(["MSFT", "AMD", "NVDA"])
    expect((await recordFor("AAPL")).reason).toBe("max 3 new buys per cycle")
  })

  it("stops at the daily order limit", async () => {
    const { decisions } = await collections()
    await decisions.insertMany(Array.from({ length: 30 }, (_, i) => decisionDoc({ trading_day: "2026-10-26", status: "executed", request: decision({ action: i % 2 ? "buy" : "sell" }) })))
    await rejected(decision({ symbol: "AAPL" }), "daily trade limit reached")
  })

  it("doesn't count yesterday's or non-executed orders toward the limit", async () => {
    const { decisions } = await collections()
    await decisions.insertMany([
      ...Array.from({ length: 30 }, () => decisionDoc({ trading_day: "2026-10-23", status: "executed" })),
      ...Array.from({ length: 30 }, () => decisionDoc({ trading_day: "2026-10-26", status: "rejected" })),
      ...Array.from({ length: 30 }, () => decisionDoc({ trading_day: "2026-10-26", status: "executed", request: decision({ action: "adjust_exits" }) })),
    ])
    await execute([decision({ symbol: "AAPL" })])
    expect((await recordFor("AAPL")).status).toBe("executed")
  })

  it("requires the minimum conviction", async () => {
    await rejected(decision({ symbol: "AAPL", conviction: 5 }), "conviction 5 < 6")
  })

  it("won't re-buy a symbol sold in the last 30 minutes", async () => {
    await (await collections()).decisions.insertOne(decisionDoc({ symbol: "AAPL", action: "sell", status: "executed", created_at: minutesAgo(29) }))
    await rejected(decision({ symbol: "AAPL" }), "sold within the last 30 minutes")
  })

  it("allows a re-buy after the cooldown", async () => {
    await (await collections()).decisions.insertOne(decisionDoc({ symbol: "AAPL", action: "sell", status: "executed", created_at: minutesAgo(31) }))
    await execute([decision({ symbol: "AAPL" })])
    expect((await recordFor("AAPL")).status).toBe("executed")
  })

  it("won't re-buy a symbol the broker stopped out of in the last 30 minutes", async () => {
    await (await collections()).orders.insertOne(fill("AAPL", "sell", 10, 95, minutesAgo(12), { role: "stop_loss" }))
    await rejected(decision({ symbol: "AAPL" }), "sold within the last 30 minutes")
  })

  it("allows a re-buy once a broker-triggered exit is past the cooldown", async () => {
    await (await collections()).orders.insertMany([
      fill("AAPL", "sell", 10, 110, minutesAgo(31), { role: "take_profit" }),
      fill("AAPL", "buy", 10, 100, minutesAgo(5)), // buys don't start a cooldown
    ])
    await execute([decision({ symbol: "AAPL" })])
    expect((await recordFor("AAPL")).status).toBe("executed")
  })

  it.each([
    ["not tradable", { tradable: false }],
    ["inactive", { status: "inactive" as const }],
    ["not a US equity", { class: "crypto" }],
    ["unknown to Alpaca", null],
  ])("rejects an asset that is %s", async (_label, asset) => {
    broker.assets.set("AAPL", asset)
    await rejected(decision({ symbol: "AAPL" }), "asset not tradable on Alpaca")
  })

  it("needs a current price", async () => {
    await rejected(decision({ symbol: "NOPRICE" }), "no current price")
  })

  it("stays out of penny stocks", async () => {
    broker.setPrice("PENNY", 3)
    await rejected(decision({ symbol: "PENNY" }), "price $3 below $5 minimum")
  })

  it.each([null, 0, -5])("needs a positive allocation (got %s)", async (allocation) => {
    await rejected(decision({ symbol: "AAPL", allocation_pct: allocation }), "no allocation_pct given")
  })

  it("rejects allocations too small for one share", async () => {
    await rejected(decision({ symbol: "MSFT", allocation_pct: 1 }), "budget $100 buys less than 1 share at $400")
  })

  it("requires a reward:risk of at least 1.2", async () => {
    await rejected(decision({ symbol: "AAPL", stop_loss: 95, take_profit: 102 }), "reward:risk 0.40 < 1.2 (stop 95, target 102)")
  })

  it("records the price it saw even for rejected buys", async () => {
    await execute([decision({ symbol: "AAPL", conviction: 2 })])
    expect((await recordFor("AAPL")).price).toBe(100)
  })
})

describe("executeDecisions: sells", () => {
  it("cancels the exits, sells the whole position and drops the plan", async () => {
    await holdWithExits("AAPL", 10, 105, { avg: 100 })
    const summary = await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: 100 })])
    expect(summary.executed).toBe(1)
    expect(broker.submitted).toEqual([
      { symbol: "AAPL", qty: "10", side: "sell", type: "market", time_in_force: "day", client_order_id: expect.stringMatching(/^smb-sell-/) },
    ])
    expect(broker.holdings.has("AAPL")).toBe(false)
    expect(broker.allOrders().filter((o) => o.order_class === "oco").every((o) => o.status === "canceled")).toBe(true)
    expect(await recordFor("AAPL")).toMatchObject({ status: "executed", reason: "sold 10 of 10 shares", price: 105, qty: 10, notional: 1050 })
    expect(await plan("AAPL")).toBeNull()
  })

  it("treats a missing or 99.5%+ sell_pct as the whole position", async () => {
    await holdWithExits("AAPL", 10, 100)
    await holdWithExits("MSFT", 3, 400)
    await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: null }), decision({ symbol: "MSFT", action: "sell", sell_pct: 99.5 })])
    expect(broker.holdings.size).toBe(0)
  })

  it("re-protects the shares left after a partial sell", async () => {
    await holdWithExits("AAPL", 10, 105, { stop: 95, target: 110, avg: 100 })
    await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: 50 })])

    expect(broker.holdings.get("AAPL")!.qty).toBe(5)
    const exits = broker.openOrders("AAPL")
    expect(exits.map((o) => [o.type, o.qty, o.limit_price ?? o.stop_price])).toEqual([
      ["limit", "5", "110.00"],
      ["stop", "5", "95.00"],
    ])
    const record = await recordFor("AAPL")
    expect(record).toMatchObject({ reason: "sold 5 of 10 shares", qty: 5, notional: 525 })
    expect(record.order_ids).toHaveLength(2)
    expect(await plan("AAPL")).toMatchObject({ stop_loss: 95, take_profit: 110 })
  })

  it("uses the decision's new levels for the remaining shares", async () => {
    await holdWithExits("AAPL", 10, 105)
    await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: 50, stop_loss: 102, take_profit: 112 })])
    expect(await plan("AAPL")).toMatchObject({ stop_loss: 102, take_profit: 112 })
  })

  it("never lowers the stop on the remaining shares", async () => {
    await holdWithExits("AAPL", 10, 105, { stop: 95, target: 110 })
    await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: 50, stop_loss: 90, take_profit: 112 })])
    expect(broker.openOrders("AAPL").map((o) => o.limit_price ?? o.stop_price)).toEqual(["112.00", "95.00"])
    expect(await plan("AAPL")).toMatchObject({ stop_loss: 95, take_profit: 112 })
  })

  it("doesn't place exits on a fractional remainder", async () => {
    broker.setPosition("AAPL", 10.5, 100)
    await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: 99 })])
    expect(await recordFor("AAPL")).toMatchObject({ status: "executed", qty: 10, reason: "sold 10 of 10.5 shares" })
    expect(broker.holdings.get("AAPL")!.qty).toBeCloseTo(0.5)
    expect(broker.openOrders("AAPL")).toEqual([])
  })

  it("rejects a partial sell that rounds to zero shares", async () => {
    await holdWithExits("AAPL", 5, 100)
    await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: 10 })])
    expect(await recordFor("AAPL")).toMatchObject({ status: "rejected", reason: "sell_pct 10% of 5 shares rounds to 0" })
    expect(broker.openOrders("AAPL")).toHaveLength(2)
  })

  it("sells a single share (or less) outright", async () => {
    await holdWithExits("AAPL", 1, 100)
    await execute([decision({ symbol: "AAPL", action: "sell", sell_pct: 50 })])
    expect(broker.holdings.has("AAPL")).toBe(false)
  })

  it.each([
    ["isn't held", () => undefined],
    ["is short", () => broker.setPosition("AAPL", 5, 100, { side: "short" })],
  ])("rejects selling a symbol that %s", async (_label, setup) => {
    setup()
    await execute([decision({ symbol: "AAPL", action: "sell" })])
    expect(await recordFor("AAPL")).toMatchObject({ status: "rejected", reason: "not currently held" })
  })

  it("retries the sell with the same client_order_id while shares are still reserved", async () => {
    await holdWithExits("AAPL", 10, 100)
    const reserved = new AlpacaError(403, "insufficient qty available for order")
    broker.submitErrors.push(reserved, reserved)
    await execute([decision({ symbol: "AAPL", action: "sell" })])
    expect(broker.submitted).toHaveLength(3)
    expect(new Set(broker.submitted.map((o) => o.client_order_id)).size).toBe(1)
    expect((await recordFor("AAPL")).status).toBe("executed")
  })

  it("fails after 4 attempts", async () => {
    await holdWithExits("AAPL", 10, 100)
    for (let i = 0; i < 4; i++) broker.submitErrors.push(new Error("still reserved"))
    const summary = await execute([decision({ symbol: "AAPL", action: "sell" })])
    expect(broker.submitted).toHaveLength(4)
    expect(summary).toMatchObject({ failed: 1, notes: ["SELL AAPL: still reserved"] })
    expect(broker.holdings.get("AAPL")!.qty).toBe(10)
  })

  it("fails without selling when the exits can't be canceled", async () => {
    await holdWithExits("AAPL", 10, 100)
    broker.stuckCancels.add("AAPL")
    await execute([decision({ symbol: "AAPL", action: "sell" })])
    expect(await recordFor("AAPL")).toMatchObject({ status: "failed", reason: "Timed out cancelling open orders for AAPL" })
    expect(broker.submitted).toEqual([])
  })

  it("records an unfilled sell as submitted", async () => {
    await holdWithExits("AAPL", 10, 100)
    broker.fillMode = "accept"
    await execute([decision({ symbol: "AAPL", action: "sell" })])
    expect(await recordFor("AAPL")).toMatchObject({ status: "executed", reason: "sell submitted (status accepted)", price: 100 })
  })

  it("runs sells first so their cash funds the buys", async () => {
    await holdWithExits("MSFT", 20, 400) // leaves $1,500 deployable
    await execute([decision({ symbol: "AAPL", allocation_pct: 20 }), decision({ symbol: "MSFT", action: "sell" })])
    expect(broker.submitted.map((o) => [o.symbol, o.side])).toEqual([
      ["MSFT", "sell"],
      ["AAPL", "buy"],
    ])
    expect((await recordFor("AAPL")).qty).toBe(20)
  })

  it("won't buy back a symbol sold earlier in the same cycle", async () => {
    await holdWithExits("AAPL", 10, 100)
    await execute([decision({ symbol: "AAPL", action: "sell" }), decision({ symbol: "AAPL", action: "buy" })])
    const results = (await records()).map((r) => [r.action, r.status, r.reason])
    expect(results).toEqual([
      ["sell", "executed", "sold 10 of 10 shares"],
      ["buy", "rejected", "sold within the last 30 minutes"],
    ])
  })

  it("frees a position slot for a buy", async () => {
    for (const s of ["A1", "A2", "A3", "A4", "A5"]) broker.setPosition(s, 1, 10)
    await holdWithExits("MSFT", 2, 400)
    broker.cash = 10_000
    await execute([decision({ symbol: "MSFT", action: "sell" }), decision({ symbol: "AAPL", allocation_pct: 5 })])
    expect((await (await collections()).decisions.findOne({ symbol: "AAPL" }))!.status).toBe("executed")
  })
})

describe("executeDecisions: adjust_exits", () => {
  it("replaces the exits and keeps the original thesis", async () => {
    await holdWithExits("AAPL", 10, 104, { stop: 95, target: 110, avg: 100 })
    await execute([decision({ symbol: "AAPL", action: "adjust_exits", stop_loss: 101, take_profit: 112, horizon: "overnight", invalidation: "Loses 101." })])

    const record = await recordFor("AAPL")
    expect(record).toMatchObject({ status: "executed", reason: "exits replaced", price: 104, qty: 10, stop_loss: 101, take_profit: 112 })
    const open = broker.openOrders("AAPL")
    expect(open.map((o) => o.limit_price ?? o.stop_price)).toEqual(["112.00", "101.00"])
    expect(record.order_ids).toEqual([open[0].id])
    expect(await plan("AAPL")).toMatchObject({
      stop_loss: 101,
      take_profit: 112,
      horizon: "overnight",
      invalidation: "Loses 101.",
      thesis: "AAPL momentum thesis",
      decision_id: "dec-1",
      opened_at: minutesAgo(60),
    })
  })

  it("falls back to the plan's levels and notes any repairs", async () => {
    await holdWithExits("AAPL", 10, 104, { stop: 95, target: 110 })
    await execute([decision({ symbol: "AAPL", action: "adjust_exits" })])
    expect(await recordFor("AAPL")).toMatchObject({ stop_loss: 95, take_profit: 110, reason: "exits replaced" })

    await (await collections()).decisions.deleteMany({})
    await execute([decision({ symbol: "AAPL", action: "adjust_exits", stop_loss: 103.95, take_profit: 120 })])
    // 0.05% below the price is too tight even for a held position.
    expect(await recordFor("AAPL")).toMatchObject({ stop_loss: 101.92, reason: "exits replaced; stop 103.95 too close/above price; default 2% stop" })
  })

  it("never lowers the stop: a lower request keeps the current one", async () => {
    await holdWithExits("AAPL", 10, 104, { stop: 95, target: 110 })
    await execute([decision({ symbol: "AAPL", action: "adjust_exits", stop_loss: 90, take_profit: 112 })])
    expect(await recordFor("AAPL")).toMatchObject({
      status: "executed",
      reason: "exits replaced; stop 90 is below the current stop; kept 95",
      stop_loss: 95,
      take_profit: 112,
    })
    expect(await plan("AAPL")).toMatchObject({ stop_loss: 95, take_profit: 112 })
  })

  it("leaves the resting exits alone when the current stop is no longer usable", async () => {
    // Price has slipped under the stop: a repaired stop would be lower, so nothing is replaced.
    await holdWithExits("AAPL", 10, 94, { stop: 95, target: 110 })
    await execute([decision({ symbol: "AAPL", action: "adjust_exits", stop_loss: 90, take_profit: 112 })])
    expect(await recordFor("AAPL")).toMatchObject({ status: "rejected", reason: "stop would move down from 95 to 92.12; stops only move up" })
    expect(broker.openOrders("AAPL").map((o) => o.limit_price ?? o.stop_price)).toEqual(["110", "95"])
    expect(await plan("AAPL")).toMatchObject({ stop_loss: 95 })
  })

  it("starts a plan for a position that has none", async () => {
    broker.setPosition("AAPL", 10, 100)
    await execute([decision({ symbol: "AAPL", action: "adjust_exits", stop_loss: 97, take_profit: 106, rationale: "Adopting." })])
    const record = await recordFor("AAPL")
    expect(await plan("AAPL")).toMatchObject({ decision_id: record._id, thesis: "Adopting.", opened_at: NOW, stop_loss: 97 })
  })

  it("rejects adjustments it can't place", async () => {
    broker.setPosition("FRAC", 0.5, 100)
    broker.setPosition("ZERO", 5, 0)
    await execute([
      decision({ symbol: "AAPL", action: "adjust_exits" }),
      decision({ symbol: "FRAC", action: "adjust_exits" }),
      decision({ symbol: "ZERO", action: "adjust_exits" }),
    ])
    expect((await recordFor("AAPL")).reason).toBe("not currently held")
    expect((await recordFor("FRAC")).reason).toBe("fractional position: exit orders need whole shares")
    expect((await recordFor("ZERO")).reason).toBe("no current price")
  })

  it("reports a failed replacement (maintenance re-protects the position afterwards)", async () => {
    await holdWithExits("AAPL", 10, 104)
    broker.submitErrors.push(new Error("OCO rejected"))
    const summary = await execute([decision({ symbol: "AAPL", action: "adjust_exits", stop_loss: 101, take_profit: 112 })])
    expect(summary).toMatchObject({ failed: 1, notes: ["ADJUST_EXITS AAPL: OCO rejected"] })
    expect(broker.openOrders("AAPL")).toEqual([])
  })
})

describe("executeDecisions: former core holdings", () => {
  /** SPY was a core holding (with its plain stop) next to a trading position in AAPL; the core book's setting is still on. */
  const withCoreHolding = async () => {
    ctx.settings.current.core.enabled = true
    broker.setPosition("SPY", 6, 500)
    broker.addOrder(alpacaOrder({ symbol: "SPY", side: "sell", type: "stop", qty: "6", stop_price: "425", status: "new", time_in_force: "gtc" }))
    await (await collections()).plans.insertOne(planDoc("SPY", { book: "core", horizon: "multi_day", stop_loss: 425, take_profit: null }))
    await holdWithExits("AAPL", 10, 100)
  }

  it("trades them like any other position, and holds them by default", async () => {
    await withCoreHolding()
    await execute([decision({ symbol: "SPY", action: "sell", sell_pct: 100 })])
    expect(await recordFor("SPY")).toMatchObject({ action: "sell", status: "executed" })
    expect(await recordFor("AAPL")).toMatchObject({ action: "hold", status: "noop" })
  })

  it("keeps no share of equity for the old core book", async () => {
    await withCoreHolding()
    // Equity $10,000, cash $6,000 less the 5% reserve: both buys get their full 20%.
    await execute([decision({ symbol: "MSFT", allocation_pct: 20 }), decision({ symbol: "TSLA", allocation_pct: 20, conviction: 6 })])
    expect(await recordFor("MSFT")).toMatchObject({ status: "executed", qty: 5 }) // $2,000
    expect(await recordFor("TSLA")).toMatchObject({ status: "executed", qty: 8 }) // $2,000
  })
})

describe("executeDecisions: bookkeeping", () => {
  it("prices held positions from the broker when snapshots fail", async () => {
    vi.mocked(alpaca.getSnapshots).mockRejectedValue(new Error("data API down"))
    await holdWithExits("MSFT", 2, 400)
    await execute([decision({ symbol: "MSFT", action: "adjust_exits", stop_loss: 390, take_profit: 420 }), decision({ symbol: "AAPL" })])
    expect(await recordFor("MSFT")).toMatchObject({ status: "executed", price: 400 })
    expect((await recordFor("AAPL")).reason).toBe("no current price")
  })

  it("runs sells, then adjustments, then holds, then buys", async () => {
    await holdWithExits("MSFT", 2, 400)
    await holdWithExits("TSLA", 2, 250)
    await holdWithExits("AMD", 2, 150)
    await execute([
      decision({ symbol: "AAPL", action: "buy" }),
      decision({ symbol: "AMD", action: "hold" }),
      decision({ symbol: "TSLA", action: "adjust_exits" }),
      decision({ symbol: "MSFT", action: "sell" }),
    ])
    expect((await records()).map((r) => r.action)).toEqual(["sell", "adjust_exits", "hold", "buy"])
  })

  it("summarizes every outcome", async () => {
    await holdWithExits("MSFT", 2, 400)
    const summary = await execute([
      decision({ symbol: "AAPL" }),
      decision({ symbol: "NVDA", conviction: 3 }),
      decision({ symbol: "MSFT", action: "hold" }),
      decision({ symbol: "TSLA", action: "sell" }),
    ])
    expect(summary).toEqual({ executed: 1, rejected: 2, failed: 0, noop: 1, notes: [] })
    expect(await records()).toHaveLength(4)
  })

  it("clips long failure reasons", async () => {
    broker.submitErrors.push(new Error("x".repeat(1_000)))
    await execute([decision({ symbol: "AAPL" })])
    expect((await recordFor("AAPL")).reason).toHaveLength(400)
  })
})
