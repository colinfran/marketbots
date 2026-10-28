import type { EngineEvent } from "@mb/stock-core/events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { EngineContext } from "../../src/bot/context"
import { saveOrders } from "../../src/bot/orders"
import { handleTradeUpdate } from "../../src/bot/trade-updates"
import type { EventBus } from "../../src/bus/event-bus"
import { fakeBroker } from "../helpers/broker"
import { makeCtx, type SentAlert } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { alpacaOrder, fill, NVDA_CALL_140, NVDA_CALL_150 } from "../helpers/factories"

const db = useTestDb()
let ctx: EngineContext
let bus: EventBus
let events: EngineEvent[]
let alerts: SentAlert[]

beforeEach(async () => {
  ;({ ctx, bus, events, alerts } = await makeCtx(db.col, fakeBroker()))
})

afterEach(async () => {
  await bus.stop()
})

describe("handleTradeUpdate", () => {
  it("records a fill and reports a new stock position", async () => {
    const order = alpacaOrder({ id: "b1", symbol: "AAPL", side: "buy", status: "filled", qty: "10", filled_qty: "10", filled_avg_price: "100" })
    expect(await handleTradeUpdate(ctx, { event: "fill", order, price: "100", qty: "10", position_qty: "10" })).toEqual({ filled: true })
    expect(await db.col.orders.findOne({ _id: "b1" })).toMatchObject({ status: "filled", role: "entry" })
    expect(events.map((e) => [e.type, e.summary])).toEqual([
      ["order.filled", "Filled: buy 10 AAPL at $100.00"],
      ["position.opened", "Opened AAPL: 10 shares at $100.00"],
    ])
    expect(alerts).toEqual([{ level: "success", title: "Bought AAPL", message: "[paper] 10 shares at $100.00, $1000.00 in total.", path: "/markets/AAPL", fields: { Stop: null, Target: null } }])
  })

  it("posts a purchase once it's fully filled, with its bracket", async () => {
    const legs = [alpacaOrder({ id: "tp", symbol: "MSFT", side: "sell", type: "limit", limit_price: "460" }), alpacaOrder({ id: "sl", symbol: "MSFT", side: "sell", type: "stop", stop_price: "410" })]
    const entry = (status: "partially_filled" | "filled", filled: string) =>
      alpacaOrder({ id: "b2", symbol: "MSFT", side: "buy", order_class: "bracket", status, qty: "4", filled_qty: filled, filled_avg_price: "430.5", legs })
    await handleTradeUpdate(ctx, { event: "partial_fill", order: entry("partially_filled", "1"), price: "430.5", qty: "1", position_qty: "1" })
    expect(alerts).toEqual([])
    await handleTradeUpdate(ctx, { event: "fill", order: entry("filled", "4"), price: "430.5", qty: "3", position_qty: "4" })
    expect(alerts).toEqual([{ level: "success", title: "Bought MSFT", message: "[paper] 4 shares at $430.50, $1722.00 in total.", path: "/markets/MSFT", fields: { Stop: "$410.00", Target: "$460.00" } }])
  })

  it("reports a broker-triggered stop-loss closing a position, with realized P&L", async () => {
    await db.col.orders.insertOne(fill("AAPL", "buy", 10, 100, "2026-10-26T14:00:00Z", { _id: "entry" }))
    await saveOrders(db.col, [alpacaOrder({ id: "entry", symbol: "AAPL", side: "buy", order_class: "bracket", status: "filled", filled_qty: "10", filled_avg_price: "100", legs: [alpacaOrder({ id: "sl", symbol: "AAPL", side: "sell", type: "stop", order_class: "bracket", status: "held" })] })])
    const stop = alpacaOrder({ id: "sl", symbol: "AAPL", side: "sell", type: "stop", order_class: "bracket", status: "filled", qty: "10", filled_qty: "10", filled_avg_price: "95", filled_at: "2026-10-26T15:00:00Z" })
    await handleTradeUpdate(ctx, { event: "fill", order: stop, price: "95", qty: "10", position_qty: "0" })
    const closed = events.find((e) => e.type === "position.closed")!
    expect(closed.summary).toBe("Closed AAPL (stop-loss): −$50.00")
    expect(closed.data).toMatchObject({ realized_pnl_usd: -50, return_pct: -5, reason: "stop-loss" })
    expect(await db.col.orders.findOne({ _id: "sl" })).toMatchObject({ role: "stop_loss", parent_id: "entry" })
    expect(alerts).toEqual([])
  })

  it("labels option spreads and contracts for people", async () => {
    const spread = alpacaOrder({ id: "m1", symbol: "", side: "", order_class: "mleg", status: "filled", qty: "1", filled_qty: "1", filled_avg_price: "3.5", legs: [alpacaOrder({ symbol: NVDA_CALL_140, side: "buy" }), alpacaOrder({ symbol: NVDA_CALL_150, side: "sell" })] })
    await handleTradeUpdate(ctx, { event: "fill", order: spread, price: "3.5", qty: "1" })
    expect(events[0]).toMatchObject({ type: "order.filled", instrument: "NVDA", summary: "Filled: buy 1 NVDA spread at $3.50", data: { asset_class: "us_option" } })
    expect(alerts).toMatchObject([{ level: "success", title: "Bought NVDA spread", message: "[paper] 1 spread at $3.50, $350.00 in total.", path: "/holdings" }])
    events.length = 0
    await handleTradeUpdate(ctx, { event: "canceled", order: alpacaOrder({ id: "c1", symbol: NVDA_CALL_140, side: "sell", status: "canceled" }) })
    expect(events[0]).toMatchObject({ type: "order.canceled", instrument: "NVDA", summary: "Order canceled: sell NVDA Nov 20 '26 140C", level: "debug" })
  })

  it("flags rejections", async () => {
    expect(await handleTradeUpdate(ctx, { event: "rejected", order: alpacaOrder({ id: "r1", symbol: "AAPL", status: "rejected" }) })).toEqual({ filled: false })
    expect(events[0]).toMatchObject({ type: "order.rejected", level: "warn" })
  })
})
