import { utcDay } from "@mb/crypto-core/db"
import { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import type { MarketHub } from "../src/market/hub"
import { Ledger } from "../src/portfolio/ledger"
import { reconcileWallet } from "../src/portfolio/reconcile"
import type { PairInfo } from "../src/venues/kraken/pairs"
import { useTestDb } from "./helpers/db"
import { BTC, fakeHub, FakeWallet, makeBus, quote } from "./helpers/fakes"

const db = useTestDb()

const setup = async (wallet = new FakeWallet()) => {
  const bus = await makeBus(db.col)
  const ledger = new Ledger(db.col, bus)
  await ledger.ensureAccount(10_000)
  const hub = fakeHub() as unknown as MarketHub
  const cli = wallet.cli()
  const executor = new Executor(db.col, ledger, new PaperWalletExecution(cli, hub), bus, silentLogger)
  const buy = (qty: number, limit: number | null = 65_200) =>
    executor.execute({ instrument: "BTC/USD", side: "buy", qty, limitPrice: limit, referencePrice: 65_000, purpose: "entry", decisionId: null, positionId: null, meta: { strategy_id: "trend", stop_price: 63_000, take_profit_price: 70_000 } })
  const sell = (qty: number, limit: number | null = null) =>
    executor.execute({ instrument: "BTC/USD", side: "sell", qty, limitPrice: limit, referencePrice: 65_000, purpose: "exit", decisionId: null, positionId: null, meta: {} })
  return { bus, ledger, executor, cli, wallet, buy, sell, reconcile: () => reconcileWallet({ col: db.col, ledger, executor, cli, log: silentLogger }) }
}

describe("ledger + paper wallet", () => {
  it("books a buy exactly like the wallet: cost + fee out of cash", async () => {
    const { ledger, buy, wallet } = await setup()
    const { order, outcomes } = await buy(0.01)
    expect(order.status).toBe("filled")
    const pos = outcomes[0].position
    expect(pos).toMatchObject({ symbol: "BTC/USD", qty: 0.01, avg_price: 65_010, stop_price: 63_000, strategy_id: "trend" })
    const account = await ledger.account()
    expect(account!.cash_usd).toBeCloseTo(wallet.usd, 8)
    expect(outcomes[0].fill.slippage_bps).toBeCloseTo((10 / 65_000) * 10_000, 2)
  })

  it("realizes P&L net of both fees and closes the position", async () => {
    const { ledger, buy, sell, wallet } = await setup()
    await buy(0.02)
    await sell(0.01)
    const partial = (await ledger.openPositions())[0]
    expect(partial.qty).toBeCloseTo(0.01)
    const { outcomes } = await sell(0.01)
    expect(outcomes[0].closed).toBe(true)
    const closed = outcomes[0].position
    const buyCost = 0.02 * 65_010 * 1.004
    const proceeds = 0.02 * 64_990 * 0.996
    expect(closed.realized_pnl_usd).toBeCloseTo(proceeds - buyCost, 6)
    expect(outcomes[0].returnPct).toBeCloseTo(((proceeds - buyCost) / buyCost) * 100, 2)
    expect((await ledger.account())!.cash_usd).toBeCloseTo(wallet.usd, 6)
  })

  it("doesn't send an order the live book already says is too expensive", async () => {
    const { buy, wallet } = await setup()
    const { order } = await buy(0.01, 65_000) // ask is 65,010
    expect(order.status).toBe("canceled")
    expect(order.reason).toMatch(/moved above the limit/)
    expect(wallet.calls.some((c) => c[1] === "buy")).toBe(false)
  })

  it("records wallet rejections as rejected orders with no position", async () => {
    const { buy, ledger } = await setup(new FakeWallet(100))
    const { order } = await buy(0.01)
    expect(order.status).toBe("rejected")
    expect(order.reason).toMatch(/Insufficient USD/)
    expect(await ledger.openPositions()).toHaveLength(0)
  })

  it("rebuilds drifted cash and quantities from fills", async () => {
    const { ledger, buy } = await setup()
    await buy(0.01)
    await db.col.accounts.updateOne({ _id: "kraken:paper" }, { $inc: { cash_usd: 123 } })
    const issues = await ledger.rebuild()
    expect(issues[0]).toMatch(/^cash/)
    expect((await ledger.account())!.cash_usd).toBeCloseTo(10_000 - 0.01 * 65_010 * 1.004, 6)
  })

  it("marks to market and tracks the peak", async () => {
    const { ledger, buy } = await setup()
    await buy(0.01)
    const account = await ledger.markToMarket(() => 70_000)
    expect(account!.equity_usd).toBeCloseTo(10_000 - 0.01 * 65_010 * 1.004 + 700, 6)
    expect(account!.peak_equity_usd).toBeGreaterThan(10_000)
  })

  it("keeps its open positions between reads, in line with every write it makes", async () => {
    const { ledger, buy, sell } = await setup()
    await buy(0.02)
    const reads = vi.spyOn(db.col.positions, "find")
    const [p] = await ledger.openPositions()
    // A copy: changing it changes nothing kept.
    p.stop_price = 1
    expect((await ledger.openPositions())[0].stop_price).toBe(63_000)
    await ledger.updatePosition(p._id, { stop_price: 64_000 })
    await ledger.markToMarket(() => 66_000)
    const kept = await ledger.openPositions()
    expect(kept).toEqual([expect.objectContaining({ stop_price: 64_000, mark_price: 66_000 })])
    expect(reads).toHaveBeenCalledTimes(1)
    expect(kept).toEqual(await db.col.positions.find({ status: "open" }).toArray())
    reads.mockRestore()
    // A fill that closes it drops the copy: the next read goes to the database.
    await sell(0.02)
    expect(await ledger.openPositions()).toEqual([])
  })

  it("sells all of a large position left by partial sells, leaving no dust in the wallet", async () => {
    // PUMP/USD on 2026-11-05: the books held 19722.990169999986 after four reduces, and the stop
    // sold 19722.99016 of the wallet's 19722.99017.
    const PUMP: PairInfo = { ...BTC, symbol: "PUMP/USD", restPair: "PUMPUSD", altname: "PUMPUSD", base: "PUMP", quote: "ZUSD", priceDecimals: 7, lotDecimals: 5, tickSize: 1e-7, lotStep: 1e-5, orderMin: 0, costMin: 0 }
    const wallet = new FakeWallet(10_000, 0.004, 0, 0.00409, 0.00408)
    const bus = await makeBus(db.col)
    const ledger = new Ledger(db.col, bus)
    await ledger.ensureAccount(10_000)
    const hub = fakeHub({ "PUMP/USD": quote({ symbol: "PUMP/USD", bid: 0.00408, ask: 0.00409, mid: 0.004085 }) }, [PUMP]) as unknown as MarketHub
    const executor = new Executor(db.col, ledger, new PaperWalletExecution(wallet.cli(), hub), bus, silentLogger)
    const order = (side: "buy" | "sell", qty: number) =>
      executor.execute({ instrument: "PUMP/USD", side, qty, limitPrice: null, referencePrice: 0.004085, purpose: side === "buy" ? "entry" : "reduce", decisionId: null, positionId: null, meta: {} })
    await order("buy", 150270.4012)
    for (const qty of [45081.12036, 26297.32021, 39445.98031, 19722.99015]) await order("sell", qty)
    expect(wallet.coins.get("PUMP")).toBe(19722.99017)
    const [position] = await ledger.openPositions()
    const { outcomes } = await order("sell", position.qty)
    expect(outcomes[0]).toMatchObject({ closed: true, fill: { qty: 19722.99017 } })
    expect(wallet.coins.get("PUMP")).toBe(0)
  })
})

describe("reconcileWallet", () => {
  it("is clean when the books match the wallet", async () => {
    const { buy, reconcile } = await setup()
    await buy(0.01)
    expect(await reconcile()).toMatchObject({ ok: true, issues: [], imported: 0 })
  })

  it("recovers an order whose outcome was unknown (timeout after the wallet filled it)", async () => {
    const wallet = new FakeWallet()
    const { buy, reconcile, ledger } = await setup(wallet)
    wallet.failNext = "timeout_after_fill"
    const { order } = await buy(0.01)
    expect(order.status).toBe("unknown")
    expect(await ledger.openPositions()).toHaveLength(0)
    const result = await reconcile()
    expect(result.ok).toBe(true)
    expect(result.resolved).toBe(1)
    const recovered = await db.col.orders.findOne({ _id: order._id })
    expect(recovered).toMatchObject({ status: "filled", filled_qty: 0.01 })
    expect((await ledger.openPositions())[0]).toMatchObject({ qty: 0.01, stop_price: null })
  })

  it("marks an order that never reached the wallet as rejected", async () => {
    const wallet = new FakeWallet()
    const { buy, reconcile } = await setup(wallet)
    wallet.failNext = "timeout"
    const { order } = await buy(0.01)
    expect(order.status).toBe("unknown")
    expect((await reconcile()).ok).toBe(true)
    expect((await db.col.orders.findOne({ _id: order._id }))?.status).toBe("rejected")
  })

  it("imports wallet trades missing from the books", async () => {
    const wallet = new FakeWallet()
    const { reconcile, ledger, cli } = await setup(wallet)
    await cli.marketOrder("buy", "BTC/USD", "0.01") // placed behind the engine's back
    const result = await reconcile()
    expect(result).toMatchObject({ ok: true, imported: 1 })
    expect((await ledger.openPositions())[0].qty).toBeCloseTo(0.01)
  })

  it("reports a balance mismatch it can't explain, which blocks new entries", async () => {
    const wallet = new FakeWallet()
    const { buy, reconcile } = await setup(wallet)
    await buy(0.01)
    wallet.usd += 50
    const result = await reconcile()
    expect(result.ok).toBe(false)
    expect(result.issues[0]).toMatch(/^USD: wallet/)
  })

  it("leaves the dust of a position the books closed out, but not a coin it can't explain", async () => {
    const wallet = new FakeWallet()
    const { buy, sell, reconcile } = await setup(wallet)
    await buy(0.01)
    await sell(0.01)
    wallet.coins.set("BTC", 0.0000001) // $0.0065 at the exit's price: what the ledger closes as dust
    expect(await reconcile()).toMatchObject({ ok: true, issues: [] })
    wallet.coins.set("BTC", 0.001)
    expect(await reconcile()).toMatchObject({ ok: false, issues: ["BTC: wallet holds 0.001 but the books have no open position"] })
    wallet.coins.set("BTC", 0)
    wallet.coins.set("ETH", 0.0000001) // never held
    expect(await reconcile()).toMatchObject({ ok: false, issues: ["ETH: wallet holds 1e-7 but the books have no open position"] })
  })
})

describe("AiCallLog on crypto's day", () => {
  it("counts the day's calls on the UTC day", async () => {
    let now = new Date("2026-10-27T23:59:00Z")
    const log = new AiCallLog(db.col, utcDay, () => now)
    await log.record({ task: "research", model: "local/qwen3.6-35b-a3b-q2", cycle_id: null, input_tokens: 1, output_tokens: 1, cost_usd: 0, cost_source: "local", duration_ms: 1, ok: true, error: null })
    expect(await log.today()).toEqual({ day: "2026-10-27", calls: 1 })
    now = new Date("2026-10-28T00:00:00Z")
    expect(await log.today()).toEqual({ day: "2026-10-28", calls: 0 })
  })
})
