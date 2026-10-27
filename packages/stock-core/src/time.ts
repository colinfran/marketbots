import { inTimeZone } from "@mb/core/time"

export { addDays, minutesBetween } from "@mb/core/time"

/**
 * Market-time helpers. US equities run on New York time, so every "day" in this app is an
 * America/New_York calendar date in YYYY-MM-DD form. The zone arithmetic is the shared
 * `inTimeZone` (@mb/core/time); what is New York-specific stays here.
 */

export const MARKET_TZ = "America/New_York"

const market = inTimeZone(MARKET_TZ)

/** The New York trading date for an instant, e.g. "2026-10-26". */
export const marketDay = market.day

/** "HH:MM" New York wall-clock time for an instant. */
export const marketClock = market.clock

/** Converts a New York wall-clock time ("2026-10-26", "09:30") into an absolute Date. */
export const marketTime = market.time

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  hour: "numeric",
  minute: "2-digit",
})

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

const longDayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
})

/** "10:30 AM" in New York time. */
export const formatTime = (date: Date | string) => `${timeFormatter.format(new Date(date))} ET`

/** "Oct 26, 10:30 AM" in New York time. */
export const formatDateTime = (date: Date | string) => `${dateTimeFormatter.format(new Date(date))} ET`

/** "Mon, Oct 26, 2026" for a YYYY-MM-DD trading day. */
export const formatDay = (day: string) => longDayFormatter.format(new Date(`${day}T12:00:00Z`))
