import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import { AnomalyDetector, type Bar } from "@mb/wire/anomaly"
import { KrakenWs, type MinuteBar } from "../src/venues/kraken/ws"
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
  it("flags volume far above the median", () => {
    const d = new AnomalyDetector("BTC/USD", thresholds)
    d.backfill("XRP/USD", quiet(200, 0.5))
    const last = d.lastBar("XRP/USD")!
    const s = d.addBar("XRP/USD", { t: last.t + MIN, close: last.close, volume: 80 })
    expect(s).toEqual([expect.objectContaining({ kind: "volume", volume_multiple: 8 })])
    expect(signalItem(s[0], 4)).toMatchObject({ category: "volume_shock", symbols: ["XRP/USD"], kind: "anomaly", tier: 1 })
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
