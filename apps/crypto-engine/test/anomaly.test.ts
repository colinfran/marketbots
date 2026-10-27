import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import { KrakenWs, type MinuteBar } from "../src/venues/kraken/ws"
import { AnomalyDetector, type Bar } from "../src/wire/anomaly"
import { signalItem } from "../src/wire/sources/kraken-market"
import { BTC } from "./helpers/fakes"

const MIN = 60_000
const T0 = Date.UTC(2026, 9, 27, 0, 0)
const thresholds = () => ({ priceZ: 4, volumeMultiple: 5, marketZ: 4 })

/** A deterministic, gently noisy path: ±0.05% alternating moves, constant volume. */
const quiet = (n: number, start = 100, from = T0): Bar[] => {
  const bars: Bar[] = []
  let price = start
  for (let i = 0; i < n; i++) {
    price *= 1 + (i % 2 ? 0.0005 : -0.0005) * (1 + (i % 7) / 10)
    bars.push({ t: from + i * MIN, close: price, volume: 10 })
  }
  return bars
}

const feed = (d: AnomalyDetector, symbol: string, bars: Bar[]) => bars.flatMap((b) => d.addBar(symbol, b))

describe("AnomalyDetector", () => {
  it("stays silent during warm-up, then flags an idiosyncratic jump", () => {
    const d = new AnomalyDetector("BTC/USD", thresholds)
    const btc = quiet(200, 80_000)
    const eth = quiet(200, 4_000)
    // A 2% jump inside the warm-up never fires.
    eth[50] = { ...eth[50], close: eth[49].close * 1.02 }
    for (let i = 0; i < 200; i++) {
      d.addBar("BTC/USD", btc[i])
      expect(d.addBar("ETH/USD", eth[i])).toEqual([])
    }
    const t = T0 + 200 * MIN
    d.addBar("BTC/USD", { t, close: btc[199].close, volume: 10 })
    const signals = d.addBar("ETH/USD", { t, close: eth[199].close * 1.02, volume: 10 })
    expect(signals).toEqual([expect.objectContaining({ symbol: "ETH/USD", kind: "price", window_min: 1 })])
    expect(signals[0].z).toBeGreaterThan(4)
    expect(signals[0].ret_pct).toBeCloseTo(2, 1)
  })

  it("treats a move the whole market shares as a market shock, not news about each coin", () => {
    const d = new AnomalyDetector("BTC/USD", thresholds)
    d.backfill("BTC/USD", quiet(300, 80_000))
    d.backfill("ETH/USD", quiet(300, 4_000))
    const t = T0 + 300 * MIN
    const btc = d.addBar("BTC/USD", { t, close: d.lastBar("BTC/USD")!.close * 0.97, volume: 10 })
    const eth = d.addBar("ETH/USD", { t, close: d.lastBar("ETH/USD")!.close * 0.97, volume: 10 })
    expect(btc).toEqual([expect.objectContaining({ kind: "market", window_min: 5 })])
    expect(eth.filter((s) => s.kind === "price")).toEqual([])
  })

  it("re-arms only after the move fades below half the threshold and 15 minutes pass", () => {
    const d = new AnomalyDetector("BTC/USD", thresholds)
    d.backfill("SOL/USD", quiet(300, 150))
    let t = T0 + 300 * MIN
    let price = d.lastBar("SOL/USD")!.close
    const step = (mult: number) => {
      price *= mult
      const s = d.addBar("SOL/USD", { t, close: price, volume: 10 })
      t += MIN
      return s.filter((x) => x.kind === "price")
    }
    expect(step(1.02)).toHaveLength(1)
    expect(step(1.02)).toHaveLength(0) // still elevated: no repeat
    for (let i = 0; i < 16; i++) step(1)
    expect(step(1.02)).toHaveLength(1)
  })

  it("flags volume far above the median", () => {
    const d = new AnomalyDetector("BTC/USD", thresholds)
    d.backfill("XRP/USD", quiet(200, 0.5))
    const last = d.lastBar("XRP/USD")!
    const s = d.addBar("XRP/USD", { t: last.t + MIN, close: last.close, volume: 80 })
    expect(s).toEqual([expect.objectContaining({ kind: "volume", volume_multiple: 8 })])
    expect(signalItem(s[0], 4)).toMatchObject({ category: "volume_shock", symbols: ["XRP/USD"], kind: "anomaly", tier: 1 })
  })

  it("scores price on bars without a volume, and leaves them out of the volume median", () => {
    const d = new AnomalyDetector("BTC/USD", thresholds)
    const bars = quiet(200, 0.5).map((b, i) => (i % 3 ? b : { ...b, volume: Number.NaN }))
    d.backfill("XRP/USD", bars)
    const last = d.lastBar("XRP/USD")!
    expect(d.addBar("XRP/USD", { t: last.t + MIN, close: last.close, volume: 80 })).toEqual([expect.objectContaining({ kind: "volume", volume_multiple: 8 })])
    expect(d.addBar("XRP/USD", { t: last.t + 2 * MIN, close: last.close * 1.02, volume: Number.NaN })).toEqual([expect.objectContaining({ kind: "price" })])
  })

  it("scales a price shock's base with z and makes the market shock market-wide", () => {
    expect(signalItem({ symbol: "ETH/USD", kind: "price", at: T0, z: 8, window_min: 1, ret_pct: 2, volume_multiple: null }, 4).baseSeverity).toBe(88)
    expect(signalItem({ symbol: "BTC/USD", kind: "market", at: T0, z: -5, window_min: 5, ret_pct: -3, volume_multiple: null }, 4)).toMatchObject({ symbols: [], marketWide: true, polarity: -1, baseSeverity: 69 })
  })
})

describe("KrakenWs bars and data symbols", () => {
  it("emits a bar when the next minute starts, and keeps data tickers out of the trading state", () => {
    const bars: MinuteBar[] = []
    const data: string[] = []
    const ws = new KrakenWs(["BTC/USD"], new Map([["BTC/USD", BTC]]), silentLogger, { onBar: (b) => bars.push(b), onDataTicker: (t) => data.push(t.symbol) })
    ws.setDataSymbols(["USDT/USD"])
    const ohlc = (begin: string, close: number) => JSON.stringify({ channel: "ohlc", type: "update", data: [{ symbol: "BTC/USD", open: 1, high: 1, low: 1, close, volume: 2, interval_begin: begin, interval: 1 }] })
    ws.handleMessage(ohlc("2026-10-27T00:01:00.000000000Z", 100))
    ws.handleMessage(ohlc("2026-10-27T00:01:00.000000000Z", 101))
    expect(bars).toEqual([])
    ws.handleMessage(ohlc("2026-10-27T00:02:00.000000000Z", 102))
    expect(bars).toEqual([expect.objectContaining({ symbol: "BTC/USD", t: Date.parse("2026-10-27T00:01:00Z"), close: 101 })])
    ws.handleMessage(JSON.stringify({ channel: "ticker", type: "update", data: [{ symbol: "USDT/USD", bid: 0.998, ask: 0.999, last: 0.998 }] }))
    expect(data).toEqual(["USDT/USD"])
    expect(ws.tickers.has("USDT/USD")).toBe(false)
    vi.restoreAllMocks()
  })
})
