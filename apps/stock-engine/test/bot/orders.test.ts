import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Alpaca } from "../../src/alpaca/client"
import { loadRealizedFills as load, saveOrders as save, syncOrders as sync } from "../../src/bot/orders"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { useTestDb } from "../helpers/db"
import { alpacaOrder, fill, NVDA_CALL_140, NVDA_CALL_150, orderDoc } from "../helpers/factories"

const db = useTestDb()
const orders = async () => db.col.orders
const saveOrders = (list: Parameters<typeof save>[1], decisionId?: string) => save(db.col, list, { decisionId })
const loadRealizedFills = () => load(db.col)
let alpaca: Alpaca
const syncOrders = (lookback?: number) => sync(db.col, alpaca, lookback)

describe("saveOrders", () => {
  it("does nothing for an empty list", async () => {
    await saveOrders([])
    expect(await (await orders()).countDocuments()).toBe(0)
  })

  it("stores a bracket entry and both legs with their roles", async () => {
    const entry = alpacaOrder({
      id: "entry",
      side: "buy",
      order_class: "bracket",
      status: "filled",
      qty: "10",
      filled_qty: "10",
      filled_avg_price: "100.25",
      filled_at: "2026-10-26T14:00:01Z",
      legs: [
        alpacaOrder({ id: "tp", side: "sell", type: "limit", order_class: "bracket", limit_price: "105.00", status: "new" }),
        alpacaOrder({ id: "sl", side: "sell", type: "stop", order_class: "bracket", stop_price: "98.00", status: "held" }),
      ],
    })
    await saveOrders([entry], "dec-1")
    const docs = await (await orders()).find().sort({ _id: 1 }).toArray()
    expect(docs.map((d) => [d._id, d.role, d.parent_id, d.decision_id])).toEqual([
      ["entry", "entry", null, "dec-1"],
      ["sl", "stop_loss", "entry", "dec-1"],
      ["tp", "take_profit", "entry", "dec-1"],
    ])
    const stored = docs.find((d) => d._id === "entry")!
    expect(stored).toMatchObject({
      symbol: "AAPL",
      side: "buy",
      order_class: "bracket",
      qty: 10,
      filled_qty: 10,
      filled_avg_price: 100.25,
      limit_price: null,
      status: "filled",
      filled_at: new Date("2026-10-26T14:00:01Z"),
      canceled_at: null,
      trading_day: "2026-10-26",
    })
    expect(docs.find((d) => d._id === "tp")).toMatchObject({ limit_price: 105, filled_avg_price: null, filled_qty: 0 })
    expect(docs.find((d) => d._id === "sl")).toMatchObject({ stop_price: 98 })
  })

  it("assigns roles to OCO exits and plain orders", async () => {
    await saveOrders([
      alpacaOrder({ id: "oco", side: "sell", type: "limit", order_class: "oco", legs: [alpacaOrder({ id: "oco-stop", side: "sell", type: "stop", order_class: "oco" })] }),
      alpacaOrder({ id: "sell", side: "sell", order_class: "simple" }),
      alpacaOrder({ id: "buy", side: "buy", order_class: "" }),
    ])
    const roles = Object.fromEntries((await (await orders()).find().toArray()).map((d) => [d._id, [d.role, d.order_class]]))
    expect(roles).toEqual({
      oco: ["take_profit", "oco"],
      "oco-stop": ["stop_loss", "oco"],
      sell: ["exit", "simple"],
      buy: ["entry", "simple"],
    })
  })

  it("dates an order by its fill, in New York time", async () => {
    await saveOrders([
      alpacaOrder({ id: "late", created_at: "2026-10-26T19:59:00Z", filled_at: "2026-10-27T01:00:00Z", status: "filled" }),
      alpacaOrder({ id: "open", created_at: "2026-10-27T03:30:00Z" }),
    ])
    const days = Object.fromEntries((await (await orders()).find().toArray()).map((d) => [d._id, d.trading_day]))
    expect(days).toEqual({ late: "2026-10-26", open: "2026-10-26" })
  })

  it("updates orders in place and keeps the decision link when re-synced without one", async () => {
    const order = alpacaOrder({ id: "o1", status: "new" })
    await saveOrders([order], "dec-1")
    await saveOrders([{ ...order, status: "filled", filled_qty: "10", filled_avg_price: "101" }])
    const doc = await (await orders()).findOne({ _id: "o1" })
    expect(doc).toMatchObject({ status: "filled", filled_avg_price: 101, decision_id: "dec-1" })
    expect(await (await orders()).countDocuments()).toBe(1)
  })

  it("records orders the bot didn't place with no decision", async () => {
    await saveOrders([alpacaOrder({ id: "manual" })])
    expect((await (await orders()).findOne({ _id: "manual" }))!.decision_id).toBeNull()
  })

  it("stores an options spread as a parent with entry legs, linked to its options position", async () => {
    const spread = alpacaOrder({
      id: "mleg",
      symbol: "",
      side: "",
      order_class: "mleg",
      status: "filled",
      legs: [
        alpacaOrder({ id: "long", symbol: NVDA_CALL_140, side: "buy", order_class: "mleg", position_intent: "buy_to_open", status: "filled", filled_qty: "2", filled_avg_price: "5" }),
        alpacaOrder({ id: "short", symbol: NVDA_CALL_150, side: "sell", order_class: "mleg", position_intent: "sell_to_open", status: "filled", filled_qty: "2", filled_avg_price: "2" }),
      ],
    })
    await save(db.col, [spread], { decisionId: "dec-1", structureId: "opt-1" })
    const docs = Object.fromEntries((await (await orders()).find().toArray()).map((d) => [d._id, d]))
    expect(docs.mleg).toMatchObject({ role: "spread", asset_class: "us_option", structure_id: "opt-1" })
    expect(docs.long).toMatchObject({ role: "entry", asset_class: "us_option", underlying: "NVDA", parent_id: "mleg", structure_id: "opt-1" })
    expect(docs.short).toMatchObject({ role: "entry", side: "sell", underlying: "NVDA" })
  })

  it("never overwrites a leg's role when it arrives alone (a trade update)", async () => {
    const entry = alpacaOrder({ id: "entry", side: "buy", order_class: "bracket", status: "filled", legs: [alpacaOrder({ id: "sl", side: "sell", type: "stop", order_class: "bracket", status: "held" })] })
    await saveOrders([entry], "dec-1")
    await saveOrders([alpacaOrder({ id: "sl", side: "sell", type: "stop", order_class: "bracket", status: "filled", filled_qty: "10", filled_avg_price: "95" })])
    expect(await (await orders()).findOne({ _id: "sl" })).toMatchObject({ role: "stop_loss", parent_id: "entry", status: "filled", filled_avg_price: 95, decision_id: "dec-1" })
  })
})

