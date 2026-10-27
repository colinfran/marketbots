/**
 * Market-time helpers. US equities run on New York time, so every "day" in this app is an
 * America/New_York calendar date in YYYY-MM-DD form.
 */

export const MARKET_TZ = "America/New_York"

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARKET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const zonedParts = (date: Date): ZonedParts => {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((p) => [p.type, p.value]),
  ) as Record<string, string>
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

/** The New York trading date for an instant, e.g. "2026-10-26". */
export const marketDay = (date: Date = new Date()): string => {
  const p = zonedParts(date)
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/** "HH:MM" New York wall-clock time for an instant. */
export const marketClock = (date: Date = new Date()): string => {
  const p = zonedParts(date)
  return `${pad(p.hour)}:${pad(p.minute)}`
}

/** Offset of New York from UTC at the given instant, in minutes (e.g. -240 during EDT). */
const offsetMinutes = (date: Date): number => {
  const p = zonedParts(date)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - date.getTime()) / 60_000)
}

/** Converts a New York wall-clock time ("2026-10-26", "09:30") into an absolute Date. */
export const marketTime = (day: string, hhmm: string): Date => {
  const [y, m, d] = day.split("-").map(Number)
  const [h, min] = hhmm.split(":").map(Number)
  const guess = Date.UTC(y, m - 1, d, h, min)
  const first = guess - offsetMinutes(new Date(guess)) * 60_000
  // Re-check once in case the guess and the answer straddle a DST switch.
  return new Date(guess - offsetMinutes(new Date(first)) * 60_000)
}

/** Adds whole days to a YYYY-MM-DD string. */
export const addDays = (day: string, days: number): string => {
  const [y, m, d] = day.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

export const minutesBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 60_000

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
