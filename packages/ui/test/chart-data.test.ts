import { describe as group, expect, it } from "vitest"
import { alpha, atLeast, barIndexes, chartClock, count, crosshairLabel, dedupe, describe, spread, stepIndex, tickLabel, TICK_KINDS, toSeconds, widen } from "../src/lib/chart-data"

group("chart times", () => {
  it("uses plain UTC seconds without a time zone", () => {
    const at = Date.parse("2026-10-26T14:30:15.900Z")
    expect(chartClock()(at)).toBe(toSeconds(at))
    expect(toSeconds(at)).toBe(Date.parse("2026-10-26T14:30:15Z") / 1000)
  })

  it("shifts to the zone's wall clock, across daylight-saving changes", () => {
    const ny = chartClock("America/New_York")
    // EDT (UTC−4) before 2026-11-01, EST (UTC−5) after.
    expect(ny(Date.parse("2026-10-26T14:30:00Z"))).toBe(Date.parse("2026-10-26T10:30:00Z") / 1000)
    expect(ny(Date.parse("2026-11-02T14:30:00Z"))).toBe(Date.parse("2026-11-02T09:30:00Z") / 1000)
    // Midnight reads as hour 0, not 24.
    expect(ny(Date.parse("2026-10-27T04:00:00Z"))).toBe(Date.parse("2026-10-27T00:00:00Z") / 1000)
  })

  it("labels wall-clock seconds like the dashboards do", () => {
    const t = Date.parse("2026-10-26T10:30:00Z") / 1000
    expect(TICK_KINDS.map((kind) => tickLabel(t, kind))).toEqual(["2026", "Oct", "Oct 26", "10:30 AM", "10:30:00 AM"])
    expect(crosshairLabel(t, true)).toBe("Oct 26, 10:30 AM")
    expect(crosshairLabel(t, false)).toBe("Oct 26, 2026")
  })
})

group("chart data", () => {
  it("keeps the last row per time, in time order", () => {
    expect(dedupe([{ time: 3, v: "a" }, { time: 1, v: "b" }, { time: 3, v: "c" }])).toEqual([
      { time: 1, v: "b" },
      { time: 3, v: "c" },
    ])
  })

  it("spreads equal times a second apart so no point is lost", () => {
    expect(spread([10, 10, 10, 20, 15])).toEqual([10, 11, 12, 20, 21])
    expect(spread([])).toEqual([])
  })

  it("finds the bar each time falls in", () => {
    const starts = [100, 200, 300]
    expect(barIndexes(starts, [50, 100, 199, 200, 250, 300, 999])).toEqual([-1, 0, 0, 1, 1, 2, 2])
    expect(barIndexes([], [100])).toEqual([-1])
  })

  it("widens a price range to take in extra values", () => {
    expect(widen({ minValue: 10, maxValue: 20 }, [5, 15])).toEqual({ minValue: 5, maxValue: 20 })
    expect(widen({ minValue: 10, maxValue: 20 }, [])).toEqual({ minValue: 10, maxValue: 20 })
    expect(widen(null, [0])).toEqual({ minValue: 0, maxValue: 0 })
    expect(widen(null, [Number.NaN])).toBeNull()
  })

  it("keeps a nearly flat range at least a fraction of its value tall", () => {
    expect(atLeast({ minValue: 9_990, maxValue: 10_010 }, 0.004)).toEqual({ minValue: 9_980, maxValue: 10_020 })
    expect(atLeast({ minValue: 9_000, maxValue: 11_000 }, 0.004)).toEqual({ minValue: 9_000, maxValue: 11_000 })
    expect(atLeast({ minValue: 5, maxValue: 6 }, 0)).toEqual({ minValue: 5, maxValue: 6 })
    expect(atLeast(null, 0.004)).toBeNull()
  })

  it("turns hex tokens into canvas colors with alpha", () => {
    expect(alpha("#2a78d6", 0.18)).toBe("rgba(42,120,214,0.18)")
    expect(alpha("#fff", 0)).toBe("rgba(255,255,255,0)")
    expect(alpha("oklch(0.5 0 0)", 0.5)).toBe("oklch(0.5 0 0)")
  })
})

group("chart accessibility", () => {
  const time = (t: number) => `T${t}`
  const value = (v: number) => `$${v}`

  it("summarizes a series in one sentence", () => {
    expect(describe([], time, value)).toBe("No data.")
    expect(describe([{ t: 1, value: 5 }], time, value)).toBe("T1: $5.")
    expect(
      describe(
        [
          { t: 1, value: 10 },
          { t: 2, value: 7 },
          { t: 3, value: 12 },
        ],
        time,
        value,
      ),
    ).toBe("T1 to T3: from $10 to $12, low $7, high $12.")
    expect([count(1, "day"), count(0, "buy"), count(3, "closing trade")]).toEqual(["1 day", "0 buys", "3 closing trades"])
  })

  it("walks the points with the arrow, Home and End keys", () => {
    expect(stepIndex("ArrowRight", null, 5)).toBe(4)
    expect(stepIndex("ArrowLeft", 2, 5)).toBe(1)
    expect(stepIndex("ArrowLeft", 0, 5)).toBe(0)
    expect(stepIndex("ArrowRight", 4, 5)).toBe(4)
    expect(stepIndex("Home", 3, 5)).toBe(0)
    expect(stepIndex("End", 0, 5)).toBe(4)
    expect(stepIndex("Enter", 0, 5)).toBeNull()
    expect(stepIndex("ArrowRight", null, 0)).toBeNull()
  })
})
