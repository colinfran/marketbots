import { DEFAULT_SETTINGS, type Settings } from "@mb/crypto-core/settings"
import { silentLogger } from "@mb/engine-kit/log"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Alerts } from "../src/alerts"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import type { CandleCache } from "../src/market/candles"
import type { MarketHub } from "../src/market/hub"
import type { EngineContext } from "../src/orchestrator/context"
import { CryptoLongTerm } from "../src/orchestrator/long-term"
import { Ledger } from "../src/portfolio/ledger"
import type { EngineStateStore, SettingsStore } from "../src/state/stores"
import { useTestDb } from "./helpers/db"
import { BTC, fakeHub, FakeWallet, makeBus, quote } from "./helpers/fakes"

const db = useTestDb()
const HOUR = 3_600_000
/** Friday 2026-11-20, 08:05 UTC: 5 minutes past the hour, after the hourly candle settles. */
const NOW = Date.parse("2026-11-20T08:05:00Z")
const ETH = { ...BTC, symbol: "ETH/USD", restPair: "XETHZUSD", altname: "ETHUSD", base: "XETH" }
const SOL = { ...BTC, symbol: "SOL/USD", restPair: "SOLUSD", altname: "SOLUSD", base: "SOL" }

// The fills' opened_at comes from the clock: the book's stagger counts from it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
})

const setup = async ({ paused = null as string | null, settings = DEFAULT_SETTINGS as Settings } = {}) => {
  const bus = await makeBus(db.col)
  const quotes = { "BTC/USD": quote(), "ETH/USD": quote({ symbol: "ETH/USD" }), "SOL/USD": quote({ symbol: "SOL/USD" }) }
  const hub = fakeHub(quotes, [BTC, ETH, SOL]) as unknown as MarketHub
  const ledger = new Ledger(db.col, bus)
  await ledger.ensureAccount(10_000)
  const alerts = { send: vi.fn(), success: vi.fn(async () => undefined) }
  const ctx: EngineContext = {
    col: db.col,
    log: silentLogger,
    bus,
    settings: { current: settings, version: 3 } as unknown as SettingsStore,
    state: { state: { status: "running", kill_switch: { engaged: false } } } as unknown as EngineStateStore,
    hub,
    candles: { get: async () => Promise.reject(new Error("no candles in this test")), expire: vi.fn() } as unknown as CandleCache,
    ledger,
    executor: new Executor(db.col, ledger, new PaperWalletExecution(new FakeWallet(100_000).cli(), hub), bus, silentLogger),
    alerts: alerts as unknown as Alerts,
    gate: () => ({ runStatus: "running", killSwitch: false, venueOnline: true, reconciled: true }),
    feeBps: () => 40,
    setCycleState: () => undefined,
    signal: new AbortController().signal,
  }
  const book = new CryptoLongTerm(ctx, () => paused, () => false)
  /** The book's hourly run `hours` after NOW. */
  const tickAt = async (hours: number) => {
    vi.setSystemTime(NOW + hours * HOUR)
    await book.tick(new Date())
  }
  return { ctx, book, quotes, tickAt }
}

const held = async (ctx: EngineContext) => (await ctx.ledger.openPositions()).map((p) => p.symbol).sort()
const value = async (ctx: EngineContext, symbol: string) => {
  const p = (await ctx.ledger.openPositions()).find((x) => x.symbol === symbol)!
  return p.qty * p.avg_price
}

