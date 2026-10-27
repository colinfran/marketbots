import { describe, expect, it } from "vitest"
import { AiBudget } from "../src/ai/budget"
import { CommandProcessor } from "../src/commands/processor"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import { silentLogger } from "../src/log"
import type { MarketHub } from "../src/market/hub"
import { Ledger } from "../src/portfolio/ledger"
import { reconcileWallet } from "../src/portfolio/reconcile"
import { useTestDb } from "./helpers/db"
import { fakeHub, FakeWallet, makeBus } from "./helpers/fakes"

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
})

describe("EventBus", () => {
  it("assigns increasing seqs, persists, and replays from memory and the database", async () => {
    const bus = await makeBus(db.col)
    const a = bus.emit("alert", { level: "info", title: "a", message: "a" }, { summary: "a" })
    const b = bus.emit("alert", { level: "info", title: "b", message: "b" }, { summary: "b" })
    const tick = bus.emit("market.ticker", { symbol: "BTC/USD", bid: 1, ask: 2, last: 1.5, change_pct: null }, { summary: "t" })
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(tick.seq).toBe(0)
    await bus.flush()
    expect(await db.col.events.countDocuments()).toBe(2)
    expect((await bus.replay(a.seq)).events.map((e) => e.summary)).toEqual(["b"])
    // A new bus (engine restart) continues after the stored seqs and replays from MongoDB.
    const restarted = await makeBus(db.col)
    const c = restarted.emit("alert", { level: "info", title: "c", message: "c" }, { summary: "c" })
    expect(c.seq).toBeGreaterThan(b.seq)
    expect((await restarted.replay(0)).events.map((e) => e.summary)).toEqual(["a", "b", "c"])
    await bus.stop()
    await restarted.stop()
  })
})

describe("CommandProcessor", () => {
  it("re-validates, executes, and expires stale risk-increasing commands", async () => {
    const bus = await makeBus(db.col)
    const handled: string[] = []
    const processor = new CommandProcessor(db.col, bus, silentLogger, async (c) => {
      handled.push(c.type)
      return "ok"
    })
    const now = new Date()
    const old = new Date(Date.now() - 60 * 60_000)
    await db.col.commands.insertMany([
      { _id: "1", type: "pause", command: { type: "pause" }, status: "pending", created_at: old, created_by: "owner", processed_at: null, result: null, error: null },
      { _id: "2", type: "resume", command: { type: "resume" }, status: "pending", created_at: old, created_by: "owner", processed_at: null, result: null, error: null },
      { _id: "3", type: "settings.update", command: { type: "settings.update", patch: {}, expected_version: -1 } as never, status: "pending", created_at: now, created_by: "owner", processed_at: null, result: null, error: null },
    ])
    await processor.drain()
    expect(handled).toEqual(["pause"])
    const docs = Object.fromEntries((await db.col.commands.find().toArray()).map((d) => [d._id, d]))
    expect(docs["1"].status).toBe("done")
    expect(docs["2"]).toMatchObject({ status: "rejected", error: expect.stringMatching(/expired/) })
    expect(docs["3"].status).toBe("rejected")
    expect(await db.col.audit.countDocuments()).toBe(3)
    await bus.stop()
  })
})

describe("AiBudget", () => {
  it("sums today's spend and blocks calls that don't fit", async () => {
    const budget = new AiBudget(db.col, () => 1)
    await budget.record({ task: "research", model: "m", cycle_id: null, input_tokens: 1, output_tokens: 1, cost_usd: 0.9, cost_source: "gateway", duration_ms: 1, ok: true, error: null })
    expect((await budget.canAfford(0.05)).ok).toBe(true)
    expect((await budget.canAfford(0.2)).ok).toBe(false)
    expect(await budget.estimate("decision")).toBe(0.06)
  })
})
