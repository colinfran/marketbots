import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { countLocalDay, localDayStart } from "../src/lib/local-day"

const ms = (iso: string) => new Date(iso).getTime()

describe("the viewer's local day", () => {
  const tz = process.env.TZ
  beforeAll(() => {
    process.env.TZ = "America/Los_Angeles"
  })
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  })

  it("starts at local midnight, not UTC's", () => {
    // 4:03 pm on Nov 17 in Los Angeles is already Nov 18 in UTC.
    expect(localDayStart(ms("2026-11-18T00:03:00Z"))).toBe(ms("2026-11-17T08:00:00Z"))
  })

  it("counts the calls of the viewer's day across the UTC midnight", () => {
    const times = ["2026-11-17T07:59:00Z", "2026-11-17T08:00:00Z", "2026-11-17T23:10:25Z", "2026-11-18T00:01:00Z"].map(ms)
    expect(countLocalDay(times, ms("2026-11-18T00:03:00Z"))).toBe(3)
  })

  it("keeps a 25-hour day whole when the clocks go back", () => {
    // Nov 1, 2026 in Los Angeles runs from 07:00Z (PDT) to 08:00Z the next day (PST).
    const times = ["2026-11-01T06:59:00Z", "2026-11-01T07:30:00Z", "2026-11-02T07:00:00Z"].map(ms)
    expect(countLocalDay(times, ms("2026-11-02T07:59:00Z"))).toBe(2)
    expect(countLocalDay(times, ms("2026-11-02T08:00:00Z"))).toBe(0)
  })

  it("counts nothing on an empty list", () => {
    expect(countLocalDay([], ms("2026-11-18T00:03:00Z"))).toBe(0)
  })
})
