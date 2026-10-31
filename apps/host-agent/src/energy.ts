/**
 * Measured electricity use from the outlet's power readings. Energy between two consecutive
 * readings is the trapezoid under their watts. An interval counts only when both readings have
 * watts from the same outlet, the second isn't the first after a restart, and they are at most
 * five minutes apart: offline time is never filled in.
 */

export type PowerReading = { t: number; watts: number | null; outlet: string | null }

export const MAX_INTERVAL_MS = 5 * 60_000

/** Watt-hours between `prev` and `cur`, clipped to [from, to]; null when the interval doesn't count or misses the window. */
export const intervalWh = (prev: PowerReading, cur: PowerReading, from = prev.t, to = cur.t): number | null => {
  const elapsed = cur.t - prev.t
  if (prev.watts === null || cur.watts === null || prev.outlet === null || prev.outlet !== cur.outlet || elapsed <= 0 || elapsed > MAX_INTERVAL_MS) return null
  const a = Math.max(prev.t, from)
  const b = Math.min(cur.t, to)
  if (b <= a) return null
  const at = (t: number) => prev.watts! + ((cur.watts! - prev.watts!) * (t - prev.t)) / elapsed
  return (((at(a) + at(b)) / 2) * (b - a)) / 3_600_000
}

export const MINUTE_MS = 60_000

/**
 * Splits a counted interval over the minutes it spans: each minute's watt-hours and how long the
 * interval covered it. Empty when the interval doesn't count.
 */
export const splitByMinute = (prev: PowerReading, cur: PowerReading): { minute: number; wh: number; covered_ms: number }[] => {
  if (intervalWh(prev, cur) === null) return []
  const parts: { minute: number; wh: number; covered_ms: number }[] = []
  for (let start = prev.t; start < cur.t; ) {
    const minute = Math.floor(start / MINUTE_MS) * MINUTE_MS
    const end = Math.min(cur.t, minute + MINUTE_MS)
    parts.push({ minute, wh: intervalWh(prev, cur, start, end) ?? 0, covered_ms: end - start })
    start = end
  }
  return parts
}
