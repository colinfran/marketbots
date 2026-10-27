import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Alpaca } from "../../src/alpaca/client"
import { getSession as sessionFor } from "../../src/bot/session"
import { fakeBroker, type FakeBroker } from "../helpers/broker"

let broker: FakeBroker
let alpaca: Alpaca
const getSession = (now: Date) => sessionFor(alpaca, now)

beforeEach(() => {
  broker = fakeBroker()
  alpaca = broker.client
  broker.calendar = [
    { date: "2026-10-26", open: "09:30", close: "16:00" },
    { date: "2026-11-27", open: "09:30", close: "13:00" },
    { date: "2026-11-30", open: "09:30", close: "16:00" },
  ]
})

describe("getSession", () => {
  it("returns a regular session from the market calendar", async () => {
    expect(await getSession(new Date("2026-10-26T12:00:00Z"))).toEqual({
      day: "2026-10-26",
      is_trading_day: true,
      open: new Date("2026-10-26T13:30:00Z"),
      close: new Date("2026-10-26T20:00:00Z"),
      open_et: "09:30",
      close_et: "16:00",
      early_close: false,
    })
    expect(alpaca.getCalendar).toHaveBeenCalledWith("2026-10-26", "2026-10-26")
  })

  it("flags early closes and converts them in EST", async () => {
    const s = await getSession(new Date("2026-11-27T15:00:00Z"))
    expect(s).toMatchObject({ early_close: true, close_et: "13:00", open: new Date("2026-11-27T14:30:00Z"), close: new Date("2026-11-27T18:00:00Z") })
  })

  it("reports holidays and weekends as non-trading days", async () => {
    // Thanksgiving and a Saturday are absent from the calendar.
    for (const now of ["2026-11-26T15:00:00Z", "2026-10-24T15:00:00Z"]) {
      const s = await getSession(new Date(now))
      expect(s).toEqual({ day: now.slice(0, 10), is_trading_day: false, open: null, close: null, open_et: null, close_et: null, early_close: false })
    }
  })

  it("uses the New York date late in the evening", async () => {
    // 22:00 ET Monday is already Tuesday in UTC.
    const s = await getSession(new Date("2026-10-27T02:00:00Z"))
    expect(s.day).toBe("2026-10-26")
    expect(s.is_trading_day).toBe(true)
  })

  it("serves the calendar from the cache on later calls", async () => {
    await getSession(new Date("2026-10-26T12:00:00Z"))
    await getSession(new Date("2026-10-26T15:00:00Z"))
    expect(alpaca.getCalendar).toHaveBeenCalledTimes(1)
  })

  it("serves a stale calendar when Alpaca fails later", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-26T12:00:00Z") })
    await getSession(new Date("2026-10-26T12:00:00Z"))
    vi.setSystemTime(new Date("2026-10-27T03:00:00Z"))
    vi.mocked(alpaca.getCalendar).mockRejectedValueOnce(new Error("Alpaca 503"))
    expect((await getSession(new Date("2026-10-26T15:00:00Z"))).is_trading_day).toBe(true)
    vi.useRealTimers()
  })

  it("propagates calendar failures when nothing is cached", async () => {
    vi.mocked(alpaca.getCalendar).mockRejectedValueOnce(new Error("Alpaca 503"))
    await expect(getSession(new Date("2026-11-30T15:00:00Z"))).rejects.toThrow("Alpaca 503")
  })
})