describe("syncOrders", () => {
  let broker: FakeBroker
  const NOW = new Date("2026-10-26T20:00:00Z")

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW })
    broker = fakeBroker()
    alpaca = broker.client
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("pulls the last 14 days of orders, nested, newest first", async () => {
    broker.addOrder(alpacaOrder({ id: "recent", created_at: "2026-10-26T15:00:00Z", status: "filled" }))
    await syncOrders()
    expect(alpaca.listOrders).toHaveBeenCalledWith({
      status: "all",
      after: new Date(NOW.getTime() - 14 * 86_400_000).toISOString(),
      until: undefined,
      limit: 500,
      nested: true,
      direction: "desc",
    })
    expect(await (await orders()).findOne({ _id: "recent" })).toMatchObject({ status: "filled" })
  })

  it("honors a custom lookback", async () => {
    await syncOrders(2)
    expect(vi.mocked(alpaca.listOrders).mock.calls[0][0].after).toBe(new Date(NOW.getTime() - 2 * 86_400_000).toISOString())
  })

  it("pages through more than 500 orders", async () => {
    for (let i = 0; i < 503; i++) {
      const at = new Date(Date.UTC(2026, 9, 26, 14, 0, i)).toISOString()
      broker.addOrder(alpacaOrder({ id: `o${i}`, created_at: at, submitted_at: at }))
    }
    await syncOrders()
    expect(alpaca.listOrders).toHaveBeenCalledTimes(2)
    expect(vi.mocked(alpaca.listOrders).mock.calls[1][0].until).toBe(new Date(Date.UTC(2026, 9, 26, 14, 0, 3)).toISOString())
    expect(await (await orders()).countDocuments()).toBe(503)
  })

  it("refreshes older orders still recorded as open, via their parent", async () => {
    const col = await orders()
    // A stop leg from three weeks ago, outside the lookback, that has since filled.
    await col.insertMany([
      orderDoc({ _id: "old-entry", status: "filled", created_at: new Date("2026-10-05T14:00:00Z") }),
      orderDoc({ _id: "old-stop", parent_id: "old-entry", side: "sell", role: "stop_loss", status: "held", filled_qty: 0, filled_avg_price: null }),
      orderDoc({ _id: "gone", status: "new" }),
      orderDoc({ _id: "done", status: "canceled" }),
    ])
    broker.addOrder(
      alpacaOrder({
        id: "old-entry",
        created_at: "2026-10-05T14:00:00Z",
        status: "filled",
        legs: [alpacaOrder({ id: "old-stop", side: "sell", type: "stop", status: "filled", filled_qty: "10", filled_avg_price: "95", filled_at: "2026-10-26T15:00:00Z" })],
      }),
    )
    await syncOrders()
    const refreshed = vi.mocked(alpaca.getOrder).mock.calls.map(([id]) => id).sort()
    expect(refreshed).toEqual(["gone", "old-entry"])
    expect(await col.findOne({ _id: "old-stop" })).toMatchObject({ status: "filled", filled_avg_price: 95, role: "stop_loss" })
    // Orders Alpaca no longer knows about are left as they are.
    expect(await col.findOne({ _id: "gone" })).toMatchObject({ status: "new" })
  })

  it("returns how many fills are on record", async () => {
    broker.addOrder(alpacaOrder({ id: "a", created_at: "2026-10-26T15:00:00Z", status: "filled", filled_qty: "1" }))
    broker.addOrder(alpacaOrder({ id: "b", created_at: "2026-10-26T15:30:00Z", status: "new" }))
    expect(await syncOrders()).toBe(1)
  })

  it("doesn't refresh orders that were just synced or are already final", async () => {
    await (await orders()).insertOne(orderDoc({ _id: "live", status: "new" }))
    broker.addOrder(alpacaOrder({ id: "live", created_at: "2026-10-26T15:00:00Z", status: "new" }))
    await syncOrders()
    expect(alpaca.getOrder).not.toHaveBeenCalled()
  })
})

