import { describe, expect, it } from "vitest"
import { ago, bytes, duration, until, zonedFormat } from "../src/lib/format"

describe("bytes", () => {
  it("shows MB below a gigabyte, then GB and TB", () => {
    expect(bytes(191.9 * 1024 ** 2)).toBe("192 MB")
    expect(bytes(31.8 * 1024 ** 3)).toBe("31.8 GB")
    expect(bytes(32 * 1024 ** 3)).toBe("32 GB")
    expect(bytes(2.5 * 1024 ** 4)).toBe("2.5 TB")
  })

  it("renders a missing size as a dash", () => {
    expect(bytes(null)).toBe("—")
    expect(bytes(undefined)).toBe("—")
  })
})

describe("zonedFormat", () => {
  const at = "2026-10-26T14:30:15Z"

  it("shows times in the zone each dashboard passes in", () => {
    expect(zonedFormat("America/New_York").time(at)).toBe("10:30:15 AM")
    expect(zonedFormat("America/Los_Angeles").time(at)).toBe("7:30:15 AM")
    expect(zonedFormat("America/New_York").dateTime(at)).toBe("Oct 26, 10:30 AM")
  })

  it("renders a missing time as a dash", () => {
    expect(zonedFormat("UTC").time(null)).toBe("—")
    expect(zonedFormat("UTC").dateTime(undefined)).toBe("—")
  })
})

describe("relative times", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")

  it("says how long ago and how long until", () => {
    expect(ago(now - 45_000, now)).toBe("45s ago")
    expect(ago(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(ago(null, now)).toBe("never")
    expect(until(now + 90_000, now)).toBe("in 1m")
    expect(until(now - 1, now)).toBe("now")
  })

  it("formats durations", () => {
    expect(duration(850)).toBe("850ms")
    expect(duration(12_340)).toBe("12.3s")
    expect(duration(125_000)).toBe("2m 5s")
    expect(duration(null)).toBe("—")
  })
})
