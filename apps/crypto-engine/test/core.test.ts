import type { Observation } from "@mb/core/agent"
import type { CryptoAgentAnswer } from "@mb/crypto-core/agent"
import { DEFAULT_SETTINGS, type Settings } from "@mb/crypto-core/settings"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import type { CryptoAgentDeps } from "../src/agent/book"
import { actOnCryptoAnswer } from "../src/agent/live"
import type { Alerts } from "../src/alerts"
import { Executor } from "../src/execution/executor"
import { PaperWalletExecution } from "../src/execution/paper-wallet"
import type { CandleCache } from "../src/market/candles"
import type { Features } from "../src/market/features"
import type { MarketHub } from "../src/market/hub"
import type { EngineContext } from "../src/orchestrator/context"
import { CryptoCore } from "../src/orchestrator/core"
import { Ledger } from "../src/portfolio/ledger"
import type { EngineStateStore, SettingsStore } from "../src/state/stores"
import { coreCandidates, coreRegime, coreTrendBroken } from "../src/strategies/core"
import { useTestDb } from "./helpers/db"
import { fakeHub, FakeWallet, makeBus, quote } from "./helpers/fakes"

const db = useTestDb()

/** BTC/USD's features: by default in a long-term uptrend, up 12% in 30 days at a 3% daily ATR. */
const features = (o: Partial<Features> = {}): Features => ({
  symbol: "BTC/USD",
  price: 65_000,
  bid: 64_990,
  ask: 65_010,
  spread_bps: 3,
  quote_age_s: 1,
  as_of: Date.now(),
  ret_1h_pct: 0.1,
  ret_4h_pct: 0.5,
  ret_24h_pct: 1,
  ret_7d_pct: 4,
  ret_30d_pct: 12,
  ema20_1h: 64_500,
  ema50_1h: 64_000,
  ema20_4h: 64_000,
  ema50_4h: 63_000,
  sma50_1d: 60_000,
  sma200_1d: 50_000,
  trend_1h: "up",
  trend_4h: "up",
  trend_1d: "up",
  rsi14_1h: 60,
  rsi14_4h: 60,
  rsi14_1d: 62,
  atr_1h: 400,
  atr_pct_1h: 0.6,
  atr_pct_4h: 1.2,
  atr_pct_1d: 3,
  bb_lower_1h: 64_000,
  bb_upper_1h: 66_000,
  bb_pct_b_1h: 0.6,
  high_20x4h: 65_500,
  low_20x4h: 60_000,
  breakout_4h: false,
  vol_7d_pct: 40,
  vol_30d_pct: 45,
  volume_ratio_24h: 1.1,
  move_zscore_24h: 0.4,
  closes_1h: [],
  ...o,
})

describe("the trend core's rules", () => {
  it("opens positions only while BTC is above its 50-day average", () => {
    expect(coreRegime(features())).toEqual({ on: true, detail: "BTC +8.33% vs its 50-day average" })
    expect(coreRegime(features({ price: 59_000 })).on).toBe(false)
    expect(coreRegime(undefined).on).toBe(false)
  })

  it("takes pairs in a long-term uptrend with 30-day momentum, strongest per unit of volatility first, with a 2.5-ATR stop", () => {
    const strong = features({ symbol: "SOL/USD", price: 200, sma50_1d: 180, sma200_1d: 150, ret_30d_pct: 30, atr_pct_1d: 5 })
    const [a, b] = coreCandidates([features(), strong], DEFAULT_SETTINGS)
    // 30 / 5 = 6 beats 12 / 3 = 4.
    expect([a.symbol, b.symbol]).toEqual(["SOL/USD", "BTC/USD"])
    expect(a).toMatchObject({ strategy: "core", features: expect.objectContaining({ strength: 6 }) })
    expect(b.stop_hint).toBeCloseTo(65_000 * (1 - 0.075)) // 2.5 × 3% daily ATR
    // A 6% daily ATR would put the stop 15% away: it is kept at the 12% maximum.
    expect(coreCandidates([features({ atr_pct_1d: 6 })], DEFAULT_SETTINGS)[0].stop_hint).toBeCloseTo(65_000 * 0.88)
  })

  it("passes on broken trends, falling momentum and overbought tape", () => {
    expect(coreCandidates([features({ price: 59_000 })], DEFAULT_SETTINGS)).toEqual([]) // below the 50-day
    expect(coreCandidates([features({ sma50_1d: 49_000 })], DEFAULT_SETTINGS)).toEqual([]) // 50-day under the 200-day
    expect(coreCandidates([features({ ret_30d_pct: -2 })], DEFAULT_SETTINGS)).toEqual([])
    expect(coreCandidates([features({ rsi14_1d: 82 })], DEFAULT_SETTINGS)).toEqual([])
    expect(coreCandidates([features({ sma200_1d: null })], DEFAULT_SETTINGS)).toEqual([])
  })

  it("ends a trend below the 50-day average", () => {
    expect(coreTrendBroken({ price: 59_999, sma50_1d: 60_000 })).toBe(true)
    expect(coreTrendBroken({ price: 60_001, sma50_1d: 60_000 })).toBe(false)
  })
})

