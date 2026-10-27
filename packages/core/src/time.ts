/**
 * Time-zone and calendar-day helpers. A "day" is a calendar date in YYYY-MM-DD form; which time
 * zone it is reckoned in is the caller's choice (`inTimeZone`).
 */

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

const pad = (n: number) => String(n).padStart(2, "0")

/** Day, wall-clock and offset helpers bound to one IANA time zone, e.g. "America/New_York". */
export const inTimeZone = (timeZone: string) => {
  const partsFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })

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

  /** Offset of the zone from UTC at the given instant, in minutes (e.g. -240 in New York during EDT). */
  const offsetMinutes = (date: Date): number => {
    const p = zonedParts(date)
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    return Math.round((asUtc - date.getTime()) / 60_000)
  }

  return {
    /** The calendar date in the zone for an instant, e.g. "2026-10-26". */
    day: (date: Date = new Date()): string => {
      const p = zonedParts(date)
      return `${p.year}-${pad(p.month)}-${pad(p.day)}`
    },

    /** "HH:MM" wall-clock time in the zone for an instant. */
    clock: (date: Date = new Date()): string => {
      const p = zonedParts(date)
      return `${pad(p.hour)}:${pad(p.minute)}`
    },

    /** Converts a wall-clock time in the zone ("2026-10-26", "09:30") into an absolute Date. */
    time: (day: string, hhmm: string): Date => {
      const [y, m, d] = day.split("-").map(Number)
      const [h, min] = hhmm.split(":").map(Number)
      const guess = Date.UTC(y, m - 1, d, h, min)
      const first = guess - offsetMinutes(new Date(guess)) * 60_000
      // Re-check once in case the guess and the answer straddle a DST switch.
      return new Date(guess - offsetMinutes(new Date(first)) * 60_000)
    },

    offsetMinutes,
  }
}

/** Adds whole days to a YYYY-MM-DD string. */
export const addDays = (day: string, days: number): string => {
  const [y, m, d] = day.split("-").map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

export const minutesBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / 60_000
