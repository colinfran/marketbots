import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineContext } from "../../src/bot/context"
import { chartSymbols, refreshCharts, refreshHistory, writeAccountSnapshot } from "../../src/bot/site-data"
import type { EventBus } from "../../src/bus/event-bus"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { makeCtx } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"
import { afterOpen, bar, DAY, decisionDoc, fill, optionPositionDoc } from "../helpers/factories"

const NOW = afterOpen(90)
const db = useTestDb()
let broker: FakeBroker
let ctx: EngineContext
let bus: EventBus

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW })
  broker = fakeBroker()
  ;({ ctx, bus } = await makeCtx(db.col, broker))
})

afterEach(async () => {
  vi.useRealTimers()
  await bus.stop()
})

describe("site data", () => {
  it("copies the account, positions and clock for the website", async () => {
    broker.setPosition("AAPL", 2, 100)
    await writeAccountSnapshot(ctx)
    const doc = (await db.col.cache.findOne({ _id: "alpaca:account" }))!
    expect(doc.fetched_at).toEqual(NOW)
    expect(doc.data).toMatchObject({ account: { equity: "10000" }, positions: [{ symbol: "AAPL", qty: "2" }], clock: { is_open: true }, as_of: NOW.toISOString() })
  })

  it("refreshes only the requested equity history ranges", async () => {
    for (const p of ["1D", "1W"]) broker.history.set(p, { timestamp: [1], equity: [10_000], profit_loss: [0], profit_loss_pct: [0], base_value: 10_000, timeframe: "x" })
    await refreshHistory(ctx, ["1D", "1W"])
    expect((await db.col.cache.find().toArray()).map((d) => d._id).sort()).toEqual(["alpaca:history:1D", "alpaca:history:1W"])
    expect(vi.mocked(broker.client.getPortfolioHistory).mock.calls).toEqual([
      ["1D", "5Min"],
      ["1W", "1H"],
    ])
  })

  it("lists every symbol the bot touched recently, plus what's held", async () => {
    await db.col.decisions.insertOne(decisionDoc({ symbol: "MSFT", created_at: NOW }))
    await db.col.orders.insertOne(fill("TSLA", "buy", 1, 250, NOW))
    await db.col.orders.insertOne(fill("NVDA261120C00140000", "buy", 1, 5, NOW, { asset_class: "us_option" }))
    await db.col.optionPositions.insertOne(optionPositionDoc({ underlying: "AMD", opened_at: NOW }))
    expect((await chartSymbols(ctx, ["AAPL"])).sort()).toEqual(["AAPL", "AMD", "MSFT", "TSLA"])
  })

  it("stores chart bars per range, regular session only", async () => {
    broker.calendar = [{ date: DAY, open: "09:30", close: "16:00" }]
    broker.bars["5Min"] = { AAPL: [bar("09:00", 99), bar("09:30", 100), bar("10:55", 101)] }
    broker.bars["30Min"] = { AAPL: [bar("10:30", 101)] }
    broker.bars["1Day"] = { AAPL: [bar("2026-10-23T04:00:00Z", 98)] }
    await refreshCharts(ctx, ["AAPL"], NOW)
    const doc = (await db.col.cache.findOne({ _id: "chart:AAPL" }))!.data as { ranges: Record<string, { c: number }[]> }
    expect(doc.ranges["1D"].map((b) => b.c)).toEqual([100, 101])
    expect(doc.ranges["1W"].map((b) => b.c)).toEqual([101])
    expect(doc.ranges["6M"].map((b) => b.c)).toEqual([98])
  })
})
