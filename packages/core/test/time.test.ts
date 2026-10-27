import { describe, expect, it } from "vitest"
import { addDays, inTimeZone, minutesBetween } from "../src/time"

// The New York cases are in stock-core's time tests (marketDay, marketClock, marketTime).

describe("inTimeZone", () => {
  it("reads days and wall-clock times in the given zone", () => {
    const utc = inTimeZone("UTC")
    const tokyo = inTimeZone("Asia/Tokyo")
    const t = new Date("2026-10-26T20:30:00Z")
    expect(utc.day(t)).toBe("2026-10-26")
    expect(utc.clock(t)).toBe("20:30")
    expect(tokyo.day(t)).toBe("2026-10-27")
    expect(tokyo.clock(t)).toBe("05:30")
    expect(tokyo.offsetMinutes(t)).toBe(540)
  })

  it("converts wall-clock times to instants across a DST switch", () => {
    const london = inTimeZone("Europe/London")
    // BST ends Sun Oct 25 2026 (02:00 BST → 01:00 GMT).
    expect(london.time("2026-10-24", "09:00").toISOString()).toBe("2026-10-24T08:00:00.000Z")
    expect(london.time("2026-10-26", "09:00").toISOString()).toBe("2026-10-26T09:00:00.000Z")
    const t = london.time("2026-07-01", "23:15")
    expect(london.day(t)).toBe("2026-07-01")
    expect(london.clock(t)).toBe("23:15")
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
