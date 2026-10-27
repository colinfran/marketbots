import { describe, expect, it } from "vitest"
import type { OrderDoc } from "../src/db"
import { fillsFromOrders, orderBook, realizedPnl, type Fill } from "../src/fills"

describe("realizedPnl", () => {
  let seq = 0
  const f = (symbol: string, side: "buy" | "sell", qty: number, price: number, minute: number): Fill => ({
    id: `f${++seq}`,
    symbol,
    side,
    qty,
    price,
    at: new Date(Date.UTC(2026, 9, 26, 14, minute)),
  })

  it("leaves buys without P&L", () => {
    expect(realizedPnl([f("A", "buy", 10, 100, 0)])[0]).toMatchObject({ realized_pnl: null, cost_basis: null })
  })

  it("matches sells against the oldest lots first", () => {
    const result = realizedPnl([f("A", "buy", 10, 100, 0), f("A", "buy", 10, 110, 1), f("A", "sell", 15, 120, 2), f("A", "sell", 5, 90, 3)])
    // 10 @ 100 + 5 @ 110 sold at 120; then the last 5 @ 110 sold at 90.
    expect(result[2]).toMatchObject({ realized_pnl: 250, cost_basis: 103.33 })
    expect(result[3]).toMatchObject({ realized_pnl: -100, cost_basis: 110 })
  })

  it("tracks symbols independently", () => {
    const result = realizedPnl([f("A", "buy", 1, 10, 0), f("B", "buy", 1, 50, 1), f("A", "sell", 1, 12, 2), f("B", "sell", 1, 45, 3)])
    expect(result.map((r) => r.realized_pnl)).toEqual([null, null, 2, -5])
  })

  it("sorts by time before matching and returns fills in time order", () => {
    const sell = f("A", "sell", 10, 110, 5)
    const buy = f("A", "buy", 10, 100, 1)
    const result = realizedPnl([sell, buy])
    expect(result.map((r) => r.id)).toEqual([buy.id, sell.id])
    expect(result[1].realized_pnl).toBe(100)
  })

  it("returns null for sells with no recorded buys (positions that predate the bot)", () => {
    expect(realizedPnl([f("A", "sell", 5, 100, 0)])[0]).toMatchObject({ realized_pnl: null, cost_basis: null })
  })

  it("only counts the matched part of an oversized sell", () => {
    const result = realizedPnl([f("A", "buy", 5, 10, 0), f("A", "sell", 8, 12, 1)])
    expect(result[1]).toMatchObject({ realized_pnl: 10, cost_basis: 10 })
  })

  it("handles fractional shares without leaving dust lots", () => {
    const result = realizedPnl([f("A", "buy", 0.3, 100, 0), f("A", "buy", 0.1, 100, 1), f("A", "sell", 0.4, 110, 2), f("A", "buy", 1, 200, 3), f("A", "sell", 1, 210, 4)])
    expect(result[2].realized_pnl).toBe(4)
    expect(result[4]).toMatchObject({ realized_pnl: 10, cost_basis: 200 })
  })

  it("rounds to cents", () => {
    const result = realizedPnl([f("A", "buy", 3, 10.333, 0), f("A", "sell", 3, 10.5, 1)])
    expect(result[1]).toMatchObject({ realized_pnl: 0.5, cost_basis: 10.33 })
  })

  it("does not mutate its input", () => {
    const input = [f("A", "sell", 1, 10, 2), f("A", "buy", 1, 5, 1)]
    const copy = structuredClone(input)
    realizedPnl(input)
    expect(input).toEqual(copy)
  })
})

describe("realizedPnl for options", () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 14, minute))
  const CALL = "NVDA261120C00140000"

  it("multiplies option P&L by 100 per contract", () => {
    const result = realizedPnl([
      { id: "b", symbol: CALL, side: "buy", qty: 2, price: 5, at: at(0) },
      { id: "s", symbol: CALL, side: "sell", qty: 2, price: 6.5, at: at(1) },
    ])
    expect(result[1].realized_pnl).toBe(300)
  })

  it("opens a short lot for a sold option leg and realizes it on the buy back", () => {
    const result = realizedPnl([
      { id: "s", symbol: CALL, side: "sell", qty: 1, price: 2, at: at(0) },
      { id: "b", symbol: CALL, side: "buy", qty: 1, price: 0.5, at: at(1) },
    ])
    expect(result[0].realized_pnl).toBeNull()
    expect(result[1]).toMatchObject({ realized_pnl: 150, cost_basis: 2 })
  })

  it("never opens short lots for stocks", () => {
    const result = realizedPnl([
      { id: "s", symbol: "AAPL", side: "sell", qty: 5, price: 100, at: at(0) },
      { id: "b", symbol: "AAPL", side: "buy", qty: 5, price: 90, at: at(1) },
    ])
    expect(result.map((r) => r.realized_pnl)).toEqual([null, null])
  })
})

describe("orderBook and fillsFromOrders", () => {
  const doc = (id: string, client: string, o: Partial<OrderDoc> = {}): OrderDoc => ({
    _id: id,
    client_order_id: client,
    symbol: "SPY",
    asset_class: "us_equity",
    underlying: null,
    side: "buy",
    type: "market",
    order_class: "simple",
    role: "entry",
    position_intent: null,
    parent_id: null,
    qty: 1,
    filled_qty: 1,
    filled_avg_price: 500,
    limit_price: null,
    stop_price: null,
    status: "filled",
    created_at: new Date("2026-10-26T14:00:00Z"),
    submitted_at: null,
    filled_at: new Date("2026-10-26T14:00:00Z"),
    canceled_at: null,
    trading_day: "2026-10-26",
    decision_id: null,
    structure_id: null,
    synced_at: new Date("2026-10-26T14:00:00Z"),
    ...o,
  })

  it("tags the core book's orders by their client order id, and legs by their parent's", () => {
    expect(orderBook({ client_order_id: "smb-core-stop-1" })).toBe("core")
    expect(orderBook({ client_order_id: "smb-buy-1" })).toBe("trading")
    expect(orderBook({ client_order_id: "leg-1" }, { client_order_id: "smb-core-buy-1" })).toBe("core")
    const fills = fillsFromOrders(
      [doc("a", "smb-buy-1"), doc("b", "smb-core-stop-2", { side: "sell", filled_at: new Date("2026-10-26T15:00:00Z") })],
    )
    expect(fills.map((f) => [f.id, f.book, f.realized_pnl])).toEqual([
      ["a", "trading", null],
      ["b", "core", 0],
    ])
  })
})