describe("loadRealizedFills", () => {
  it("returns filled orders with FIFO P&L, roles and decisions (legs inherit their entry's)", async () => {
    const col = await orders()
    await col.insertMany([
      fill("AAPL", "buy", 10, 100, "2026-10-26T14:00:00Z", { _id: "entry", decision_id: "dec-buy" }),
      fill("AAPL", "sell", 10, 104, "2026-10-26T15:00:00Z", { _id: "tp", parent_id: "entry", role: "take_profit" }),
      fill("MSFT", "sell", 2, 400, "2026-10-26T15:30:00Z", { _id: "manual" }),
      orderDoc({ _id: "canceled", status: "canceled", filled_qty: 0 }),
      orderDoc({ _id: "unfilled", status: "new", filled_qty: 0 }),
    ])
    const fills = await loadRealizedFills()
    expect(fills.map((x) => [x.id, x.role, x.decision_id, x.realized_pnl])).toEqual([
      ["entry", "entry", "dec-buy", null],
      ["tp", "take_profit", "dec-buy", 40],
      ["manual", "exit", null, null],
    ])
  })

  it("includes partial fills at their filled quantity", async () => {
    const col = await orders()
    await col.insertMany([
      fill("AAPL", "buy", 10, 100, "2026-10-26T14:00:00Z", { _id: "buy" }),
      orderDoc({ _id: "partial", symbol: "AAPL", side: "sell", status: "partially_filled", qty: 10, filled_qty: 4, filled_avg_price: 105, filled_at: null, created_at: new Date("2026-10-26T15:00:00Z") }),
    ])
    const fills = await loadRealizedFills()
    // No fill time yet: the creation time stands in.
    expect(fills[1]).toMatchObject({ id: "partial", qty: 4, realized_pnl: 20, at: new Date("2026-10-26T15:00:00Z") })
  })

  it("counts option legs (× 100) and leaves spread parents out", async () => {
    const col = await orders()
    await col.insertMany([
      orderDoc({ _id: "spread", symbol: "", side: "", role: "spread", order_class: "mleg", asset_class: "us_option", filled_qty: 1, filled_avg_price: 3, structure_id: "opt-1" }),
      fill(NVDA_CALL_140, "buy", 1, 5, "2026-10-26T14:00:00Z", { _id: "l1", parent_id: "spread", asset_class: "us_option", underlying: "NVDA" }),
      fill(NVDA_CALL_150, "sell", 1, 2, "2026-10-26T14:00:01Z", { _id: "s1", parent_id: "spread", asset_class: "us_option", underlying: "NVDA" }),
      fill(NVDA_CALL_140, "sell", 1, 7, "2026-10-27T14:00:00Z", { _id: "l2", asset_class: "us_option", underlying: "NVDA", role: "exit" }),
      fill(NVDA_CALL_150, "buy", 1, 3, "2026-10-27T14:00:01Z", { _id: "s2", asset_class: "us_option", underlying: "NVDA", role: "exit" }),
    ])
    const fills = await loadRealizedFills()
    expect(fills.map((f) => [f.id, f.realized_pnl, f.structure_id])).toEqual([
      ["l1", null, "opt-1"],
      ["s1", null, "opt-1"],
      ["l2", 200, null],
      ["s2", -100, null],
    ])
  })

  it("returns an empty list with no fills", async () => {
    expect(await loadRealizedFills()).toEqual([])
  })
})