describe("the crypto long-term book", () => {
  it("buys BTC first, at 30% of equity, with no stop or target, past the 20% per-position cap", async () => {
    const { ctx, tickAt } = await setup()
    await tickAt(0)
    const open = await ctx.ledger.openPositions()
    expect(open.map((p) => [p.symbol, p.strategy_id, p.stop_price, p.take_profit_price, p.trail_usd])).toEqual([["BTC/USD", "long_term", null, null, null]])
    expect(await value(ctx, "BTC/USD")).toBeGreaterThan(2_900)
    expect(await value(ctx, "BTC/USD")).toBeLessThanOrEqual(3_000)
    const docs = await ctx.col.decisions.find().toArray()
    expect(docs.map((d) => [d.symbol, d.trigger_kind, d.model, d.prompt_version, d.execution.status])).toEqual([["BTC/USD", "long_term", "rules", "long-term-v2", "filled"]])
    expect(docs[0].risk?.checks.map((c) => c.name)).not.toContain("stop_distance")
    expect(docs[0].sizing.notes[0]).toBe("30% of equity, held long term: no stop or target; only the owner sells it")
  })

  it("spreads its buys stagger_hours clock hours apart: ETH 4 hours after BTC, then SOL; with 0, all in one hour", async () => {
    const { ctx, tickAt } = await setup()
    await tickAt(0)
    for (const h of [1, 2, 3]) await tickAt(h)
    expect(await held(ctx)).toEqual(["BTC/USD"])
    await tickAt(4)
    expect(await held(ctx)).toEqual(["BTC/USD", "ETH/USD"])
    await tickAt(7)
    expect(await held(ctx)).toEqual(["BTC/USD", "ETH/USD"])
    await tickAt(8)
    expect(await held(ctx)).toEqual(["BTC/USD", "ETH/USD", "SOL/USD"])
    expect(await value(ctx, "ETH/USD")).toBeGreaterThan(1_400)
    expect(await value(ctx, "SOL/USD")).toBeGreaterThan(1_400)
    // Nothing more once all three are held.
    await tickAt(12)
    expect(await ctx.col.decisions.countDocuments()).toBe(3)

    await db.col.positions.deleteMany({})
    await db.col.decisions.deleteMany({})
    const together = await setup({ settings: { ...DEFAULT_SETTINGS, long_term: { ...DEFAULT_SETTINGS.long_term, stagger_hours: 0 } } })
    await together.tickAt(0)
    expect(await held(together.ctx)).toEqual(["BTC/USD", "ETH/USD", "SOL/USD"])
  })

  it("never sells: a holding 30% down stays, and nothing is bought on top of it", async () => {
    const { ctx, quotes, tickAt } = await setup({ settings: { ...DEFAULT_SETTINGS, long_term: { ...DEFAULT_SETTINGS.long_term, eth_pct: 0, sol_pct: 0 } } })
    await tickAt(0)
    quotes["BTC/USD"] = quote({ bid: 45_490, ask: 45_510, mid: 45_500 })
    for (const h of [1, 24, 24 * 7, 24 * 60]) await tickAt(h)
    const [p] = await ctx.ledger.openPositions()
    expect([p.symbol, p.status]).toEqual(["BTC/USD", "open"])
    expect(await ctx.col.decisions.countDocuments()).toBe(1)
    expect(await ctx.col.orders.countDocuments({ side: "sell" })).toBe(0)
  })

  it("buys nothing while entries are paused, and leaves a pair another book holds alone", async () => {
    const paused = await setup({ paused: "entries paused by a breaker until the owner resumes them: drawdown" })
    await paused.tickAt(0)
    expect(await paused.ctx.ledger.openPositions()).toEqual([])
    await db.col.decisions.deleteMany({})

    const other = await setup()
    await other.ctx.col.positions.insertOne({ _id: "agent-btc", account_id: "kraken:paper", instrument: "BTC/USD", symbol: "BTC/USD", status: "open", strategy_id: "trend", qty: 0.01, avg_price: 65_000, cost_basis_usd: 650 } as never)
    other.ctx.ledger.forgetOpenPositions()
    await other.tickAt(0)
    expect((await other.ctx.ledger.openPositions()).map((p) => [p.symbol, p.strategy_id])).toEqual([
      ["BTC/USD", "trend"],
      ["ETH/USD", "long_term"],
    ])
  })
})
