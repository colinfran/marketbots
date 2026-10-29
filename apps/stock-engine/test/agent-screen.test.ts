import { describe, expect, it } from "vitest"
import { StockScreen } from "../src/agent/screen"
import { DAY, OPEN } from "./helpers/factories"

const MIN = 60_000
const at = (minute: number) => OPEN.getTime() + minute * MIN
const bar = (minute: number, close: number, volume = 1_000, symbol = "AAPL") => ({ symbol, t: at(minute), close, volume })
const opts = { open: OPEN, day: DAY, minPrice: 5 }

/** A quiet first 15 minutes between 100 and 101 on even volume. */
const openingRange = (screen: StockScreen, symbol = "AAPL") => {
  for (let m = 0; m < 15; m++) expect(screen.onBars([bar(m, m % 2 ? 101 : 100, 1_000, symbol)], opts)).toEqual([])
}

describe("stock setup screen", () => {
  it("finds the first close above the opening range on heavy volume, once", () => {
    const screen = new StockScreen()
    openingRange(screen)
    const [s] = screen.onBars([bar(15, 101.5, 3_000)], opts)
    expect(s).toMatchObject({ symbol: "AAPL", kind: "opening_range_breakout", level: 101, range: { low: 100, high: 101 }, volume_multiple: 3, close: 101.5 })
    expect(s.summary).toBe("AAPL opening-range breakout (first 15 min): closed 101.5 above 101 on 3× its median minute volume today; opening range 100-101.")
    expect(s.score).toBe(71)
    expect(screen.onBars([bar(16, 102, 3_000)], opts)).toEqual([])
  })

  it("needs the volume, a clean break and the minimum price", () => {
    const screen = new StockScreen()
    openingRange(screen)
    openingRange(screen, "PENNY")
    // A tick above the range, light volume, no volume at all: nothing yet.
    expect(screen.onBars([bar(15, 101.05, 3_000)], opts)).toEqual([])
    expect(screen.onBars([bar(16, 101.5, 1_500)], opts)).toEqual([])
    expect(screen.onBars([bar(17, 101.6, Number.NaN)], opts)).toEqual([])
    expect(screen.onBars([bar(18, 101.7, 2_500)], opts).map((s) => s.kind)).toEqual(["opening_range_breakout"])
    expect(screen.onBars([bar(15, 101.5, 3_000, "PENNY")], { ...opts, minPrice: 150 })).toEqual([])
  })

  it("finds a new session high an hour in, at most once an hour, and ignores bars before the open", () => {
    const screen = new StockScreen()
    expect(screen.onBars([{ symbol: "AAPL", t: at(-5), close: 150, volume: 9_000 }], opts)).toEqual([])
    openingRange(screen)
    expect(screen.onBars([bar(15, 101.5, 3_000)], opts)).toHaveLength(1)
    for (let m = 16; m < 60; m++) screen.onBars([bar(m, 101.2)], opts)
    const [high] = screen.onBars([bar(60, 102, 3_000)], opts)
    expect(high).toMatchObject({ kind: "new_high", level: 101.5 })
    expect(screen.onBars([bar(61, 102.5, 3_000)], opts)).toEqual([])
    expect(screen.onBars([bar(121, 103, 3_000)], opts).map((s) => s.kind)).toEqual(["new_high"])
  })

  it("ranks a minute's setups and starts every day afresh", () => {
    const screen = new StockScreen()
    for (const s of ["AAPL", "MSFT"]) openingRange(screen, s)
    const out = screen.onBars([bar(15, 101.5, 2_000, "AAPL"), bar(15, 101.5, 5_000, "MSFT")], opts)
    expect(out.map((s) => s.symbol)).toEqual(["MSFT", "AAPL"])
    expect(screen.onBars([bar(15, 101.5, 3_000)], { ...opts, day: "2026-10-27" })).toEqual([])
  })
})
