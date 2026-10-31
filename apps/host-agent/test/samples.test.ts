import { describe, expect, it } from "vitest"
import { intervalWh, splitByMinute } from "../src/energy"
import { MinuteSamples, rawSample, type SampleInput } from "../src/samples"

const M = 60_000
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0)

describe("intervalWh", () => {
  const a = { t: T0, watts: 100, outlet: "o" }

  it("is the trapezoid under the two readings", () => {
    // 100 → 200 W over five minutes: 150 W for 1/12 h.
    expect(intervalWh(a, { t: T0 + 5 * M, watts: 200, outlet: "o" })).toBeCloseTo(12.5)
  })

  it("clips to a window, interpolating the watts at its edges", () => {
    // 100 → 200 W over a minute; the second half averages 175 W.
    expect(intervalWh(a, { t: T0 + M, watts: 200, outlet: "o" }, T0 + M / 2, T0 + M)).toBeCloseTo((175 * 30) / 3600)
  })

  it("doesn't count gaps, missing watts, or a change of outlet", () => {
    expect(intervalWh(a, { t: T0 + 6 * M, watts: 100, outlet: "o" })).toBeNull()
    expect(intervalWh(a, { t: T0 + M, watts: null, outlet: "o" })).toBeNull()
    expect(intervalWh(a, { t: T0 + M, watts: 100, outlet: "other" })).toBeNull()
    expect(intervalWh({ ...a, outlet: null }, { t: T0 + M, watts: 100, outlet: null })).toBeNull()
  })

  it("splits an interval across the minutes it spans", () => {
    const parts = splitByMinute({ t: T0 + 50_000, watts: 120, outlet: "o" }, { t: T0 + 70_000, watts: 120, outlet: "o" })
    expect(parts.map((p) => [p.minute, p.covered_ms])).toEqual([
      [T0, 10_000],
      [T0 + M, 10_000],
    ])
    expect(parts[0].wh).toBeCloseTo((120 * 10) / 3600)
  })
})

const reading = (t: number, watts: number | null, cpu = 10, extra: Partial<SampleInput> = {}): SampleInput => ({
  t,
  cpu,
  cpu_temp: 40,
  memory: 50,
  watts,
  outlet_id: "o",
  gpus: [{ id: "GPU-a", model: "RTX 3070", util: cpu, temp: 45 }],
  ...extra,
})

describe("MinuteSamples", () => {
  it("hands back a minute's averages once the next minute starts", () => {
    const m = new MinuteSamples()
    expect(m.add(reading(T0, 100, 10))).toEqual([])
    expect(m.add(reading(T0 + 30_000, 100, 20))).toEqual([])
    const [done] = m.add(reading(T0 + M, 100, 90))
    expect(done).toMatchObject({ _id: `1m:${T0}`, res: "1m", cpu: 15, cpu_temp: 40, memory: 50, watts: 100, outlet_id: "o", gpus: [{ id: "GPU-a", model: "RTX 3070", util: 15, temp: 45 }] })
    expect(done.t).toEqual(new Date(T0))
    // A minute at a steady 100 W: 100/60 Wh, fully covered.
    expect(done.wh).toBeCloseTo(100 / 60)
    expect(done.covered_ms).toBe(M)
  })

  it("counts no energy across a restart, and none for a minute without counted intervals", () => {
    const m = new MinuteSamples()
    m.add(reading(T0, 100))
    m.add(reading(T0 + 10_000, 100), { gap: true })
    const [done] = m.flush()
    expect(done.covered_ms).toBe(0)
    expect(done.wh).toBeNull()
  })

  it("ignores missing values in the averages", () => {
    const m = new MinuteSamples()
    m.add(reading(T0, null, 10))
    m.add(reading(T0 + 2_000, null, 20, { cpu_temp: null }))
    const [done] = m.flush()
    expect(done).toMatchObject({ cpu: 15, cpu_temp: 40, watts: null, wh: null })
  })

  it("writes a raw sample per reading (the store keeps it a little over an hour)", () => {
    const raw = rawSample(reading(T0, 100))
    expect(raw).toEqual({ _id: `raw:${T0}`, res: "raw", t: new Date(T0), cpu: 10, cpu_temp: 40, memory: 50, watts: 100, gpus: [{ id: "GPU-a", model: "RTX 3070", util: 10, temp: 45 }], wh: null, covered_ms: 0, outlet_id: "o" })
  })
})
