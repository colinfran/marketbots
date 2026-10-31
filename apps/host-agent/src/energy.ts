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

/** What `EnergyMinutes` reads of a minute sample. */
type MinuteEnergy = { res: string; t: Date; wh: number | null; covered_ms: number; outlet_id: string | null }

/**
 * One outlet's minute energy over the last 30 days, kept in memory so the recorded totals don't
 * re-read 30 days of samples from the database every minute. The store fills it once (again after a
 * day, or for another outlet) and puts every minute sample it writes.
 */
export class EnergyMinutes {
  private readonly minutes = new Map<number, { wh: number; ms: number }>()

  constructor(
    readonly outlet: string,
    readonly loadedAt: number,
  ) {}

  /** A minute sample just written. `onlyNew` (the history import) leaves a minute already kept. */
  put(s: MinuteEnergy, onlyNew = false) {
    const t = s.t.getTime()
    if (s.res !== "1m" || (onlyNew && this.minutes.has(t))) return
    if (s.outlet_id === this.outlet) this.minutes.set(t, { wh: s.wh ?? 0, ms: s.covered_ms })
    else if (!onlyNew) this.minutes.delete(t)
  }

  /** Minutes read from the database. One put while the read ran is newer, and stays. */
  load(docs: MinuteEnergy[]) {
    for (const d of docs) if (!this.minutes.has(d.t.getTime())) this.put(d)
  }

  /** Watt-hours and covered time of the minutes starting at or after `now - ms`, per window; minutes past 30 days are dropped. */
  totals<K extends string>(now: number, windows: Record<K, number>): Record<K, { wh: number; ms: number }> {
    const names = Object.keys(windows) as K[]
    const sums = Object.fromEntries(names.map((name) => [name, { wh: 0, ms: 0 }])) as Record<K, { wh: number; ms: number }>
    for (const [t, m] of this.minutes) {
      if (t < now - 30 * 86_400_000) {
        this.minutes.delete(t)
        continue
      }
      for (const name of names) {
        if (t < now - windows[name]) continue
        sums[name].wh += m.wh
        sums[name].ms += m.ms
      }
    }
    return sums
  }
}

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
