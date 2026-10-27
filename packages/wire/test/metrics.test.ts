import { describe, expect, it } from "vitest"
import { crossingMeta, MetricWatcher, type MetricRule } from "../src/metrics"

const MIN = 60_000

describe("metric watcher", () => {
  const level: MetricRule = { id: "lvl", kind: "level", abs: 100 }

  it("treats the first reading as a baseline and fires once per excursion", () => {
    const w = new MetricWatcher()
    // Already extreme at boot: nothing fires, and this excursion never does.
    expect(w.observe("k", 150, 0, [level])).toEqual([])
    expect(w.observe("k", 160, MIN, [level])).toEqual([])
    // Back below half the threshold, but too soon to re-arm.
    expect(w.observe("k", 20, 2 * MIN, [level])).toEqual([])
    expect(w.observe("k", 120, 3 * MIN, [level])).toEqual([])
    expect(w.observe("k", 20, 20 * MIN, [level])).toEqual([])
    const [c] = w.observe("k", -130, 21 * MIN, [level])
    expect(c).toMatchObject({ key: "k", rule: "lvl", kind: "level", value: -130, exit: false })
    expect(w.observe("k", -140, 22 * MIN, [level])).toEqual([])
    // A reading that isn't newer than the last is ignored.
    expect(w.observe("k", 500, 22 * MIN, [level])).toEqual([])
  })

  it("measures changes within the window from its low or high, one way if asked", () => {
    const w = new MetricWatcher()
    const drop: MetricRule = { id: "drop", kind: "change", windowMin: 60, pct: 15, direction: "down" }
    w.observe("tvl", 100, 0, [drop])
    expect(w.observe("tvl", 110, 10 * MIN, [drop])).toEqual([])
    expect(w.observe("tvl", 130, 20 * MIN, [drop])).toEqual([])
    const [c] = w.observe("tvl", 105, 30 * MIN, [drop])
    expect(c).toMatchObject({ ref: 130, delta: -25, windowMin: 60 })
    expect(c.pct).toBeCloseTo(-19.23, 2)
    // Outside the window the old high no longer counts.
    const w2 = new MetricWatcher()
    w2.observe("tvl", 130, 0, [drop])
    expect(w2.observe("tvl", 100, 61 * MIN, [drop])).toEqual([])
    const pts: MetricRule = { id: "swing", kind: "change", windowMin: 60, points: 15 }
    w2.observe("odds", 40, 0, [pts])
    expect(w2.observe("odds", 56, 30 * MIN, [pts])[0]).toMatchObject({ ref: 40, delta: 16 })
  })

  it("compares spikes with the trailing median, needs enough samples, and skips tiny values", () => {
    const w = new MetricWatcher()
    const spike: MetricRule = { id: "s", kind: "spike", windowMin: 24 * 60, ratio: 5, minSamples: 5, min: 20 }
    for (let i = 0; i < 4; i++) w.observe("fee", 4, i * MIN, [spike])
    expect(w.observe("fee", 40, 4 * MIN, [spike])).toEqual([])
    for (let i = 5; i < 10; i++) w.observe("fee", 4, i * MIN, [spike])
    expect(w.observe("fee", 15, 10 * MIN, [spike])).toEqual([]) // 3.75× and below the floor
    expect(w.observe("fee", 30, 11 * MIN, [spike])[0]).toMatchObject({ ref: 4, ratio: 7.5 })
  })

  it("holds a level for a while, reports exits, and backfills silently", () => {
    const w = new MetricWatcher()
    const held: MetricRule = { id: "p", kind: "level", abs: 0.3, forMin: 5 }
    w.observe("prem", 0.5, 0, [held])
    expect(w.observe("prem", 0.5, 4 * MIN, [held])).toEqual([])
    expect(w.observe("prem", -0.5, 5 * MIN, [held])).toEqual([]) // flipped side: not held
    expect(w.observe("prem", -0.6, 11 * MIN, [held])[0]).toMatchObject({ value: -0.6, windowMin: 5 })
    const extreme: MetricRule = { id: "x", kind: "level", abs: 1, rearmAt: 1, rearmMs: 0, exits: true }
    w.backfill("fng", [{ at: 0, value: 0 }, { at: 1, value: -1 }], [extreme])
    expect(w.observe("fng", -1, 2, [extreme])).toEqual([])
    expect(w.observe("fng", 0, 3, [extreme])).toEqual([expect.objectContaining({ exit: true })])
    expect(w.observe("fng", 1, 4, [extreme])).toEqual([expect.objectContaining({ exit: false, value: 1 })])
  })

  it("keeps memory bounded and marks items as readings", () => {
    const w = new MetricWatcher({ maxPoints: 10, maxKeys: 3 })
    for (let i = 0; i < 50; i++) w.observe("a", i, i, [])
    for (const k of ["b", "c", "d"]) w.observe(k, 1, 1, [])
    expect(w.size).toBe(3)
    expect(w.last("a")).toBeNull()
    const [c] = (() => {
      const x = new MetricWatcher()
      x.observe("m", 0, 0, [{ id: "l", kind: "level", abs: 1 }])
      return x.observe("m", 2, MIN, [{ id: "l", kind: "level", abs: 1 }])
    })()
    expect(crossingMeta(c)).toMatchObject({ metric: "m", rule: "l", value: 2 })
  })
})
