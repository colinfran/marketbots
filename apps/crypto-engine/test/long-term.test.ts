import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import type { Alerts } from "../src/alerts"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import type { CandleCache } from "../src/market/candles"
import type { MarketHub } from "../src/market/hub"
import type { EngineContext } from "../src/orchestrator/context"
import { CryptoLongTerm, weekStartUtc } from "../src/orchestrator/long-term"
import { Ledger } from "../src/portfolio/ledger"
import type { EngineStateStore, SettingsStore } from "../src/state/stores"
import type { Candle } from "../src/venues/kraken/rest"
import { useTestDb } from "./helpers/db"
import { BTC, fakeHub, FakeWallet, makeBus, quote } from "./helpers/fakes"

const db = useTestDb()
const DAY = 86_400_000
/** Friday 2026-11-06, 21:05 UTC: the last completed week ended Monday 2026-11-02 00:00. */
const NOW = new Date("2026-11-06T21:05:00Z")
const ETH = { ...BTC, symbol: "ETH/USD", restPair: "XETHZUSD", altname: "ETHUSD", base: "XETH" }

/** 300 completed daily candles ending yesterday: flat at 100, then the last `tail` days at `last`. */
const candles = (last: number, tail = 20): Candle[] =>
  Array.from({ length: 300 }, (_, i) => {
    const t = Date.UTC(2026, 10, 5) - (299 - i) * DAY
    const close = i >= 300 - tail ? last : 100
    return { t, open: close, high: close, low: close, close, vwap: close, volume: 1, trades: 1 }
  })

const setup = async ({ paused = null as string | null, settings = DEFAULT_SETTINGS } = {}) => {
  const bus = await makeBus(db.col)
  const hub = fakeHub({ "BTC/USD": quote(), "ETH/USD": quote({ symbol: "ETH/USD" }) }, [BTC, ETH]) as unknown as MarketHub
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
  const series = new Map<string, Candle[]>([
    ["BTC/USD", candles(110)],
    ["ETH/USD", candles(110)],
  ])
  const book = new CryptoLongTerm(ctx, () => paused, () => false, async (symbol) => series.get(symbol)!)
  return { ctx, book, alerts, series }
}

describe("the crypto long-term book", () => {
  it("knows the week starts on Monday, UTC", () => {
    expect(new Date(weekStartUtc(NOW.getTime())).toISOString()).toBe("2026-11-02T00:00:00.000Z")
    expect(new Date(weekStartUtc(Date.parse("2026-11-02T00:00:00Z"))).toISOString()).toBe("2026-11-02T00:00:00.000Z")
    expect(new Date(weekStartUtc(Date.parse("2026-11-01T23:59:00Z"))).toISOString()).toBe("2026-10-26T00:00:00.000Z")
  })

  it("buys BTC at 25% and ETH at 15% of equity when last week closed above the 200-day, with no stop or target, past the 20% per-position cap", async () => {
    const { ctx, book } = await setup()
    await book.tick(NOW)
    const open = await ctx.ledger.openPositions()
    const value = (s: string) => {
      const p = open.find((x) => x.symbol === s)!
      return p.qty * p.avg_price
    }
    expect(open.map((p) => [p.symbol, p.strategy_id, p.stop_price, p.take_profit_price, p.trail_usd])).toEqual([
      ["BTC/USD", "long_term", null, null, null],
      ["ETH/USD", "long_term", null, null, null],
    ])
    expect(value("BTC/USD")).toBeGreaterThan(2_400)
    expect(value("BTC/USD")).toBeLessThan(2_510)
    expect(value("ETH/USD")).toBeGreaterThan(1_400)
    expect(value("ETH/USD")).toBeLessThan(1_510)
    const docs = await ctx.col.decisions.find().toArray()
    expect(docs.map((d) => [d.symbol, d.trigger_kind, d.model, d.prompt_version, d.execution.status])).toEqual([
      ["BTC/USD", "long_term", "rules", "long-term-v1", "filled"],
      ["ETH/USD", "long_term", "rules", "long-term-v1", "filled"],
    ])
    expect(docs[0].risk?.checks.map((c) => c.name)).not.toContain("stop_distance")
  })

  it("sells a holding after a week closing below its 200-day average, and buys it back only after a week closing above", async () => {
    // The risk engine's re-entry cooldown runs on the real clock; a real buy-back comes a week after the sale.
    const { ctx, book, alerts, series } = await setup({ settings: { ...DEFAULT_SETTINGS, kraken: { ...DEFAULT_SETTINGS.kraken, reentry_cooldown_minutes: 0 } } })
    await book.tick(NOW)
    series.set("BTC/USD", candles(90))
    await ctx.col.positions.updateMany({}, { $set: { opened_at: new Date(NOW.getTime() - 7 * DAY) } })
    ctx.ledger.forgetOpenPositions()
    await book.tick(new Date(NOW.getTime() + 3_600_000))
    expect((await ctx.ledger.openPositions()).map((p) => p.symbol)).toEqual(["ETH/USD"])
    expect(alerts.success).toHaveBeenCalledWith("Long-term book sold BTC/USD", expect.stringContaining("long-term trend broke"), expect.anything())
    // Still below: nothing bought back.
    await book.tick(new Date(NOW.getTime() + 2 * 3_600_000))
    expect((await ctx.ledger.openPositions()).map((p) => p.symbol)).toEqual(["ETH/USD"])
    series.set("BTC/USD", candles(110))
    await book.tick(new Date(NOW.getTime() + 3 * 3_600_000))
    expect((await ctx.ledger.openPositions()).map((p) => p.symbol).sort()).toEqual(["BTC/USD", "ETH/USD"])
  })

  it("opens nothing while entries are paused or below the 200-day, and leaves a pair the agent holds alone", async () => {
    const paused = await setup({ paused: "entries paused by a breaker until the owner resumes them: drawdown" })
    await paused.book.tick(NOW)
    expect(await paused.ctx.ledger.openPositions()).toEqual([])
    await db.col.decisions.deleteMany({})

    const below = await setup()
    below.series.set("BTC/USD", candles(90))
    below.series.set("ETH/USD", candles(90))
    await below.book.tick(NOW)
    expect(await below.ctx.ledger.openPositions()).toEqual([])

    const held = await setup()
    await held.ctx.col.positions.insertOne({ _id: "agent-btc", account_id: "kraken:paper", instrument: "BTC/USD", symbol: "BTC/USD", status: "open", strategy_id: "trend", qty: 0.01, avg_price: 65_000, cost_basis_usd: 650 } as never)
    held.ctx.ledger.forgetOpenPositions()
    await held.book.tick(NOW)
    expect((await held.ctx.ledger.openPositions()).map((p) => [p.symbol, p.strategy_id])).toEqual([
      ["BTC/USD", "trend"],
      ["ETH/USD", "long_term"],
    ])
  })
})
