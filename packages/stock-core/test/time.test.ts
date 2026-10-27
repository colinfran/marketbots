import { describe, expect, it } from "vitest"
import {
  addDays,
  formatDateTime,
  formatDay,
  formatTime,
  MARKET_TZ,
  marketClock,
  marketDay,
  marketTime,
  minutesBetween,
} from "../src/time"

// 2026 US DST: starts Sun Mar 8 (02:00 EST → 03:00 EDT), ends Sun Nov 1 (02:00 EDT → 01:00 EST).

describe("marketDay", () => {
  it("uses the New York calendar date, not UTC", () => {
    // 23:30 ET on Oct 26 is already Oct 27 in UTC.
    expect(marketDay(new Date("2026-10-27T03:30:00Z"))).toBe("2026-10-26")
    expect(marketDay(new Date("2026-10-27T04:00:00Z"))).toBe("2026-10-27")
  })

  it("follows the EST offset in winter", () => {
    expect(marketDay(new Date("2026-12-01T04:59:00Z"))).toBe("2026-11-30")
    expect(marketDay(new Date("2026-12-01T05:00:00Z"))).toBe("2026-12-01")
  })

  it("zero-pads months and days", () => {
    expect(marketDay(new Date("2026-03-05T15:00:00Z"))).toBe("2026-03-05")
  })

  it("defaults to now", () => {
    expect(marketDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe("marketClock", () => {
  it("returns 24-hour New York wall-clock time", () => {
    expect(marketClock(new Date("2026-10-26T13:30:00Z"))).toBe("09:30")
    expect(marketClock(new Date("2026-11-02T14:30:00Z"))).toBe("09:30")
    expect(marketClock(new Date("2026-10-26T20:05:00Z"))).toBe("16:05")
  })

  it("shows midnight as 00 rather than 24", () => {
    expect(marketClock(new Date("2026-10-27T04:00:00Z"))).toBe("00:00")
  })
})

describe("marketTime", () => {
  it("converts New York wall-clock time to an instant in EDT", () => {
    expect(marketTime("2026-10-26", "09:30").toISOString()).toBe("2026-10-26T13:30:00.000Z")
    expect(marketTime("2026-10-26", "16:00").toISOString()).toBe("2026-10-26T20:00:00.000Z")
  })

  it("converts New York wall-clock time to an instant in EST", () => {
    expect(marketTime("2026-11-02", "09:30").toISOString()).toBe("2026-11-02T14:30:00.000Z")
    expect(marketTime("2026-12-24", "13:00").toISOString()).toBe("2026-12-24T18:00:00.000Z")
  })

  it("handles midnight", () => {
    expect(marketTime("2026-10-26", "00:00").toISOString()).toBe("2026-10-26T04:00:00.000Z")
  })

  it("is correct on the days DST starts and ends", () => {
    expect(marketTime("2026-03-08", "12:00").toISOString()).toBe("2026-03-08T16:00:00.000Z")
    expect(marketTime("2026-11-01", "12:00").toISOString()).toBe("2026-11-01T17:00:00.000Z")
  })

  it("re-checks the offset when the first guess straddles the DST switch", () => {
    // 03:30 on Mar 8 is just after clocks spring forward; a single-pass conversion lands on 04:30 EDT.
    const t = marketTime("2026-03-08", "03:30")
    expect(t.toISOString()).toBe("2026-03-08T07:30:00.000Z")
    expect(marketClock(t)).toBe("03:30")
  })

  it("round-trips with marketDay and marketClock", () => {
    for (const [day, hhmm] of [
      ["2026-01-15", "09:30"],
      ["2026-07-03", "13:00"],
      ["2026-11-27", "13:00"],
      ["2027-02-01", "16:00"],
    ]) {
      const t = marketTime(day, hhmm)
      expect(marketDay(t)).toBe(day)
      expect(marketClock(t)).toBe(hhmm)
    }
  })
})

describe("addDays", () => {
  it("adds and subtracts whole days", () => {
    expect(addDays("2026-10-26", 1)).toBe("2026-10-27")
    expect(addDays("2026-10-26", -1)).toBe("2026-10-25")
    expect(addDays("2026-10-26", 0)).toBe("2026-10-26")
  })

  it("rolls over months, years and leap days", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01")
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31")
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29")
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01")
    expect(addDays("2026-10-26", -45)).toBe("2026-09-11")
  })

  it("is unaffected by DST", () => {
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02")
    expect(addDays("2026-03-08", -1)).toBe("2026-03-07")
  })
})

describe("minutesBetween", () => {
  it("returns signed fractional minutes", () => {
    const a = new Date("2026-10-26T13:30:00Z")
    expect(minutesBetween(a, new Date("2026-10-26T14:00:00Z"))).toBe(30)
    expect(minutesBetween(a, new Date("2026-10-26T13:00:00Z"))).toBe(-30)
    expect(minutesBetween(a, new Date("2026-10-26T13:30:30Z"))).toBe(0.5)
  })
})

describe("formatting", () => {
  it("formatTime shows New York time with an ET suffix", () => {
    expect(formatTime(new Date("2026-10-26T13:30:00Z"))).toMatch(/^9:30\sAM ET$/)
    expect(formatTime("2026-10-26T20:00:00Z")).toMatch(/^4:00\sPM ET$/)
  })

  it("formatDateTime includes the date", () => {
    expect(formatDateTime("2026-10-26T14:05:00Z")).toMatch(/^Oct 26, 10:05\sAM ET$/)
  })

  it("formatDay renders a YYYY-MM-DD day without shifting it", () => {
    expect(formatDay("2026-10-26")).toBe("Mon, Oct 26, 2026")
    expect(formatDay("2027-01-01")).toBe("Fri, Jan 1, 2027")
  })

  it("exposes the market time zone", () => {
    expect(MARKET_TZ).toBe("America/New_York")
  })
})
