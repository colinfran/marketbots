import { readFileSync } from "node:fs"
import type { AlpacaAsset, Bar } from "@mb/stock-core/alpaca"
import { DEFAULT_SETTINGS, type Settings } from "@mb/stock-core/settings"
import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import { type BoardBar, PriceBoard } from "../../src/market/price-board"
import { buildScanUniverse, rankUniverse, ScanUniverseStore } from "../../src/market/scan-universe"
import { decodePricing, toYahoo } from "../../src/market/yahoo-stream"
import { StockMarketSignals } from "../../src/wire/sources/stock-market"
import { useTestDb } from "../helpers/db"

const db = useTestDb()
const MIN = 60_000
const T0 = Date.UTC(2026, 9, 27, 15, 0)
const fixture = (name: string) => readFileSync(new URL(`../fixtures/wire/${name}`, import.meta.url), "utf8")
const day = (i: number, c: number, v: number): Bar => ({ t: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), o: c, h: c, l: c, c, v, vw: c, n: 1 })

describe("Yahoo streamer", () => {
  it("decodes PricingData messages saved from the live feed", () => {
    const rows = (JSON.parse(fixture("yahoo-pricing.json")) as string[]).map(decodePricing)
    expect(rows.every((r) => r !== null)).toBe(true)
    expect(rows[0]).toMatchObject({ id: expect.stringMatching(/^(BTC|ETH)-USD$/), price: expect.any(Number) })
    expect(rows[0]!.price).toBeGreaterThan(100)
    expect(new Date(rows[0]!.at).toISOString()).toMatch(/^2026-10-27T/)
    expect(decodePricing("not protobuf")).toBeNull()
    expect(toYahoo("BRK.B")).toBe("BRK-B")
  })
})

describe("scan universe", () => {
  it("keeps priced, liquid symbols ranked by dollar volume", () => {
    const bars = {
      BIG: Array.from({ length: 20 }, (_, i) => day(i, 100, 1_000_000)), // $100M a day
      MID: Array.from({ length: 20 }, (_, i) => day(i, 50, 600_000)), // $30M
      THIN: Array.from({ length: 20 }, (_, i) => day(i, 20, 100_000)), // $2M
      CHEAP: Array.from({ length: 20 }, (_, i) => day(i, 2, 50_000_000)), // under min price
      NEW: [day(0, 100, 1_000_000)], // too little history
    }
    expect(rankUniverse(bars, { minPrice: 5, minDollarVolume: 20_000_000, max: 10 }).map((r) => r.symbol)).toEqual(["BIG", "MID"])
    expect(rankUniverse(bars, { minPrice: 5, minDollarVolume: 20_000_000, max: 1 }).map((r) => r.symbol)).toEqual(["BIG"])
  })

  it("builds from tradable main-exchange assets with consolidated daily bars, and caches the day", async () => {
    const asset = (symbol: string, extra: Partial<AlpacaAsset> = {}): AlpacaAsset => ({ symbol, name: symbol, class: "us_equity", exchange: "NASDAQ", status: "active", tradable: true, fractionable: true, ...extra })
    const alpaca = {
      listAssets: vi.fn(async () => [asset("AAA"), asset("BRK.B", { exchange: "NYSE" }), asset("OTCX", { exchange: "OTC" }), asset("HALT", { tradable: false }), asset("ABCDW.WS")]),
      getBars: vi.fn(async (symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, Array.from({ length: 20 }, (_, i) => day(i, 100, 1_000_000))]))),
    }
    const settings = DEFAULT_SETTINGS as Settings
    const built = await buildScanUniverse(alpaca, settings, { now: new Date(T0), pauseMs: 0 })
    expect(built.symbols).toEqual(["AAA", "BRK.B"])
    expect(alpaca.getBars).toHaveBeenCalledWith(["AAA", "BRK.B"], "1Day", expect.any(Date), new Date(T0 - 20 * MIN), { feed: "sip" })

    const store = new ScanUniverseStore(db.col, alpaca, () => settings, silentLogger, () => new Date(T0))
    expect(await store.refresh()).toBe(true)
    expect(store.symbols).toEqual(["AAA", "BRK.B"])
    // A restart the same day reads the cache instead of rebuilding.
    const again = new ScanUniverseStore(db.col, { listAssets: vi.fn(async () => { throw new Error("should not be called") }), getBars: vi.fn() }, () => settings, silentLogger, () => new Date(T0 + 60 * MIN))
    expect(await again.refresh()).toBe(true)
    expect(again.symbols).toEqual(["AAA", "BRK.B"])
    // The next day's build fails: yesterday's list keeps serving, and it doesn't retry at once.
    const failing = { listAssets: vi.fn(async (): Promise<AlpacaAsset[]> => { throw new Error("503") }), getBars: vi.fn() }
    const nextDay = new ScanUniverseStore(db.col, failing, () => settings, silentLogger, () => new Date(T0 + 24 * 60 * MIN))
    await nextDay.refresh()
    expect(nextDay.symbols).toEqual(["AAA", "BRK.B"])
    expect(nextDay.lastError).toMatch(/503/)
    await nextDay.refresh()
    expect(failing.listAssets).toHaveBeenCalledTimes(1)
  })
})

