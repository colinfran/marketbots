import { silentLogger } from "@mb/engine-kit/log"
import type { AlpacaAsset, Bar } from "@mb/stock-core/alpaca"
import { CORE_RANKING_KEY, type CoreRanking } from "@mb/stock-core/core-book"
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "@mb/stock-core/settings"
import { marketTime } from "@mb/stock-core/time"
import { beforeEach, describe, expect, it } from "vitest"
import { CoreRankingStore } from "../../src/core-book/data"
import { SCAN_UNIVERSE_KEY } from "../../src/market/scan-universe"
import { fakeBroker, type FakeBroker } from "../helpers/broker"
import { useTestDb } from "../helpers/db"
import { bar, DAY, session } from "../helpers/factories"

const testDb = useTestDb()

/** Daily bars, one per calendar day at midnight ET, the last on DAY itself (a session still in progress). */
const series = (closes: number[]): Bar[] => closes.map((c, i) => bar(new Date(Date.UTC(2026, 9, 26 - (closes.length - 1 - i), 4)).toISOString(), c))

const asset = (symbol: string, name: string): AlpacaAsset => ({ symbol, name, class: "us_equity", exchange: "NASDAQ", status: "active", tradable: true, fractionable: true })

const at = (iso: string) => new Date(iso)
/** The premarket window opens 90 minutes before the 09:30 ET open (13:30Z). */
const BEFORE_WINDOW = at("2026-10-26T11:59:00Z")
const IN_WINDOW = at("2026-10-26T12:30:00Z")

let broker: FakeBroker
let settings: Settings
let store: CoreRankingStore
const newStore = () => new CoreRankingStore({ col: testDb.col, alpaca: broker.client, settings: () => settings, log: silentLogger, held: () => ["SPY"] })

beforeEach(async () => {
  broker = fakeBroker()
  settings = structuredClone(mergeSettings(DEFAULT_SETTINGS, { universe: { benchmarks: ["SPY"] }, core: { universe_size: 20, themes: ["Chips: NVDA"] } })) as Settings
  broker.assetList = [asset("NVDA", "NVIDIA Corporation Common Stock"), asset("AAPL", "Apple Inc. Common Stock"), asset("SPY", "SPDR S&P 500 ETF Trust"), asset("TQQQ", "ProShares UltraPro QQQ")]
  broker.bars["1Day"] = {
    NVDA: series(Array.from({ length: 300 }, (_, i) => 100 + i + (i % 2) * 3)),
    AAPL: series(Array.from({ length: 300 }, (_, i) => 400 - i)),
    // Slow and choppy, so its risk-adjusted momentum trails NVDA's.
    SPY: series(Array.from({ length: 300 }, (_, i) => 500 + i / 10 + (i % 2) * 2)),
    TQQQ: series(Array.from({ length: 300 }, (_, i) => 50 + i)),
  }
  await testDb.col.cache.insertOne({ _id: SCAN_UNIVERSE_KEY, data: { day: "2026-10-23", symbols: ["TQQQ", "NVDA", "AAPL"] }, fetched_at: new Date(), expires_at: new Date(Date.now() + 86_400_000) })
  store = newStore()
})

const cached = async () => (await testDb.col.cache.findOne({ _id: CORE_RANKING_KEY }))?.data as CoreRanking | undefined

describe("CoreRankingStore", () => {
  it("does nothing before the premarket window or on a closed day", async () => {
    expect(await store.refresh(session(), BEFORE_WINDOW)).toBeNull()
    expect(await store.refresh({ ...session(), is_trading_day: false, open: null, close: null }, IN_WINDOW)).toBeNull()
    expect(broker.barRequests).toEqual([])
  })

  it("builds the day's ranking once, from a year of completed daily bars", async () => {
    const ranking = (await store.refresh(session(), IN_WINDOW))!
    // Completed sessions only: today's bar (stamped at midnight ET) falls just after the end.
    expect(broker.barRequests).toEqual([{ symbols: ["SPY", "NVDA", "AAPL"], timeframe: "1Day", start: marketTime("2025-10-11", "00:00"), end: new Date(marketTime(DAY, "00:00").getTime() - 1) }])
    expect(ranking).toMatchObject({ day: DAY, as_of: "2026-10-25", universe_day: "2026-10-23" })
    expect(ranking.rows[0].sessions).toBe(299)
    expect(ranking.rows.map((r) => [r.symbol, r.sources, r.themes, r.trend_ok, r.rank])).toEqual([
      ["NVDA", ["universe", "theme"], ["Chips"], true, 1],
      ["SPY", ["benchmark", "held"], [], true, 2],
      ["AAPL", ["universe"], [], false, null],
    ])
    expect(ranking.excluded).toEqual([{ symbol: "TQQQ", reason: "leveraged, inverse, volatility or option-income product" }])
    expect((await cached())?.rows.map((r) => r.symbol)).toEqual(["NVDA", "SPY", "AAPL"])

    expect(await store.refresh(session(), at("2026-10-26T15:00:00Z"))).toBeNull()
    expect(broker.barRequests).toHaveLength(1)
  })

  it("rebuilds the same day when the owner changes the themes", async () => {
    await store.refresh(session(), IN_WINDOW)
    settings.core.themes = ["Chips: NVDA", "Phones: AAPL"]
    const ranking = (await store.refresh(session(), at("2026-10-26T15:00:00Z")))!
    expect(ranking.rows.find((r) => r.symbol === "AAPL")).toMatchObject({ sources: ["universe", "theme"], themes: ["Phones"] })
    expect(broker.barRequests).toHaveLength(2)
  })

  it("keeps today's cached ranking after a restart", async () => {
    await store.refresh(session(), IN_WINDOW)
    expect(await newStore().refresh(session(), at("2026-10-26T13:00:00Z"))).toBeNull()
    expect(broker.barRequests).toHaveLength(1)
  })

  it("retries a failed build after 30 minutes, keeping the last ranking", async () => {
    broker.bars["1Day"] = {}
    expect(await store.refresh(session(), IN_WINDOW)).toBeNull()
    expect(store.lastError).toBe("core ranking: no daily bars for any candidate")
    expect(await store.refresh(session(), at("2026-10-26T12:50:00Z"))).toBeNull()
    expect(broker.barRequests).toHaveLength(1)
    expect(await store.refresh(session(), at("2026-10-26T13:01:00Z"))).toBeNull()
    expect(broker.barRequests).toHaveLength(2)
    expect(await cached()).toBeUndefined()
  })
})
