import { describe, expect, it } from "vitest"
import { AnomalyDetector, type Bar } from "../src/anomaly"

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

  it("scores price on bars without a volume, and leaves them out of the volume median", () => {
    const d = new AnomalyDetector("BTC/USD", thresholds)
    const bars = quiet(200, 0.5).map((b, i) => (i % 3 ? b : { ...b, volume: Number.NaN }))
    d.backfill("XRP/USD", bars)
    const last = d.lastBar("XRP/USD")!
    expect(d.addBar("XRP/USD", { t: last.t + MIN, close: last.close, volume: 80 })).toEqual([expect.objectContaining({ kind: "volume", volume_multiple: 8 })])
    expect(d.addBar("XRP/USD", { t: last.t + 2 * MIN, close: last.close * 1.02, volume: Number.NaN })).toEqual([expect.objectContaining({ kind: "price" })])
  })
})