describe("PriceBoard", () => {
  const board = (now: { t: number }) => {
    const out: { t: number; bars: BoardBar[] }[] = []
    const b = new PriceBoard((t, bars) => out.push({ t, bars }), "SPY", () => now.t)
    b.setTracked(["SPY", "AAA", "BBB"])
    return { b, out }
  }

  it("takes the close from the best layer and the volume from IEX only, SPY first", () => {
    const now = { t: T0 }
    const { b, out } = board(now)
    b.tick("C", "AAA", 10.0, T0 + 10_000)
    b.tick("C", "AAA", 10.2, T0 + 50_000)
    b.bar("B", "AAA", T0, 10.1, 500)
    b.tick("C", "BBB", 20, T0 + 30_000) // Yahoo only: no volume
    b.tick("A", "SPY", 580, T0 + 40_000)
    b.bar("B", "SPY", T0, 579.9, 9_000)
    b.tick("C", "ZZZ", 5, T0 + 1_000) // not tracked
    now.t = T0 + MIN + 5_000
    b.flush()
    expect(out).toEqual([]) // not settled yet
    now.t = T0 + MIN + 13_000
    b.flush()
    expect(out).toHaveLength(1)
    expect(out[0].bars.map((x) => [x.symbol, x.layer, x.close, x.volume])).toEqual([
      ["SPY", "A", 580, 9_000],
      ["AAA", "C", 10.2, 500],
      ["BBB", "C", 20, Number.NaN],
    ])
    // Late data never reopens a closed minute, but still counts as the latest price.
    b.tick("C", "AAA", 10.3, T0 + 55_000)
    expect(b.price("AAA", MIN)).toMatchObject({ price: 10.3, layer: "C" })
    now.t += MIN
    b.flush()
    expect(out).toHaveLength(1)
  })

  it("counts a layer as disagreeing only after two minutes more than 1% off", () => {
    const now = { t: T0 }
    const { b } = board(now)
    for (let m = 0; m < 3; m++) {
      b.tick("C", "AAA", 10, T0 + m * MIN + 30_000)
      b.bar("B", "AAA", T0 + m * MIN, m === 0 ? 10.05 : 10.5, 100)
      now.t = T0 + (m + 1) * MIN + 13_000
      b.flush()
      expect(b.stats("B").disagreeing).toBe(m < 2 ? 0 : 1)
    }
    expect(b.stats("C").disagreeing).toBe(0)
  })

  it("ignores a layer that is switched off", () => {
    const now = { t: T0 }
    const { b, out } = board(now)
    b.setEnabled("C", false)
    b.tick("C", "AAA", 10, T0 + 1_000)
    now.t = T0 + 2 * MIN
    b.flush()
    expect(out).toEqual([])
  })
})

describe("StockMarketSignals", () => {
  it("skips a symbol's live bars until its warm-up lands, then scores them", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const quiet = (symbol: string, start: number) =>
      Array.from({ length: 200 }, (_, i): Bar => ({ t: new Date(T0 - (200 - i) * MIN).toISOString(), o: start, h: start, l: start, c: start * (1 + (i % 2 ? 0.0005 : -0.0005)), v: 100, vw: start, n: 1 }))
    const getBars = vi.fn(async (symbols: string[]) => {
      await gate
      return Object.fromEntries(symbols.map((s) => [s, quiet(s, s === "SPY" ? 580 : 50)]))
    })
    const anomalies: string[] = []
    const signals = new StockMarketSignals({ getBars }, () => DEFAULT_SETTINGS as Settings, silentLogger, () => new Date(T0 - 120 * MIN), (s) => anomalies.push(s), { fast: 0, slow: 0 })
    const emitted: string[] = []
    signals.setTracked(["AAA"])
    signals.start(async (items) => void emitted.push(...items.map((i) => i.title)))
    const jump = (t: number): BoardBar[] => [
      { symbol: "SPY", t, close: 580, volume: 100, layer: "B" },
      { symbol: "AAA", t, close: 53, volume: 100, layer: "C" },
    ]
    signals.onBars(T0, jump(T0)) // still warming: skipped
    expect(emitted).toEqual([])
    release()
    await vi.waitFor(() => expect(signals.health().detail).toMatch(/2 warmed$/))
    signals.onBars(T0 + MIN, jump(T0 + MIN))
    expect(anomalies).toEqual(["AAA"])
    expect(emitted).toEqual([expect.stringMatching(/^AAA \+\d/)])
    signals.stop()
  })
})