describe("the trend core on the paper account", () => {
  const setup = async ({ paused = null as string | null, busy = false, settings = DEFAULT_SETTINGS } = {}) => {
    const bus = await makeBus(db.col)
    const quotes = { "BTC/USD": quote() }
    const hub = fakeHub(quotes) as unknown as MarketHub
    const ledger = new Ledger(db.col, bus)
    await ledger.ensureAccount(10_000)
    const alerts = { send: vi.fn(), success: vi.fn(async () => undefined) }
    const ctx: EngineContext = {
      col: db.col,
      log: silentLogger,
      bus,
      settings: { current: { ...settings, universe: { kraken_symbols: ["BTC/USD"] } }, version: 3 } as unknown as SettingsStore,
      state: { state: { status: "running", kill_switch: { engaged: false } } } as unknown as EngineStateStore,
      hub,
      candles: { get: async () => Promise.reject(new Error("no candles in this test")), expire: vi.fn() } as unknown as CandleCache,
      ledger,
      executor: new Executor(db.col, ledger, new PaperWalletExecution(new FakeWallet().cli(), hub), bus, silentLogger),
      alerts: alerts as unknown as Alerts,
      gate: () => ({ runStatus: "running", killSwitch: false, venueOnline: true, reconciled: true }),
      feeBps: () => 40,
      setCycleState: () => undefined,
      signal: new AbortController().signal,
    }
    let current = features()
    const core = new CryptoCore(ctx, () => paused, () => busy, async () => [current])
    return { ctx, core, alerts, quotes, setFeatures: (f: Features) => (current = f) }
  }
  /** `minutes` past 13:00 UTC on 2026-11-06, `days` later. */
  const at = (minutes: number, days = 0) => new Date(Date.parse("2026-11-06T13:00:00Z") + days * 86_400_000 + minutes * 60_000)

  it("buys the strongest qualifying pair once an hour, risking 1% at its stop with no target, and records a rules decision", async () => {
    const { ctx, core, alerts } = await setup()
    await core.tick(at(1)) // the hour's candle may not have closed yet
    expect(await ctx.ledger.openPositions()).toEqual([])
    await core.tick(at(5))
    const [p] = await ctx.ledger.openPositions()
    expect(p).toMatchObject({ symbol: "BTC/USD", strategy_id: "core", take_profit_price: null })
    // $100 at risk over the 4,885 from the ask to the 60,125 stop: about $1,330.
    expect(p.qty * p.avg_price).toBeGreaterThan(1_250)
    expect(p.qty * p.avg_price).toBeLessThan(1_400)
    expect(p.trail_usd).toBeCloseTo(65_010 - 60_125)
    const [doc] = await ctx.col.decisions.find().toArray()
    expect(doc).toMatchObject({ trigger_kind: "core", model: "rules", prompt_version: "trend-core-v1", strategy_id: "core", execution: { status: "filled" }, sizing: { take_profit_price: null } })
    expect(doc.risk?.checks.map((c) => c.name)).toContain("rules_entry")
    expect(doc.risk?.checks.map((c) => c.name)).not.toContain("edge_after_costs")
    expect(alerts.success).toHaveBeenCalledWith("Bought BTC/USD", expect.stringContaining("Trend core"), expect.objectContaining({ fields: expect.objectContaining({ Target: "none: the stop trails" }) }))
    // Once the hour is done, nothing more until the next.
    await core.tick(at(30))
    expect(await ctx.col.decisions.countDocuments()).toBe(1)
  })

  it("opens nothing while BTC is below its 50-day, while entries are paused, while the agent decides, or when strategies.core is off", async () => {
    const below = await setup()
    below.setFeatures(features({ price: 59_000 }))
    await below.core.tick(at(5))
    expect(await below.ctx.col.decisions.countDocuments()).toBe(0)
    await db.col.decisions.deleteMany({})
    for (const s of [{ paused: "entries paused by a breaker until the owner resumes them: drawdown" }, { busy: true }, { settings: { ...DEFAULT_SETTINGS, strategies: { ...DEFAULT_SETTINGS.strategies, core: { enabled: false, max_exposure_pct: 90 } } } }]) {
      const { ctx, core } = await setup(s)
      await core.tick(at(5))
      expect(await ctx.ledger.openPositions()).toEqual([])
    }
  })

  it("skips a pair it left within 48 h, and one with negative news at review severity", async () => {
    const left = await setup()
    await db.col.positions.insertOne({ _id: "old", symbol: "BTC/USD", strategy_id: "core", status: "closed", closed_at: at(-60 * 20) } as never)
    await left.core.tick(at(5))
    expect(await left.ctx.ledger.openPositions()).toEqual([])
    await db.col.positions.deleteMany({})
    const news = await setup()
    await db.col.wireItems.insertOne({ _id: "n1", symbols: ["BTC/USD"], polarity: -1, severity: 60, first_seen_at: at(-120) } as never)
    await news.core.tick(at(5))
    expect(await news.ctx.ledger.openPositions()).toEqual([])
    await db.col.wireItems.updateOne({ _id: "n1" }, { $set: { severity: 40 } })
    await news.core.tick(at(65))
    expect((await news.ctx.ledger.openPositions()).map((p) => p.strategy_id)).toEqual(["core"])
  })

  it("closes a core position whose trend broke, at the daily close only", async () => {
    const { ctx, core, alerts, setFeatures } = await setup()
    await core.tick(at(5))
    setFeatures(features({ price: 59_500, bid: 59_490, ask: 59_510 }))
    await core.tick(at(65)) // 14:05: not the daily close
    expect(await ctx.ledger.openPositions()).toHaveLength(1)
    await core.tick(at(11 * 60 + 5)) // 00:05 the next day
    expect(await ctx.ledger.openPositions()).toEqual([])
    expect(alerts.success).toHaveBeenCalledWith("Trend core sold BTC/USD", expect.stringContaining("Trend broke"), expect.anything())
  })

  it("lets the agent close a core position only when news about it woke the agent", async () => {
    const { ctx, core } = await setup()
    await core.tick(at(5))
    const d: CryptoAgentDeps = { ctx: { ...ctx, hub: { ...ctx.hub, universe: ["BTC/USD"] } as unknown as MarketHub }, history: null }
    const close: CryptoAgentAnswer = {
      decisions: [
        {
          symbol: "BTC/USD",
          action: "close",
          conviction: 70,
          uncertainty: "medium",
          p_target_first: null,
          stop_loss: null,
          take_profit: null,
          horizon_hours: 24,
          reduce_pct: null,
          priced_in: "unknown",
          thesis: "Exchange hack.",
          bull_evidence: [],
          bear_evidence: [],
          risks: [],
          invalidation: "n/a",
          strategy: null,
        },
      ],
      watches: [],
      cancel_watches: [],
      notes: [],
      reply: "ok",
    }
    const ep = (observations: Observation[]) => ({ id: "e1", urls: new Set<string>(), wake: { subject: "BTC/USD", priority: 0 as const, salience: 80, observations }, entriesPaused: null })
    const price: Observation = { id: "move:1", subject: "BTC/USD", kind: "price", priority: 0, salience: 70, summary: "down 3%", refs: {}, at: new Date() }
    const [blocked] = await actOnCryptoAnswer(d, close, ep([price]))
    expect(blocked).toMatchObject({ outcome: "blocked", detail: expect.stringMatching(/^a trend-core position closes by its rules/) })
    await ctx.col.positions.updateMany({}, { $set: { opened_at: new Date(Date.now() - 2 * 3_600_000) } })
    ctx.ledger.forgetOpenPositions()
    const news: Observation = { id: "news:1", subject: "BTC/USD", kind: "news", priority: 0, salience: 90, summary: "exchange hacked", refs: { item_ids: ["n1"] }, at: new Date() }
    const [sold] = await actOnCryptoAnswer(d, close, ep([news]))
    expect(sold).toMatchObject({ outcome: "filled" })
  })
})
