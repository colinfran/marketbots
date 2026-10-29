import { describe, expect, it } from "vitest"
import { ShadowBook, type ShadowEntry } from "../src/shadow"
import { useAgentDb } from "./helpers"

const entry = (e: Partial<ShadowEntry> = {}): ShadowEntry => ({
  symbol: "SOL/USD",
  qty: 10,
  reference: 100,
  episodeId: "e1",
  stop: 95,
  target: 110,
  horizon: "48",
  strategy: "trend",
  thesis: "breakout",
  invalidation: "below 95",
  conviction: 70,
  ...e,
})

describe("shadow book", () => {
  const db = useAgentDb()
  let t = new Date("2026-10-28T14:00:00Z")
  const book = (costs = { feeBps: 40, slippageBps: 5 }) => {
    const events: { summary: string; data: unknown }[] = []
    const b = new ShadowBook(db.col, { startingUsd: () => 10_000, costs: () => costs, bus: { emit: (_t, data, meta) => events.push({ summary: meta.summary, data }) }, day: (d) => d.toISOString().slice(0, 10), now: () => t })
    return { b, events }
  }

  it("buys at the ask plus slippage with the fee, and sells at the bid minus it", async () => {
    const { b, events } = book()
    const bought = await b.buy(entry())
    expect(bought.ok).toBe(true)
    if (!bought.ok) return
    expect(bought.fill.price).toBeCloseTo(100.05, 6)
    expect(bought.fill.fee_usd).toBeCloseTo(4.002, 6)
    expect(await b.cash()).toBeCloseTo(10_000 - 1_000.5 - 4.002, 6)

    t = new Date("2026-10-28T16:00:00Z")
    const fill = (await b.sell(bought.position, { reference: 105, reason: "exit", episodeId: "e2" }))!
    expect(fill.price).toBeCloseTo(104.9475, 6)
    const proceeds = 10 * 104.9475
    expect(fill.realized_pnl_usd).toBeCloseTo(proceeds - proceeds * 0.004 - 1_004.502, 6)
    const closed = await db.col.shadowPositions.findOne({ _id: bought.position._id })
    expect(closed).toMatchObject({ status: "closed", qty: 0, exit_reason: "exit" })
    const account = await b.account(() => null)
    expect(account.open_positions).toBe(0)
    expect(account.equity_usd).toBeCloseTo(10_000 + fill.realized_pnl_usd!, 1)
    expect(account.realized_pnl_usd).toBeCloseTo(fill.realized_pnl_usd!, 1)
    expect(events.map((e) => e.summary)).toEqual(["Agent (shadow) bought 10 SOL/USD at 100.05", expect.stringMatching(/^Agent \(shadow\) sold 10 SOL\/USD at 104\.9475 \(exit\): \+\$4[0-9.]+$/)])
  })

  it("refuses a second position in a symbol and a buy it can't pay for", async () => {
    const { b } = book()
    await b.buy(entry())
    expect(await b.buy(entry())).toEqual({ ok: false, reason: "SOL/USD is already in the shadow book" })
    expect(await b.buy(entry({ symbol: "BTC/USD", qty: 1, reference: 65_000 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/^the shadow book has \$8995/) })
  })

  it("reduces a position proportionally and keeps it open", async () => {
    const { b } = book({ feeBps: 0, slippageBps: 0 })
    const r = await b.buy(entry())
    if (!r.ok) throw new Error(r.reason)
    await b.sell(r.position, { qty: 4, reference: 110, reason: "reduce", episodeId: "e2" })
    const p = (await b.position("SOL/USD"))!
    expect(p).toMatchObject({ status: "open", qty: 6, cost_usd: 600, realized_pnl_usd: 40 })
    const account = await b.account(() => 110)
    expect(account).toMatchObject({ equity_usd: 10_100, exposure_usd: 660, unrealized_pnl_usd: 60, realized_pnl_usd: 40, return_pct: 1 })
  })

  it("fills stops and targets at the price a sale would get, and only moves stops up", async () => {
    const { b } = book({ feeBps: 0, slippageBps: 0 })
    const r = await b.buy(entry())
    if (!r.ok) throw new Error(r.reason)
    expect(await b.update(r.position, { stop: 90 })).toMatchObject({ stop: 95, raised: false })
    expect(await b.update(r.position, { stop: 97 })).toMatchObject({ stop: 97, raised: true })
    expect(await b.checkExits(() => 98)).toEqual([])
    const [fill] = await b.checkExits(() => 96.5)
    expect(fill).toMatchObject({ side: "sell", reason: "stop_loss", price: 96.5, episode_id: null })
  })

  it("gives the envelope its history: entries, actions, exits and stop-outs", async () => {
    const { b } = book({ feeBps: 0, slippageBps: 0 })
    const r = await b.buy(entry())
    if (!r.ok) throw new Error(r.reason)
    await b.checkExits(() => 94)
    const h = await b.envelopeHistory(9_950)
    expect(h.entries).toEqual([{ symbol: "SOL/USD", at: t.getTime(), notionalUsd: 1_000 }])
    expect(h.lastAction.get("SOL/USD")).toBe(t.getTime())
    expect(h.lastStopOut.get("SOL/USD")).toBe(t.getTime())
    expect(h.lastExit.get("SOL/USD")).toBe(t.getTime())
    expect(h.openPositions).toBe(0)
  })
})
