/**
 * Pure helpers behind the shared charts (@mb/ui/charts): chart times, colors, tick labels and
 * price ranges. No DOM and no chart library here, so they run (and are tested) anywhere.
 *
 * Chart times are whole seconds, as lightweight-charts wants them. The library reads them as UTC
 * and has no time-zone option, so a chart that should read in a zone gets "wall-clock" seconds:
 * the instant shifted so that its UTC fields are the zone's local date and time.
 */

/** Milliseconds → chart seconds. */
export const toSeconds = (ms: number) => Math.floor(ms / 1000)

/** "#2a78d6" + 0.18 → "rgba(42,120,214,0.18)" (canvas colors from the hex tokens). */
export const alpha = (hex: string, a: number) => {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6)
  const n = Number.parseInt(full, 16)
  return Number.isFinite(n) ? `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` : hex
}

/** Strictly increasing times (a library requirement): keeps the last row per time, sorted. */
export const dedupe = <T extends { time: number }>(rows: T[]): T[] => {
  const map = new Map<number, T>()
  for (const r of rows) map.set(r.time, r)
  return [...map.values()].sort((a, b) => a.time - b.time)
}

/**
 * For each time, the index of the bar whose window holds it: the last bar starting at or before
 * it (-1 if it is before the first bar). `barStarts` is sorted ascending.
 */
export const barIndexes = (barStarts: number[], times: number[]): number[] =>
  times.map((t) => {
    let lo = 0
    let hi = barStarts.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (barStarts[mid] <= t) {
        found = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    return found
  })

/**
 * Strictly increasing times that keep every point, for one point per event where several can
 * share a second: a time at or before the previous one moves to one second after it.
 */
export const spread = (times: number[]): number[] => {
  const out: number[] = []
  for (const t of times) out.push(out.length && t <= out[out.length - 1] ? out[out.length - 1] + 1 : t)
  return out
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Converts instants (ms) to chart seconds. With a time zone, the seconds read as that zone's
 * wall clock (so the axis shows New York times for stock); without one, they are plain UTC
 * seconds (the library's own default).
 */
export const chartClock = (timeZone?: string) => {
  if (!timeZone) return toSeconds
  let f = wallClockFormatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    wallClockFormatters.set(timeZone, f)
  }
  const formatter = f
  return (ms: number) => {
    const p: Record<string, number> = {}
    for (const part of formatter.formatToParts(ms)) if (part.type !== "literal") p[part.type] = Number(part.value)
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000
  }
}

/** The library's tick kinds (its TickMarkType enum, in order). */
export type TickKind = "year" | "month" | "day" | "time" | "seconds"
export const TICK_KINDS: readonly TickKind[] = ["year", "month", "day", "time", "seconds"]

const utc = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options })
const TICK: Record<TickKind, Intl.DateTimeFormat> = {
  year: utc({ year: "numeric" }),
  month: utc({ month: "short" }),
  day: utc({ month: "short", day: "numeric" }),
  time: utc({ hour: "numeric", minute: "2-digit" }),
  seconds: utc({ hour: "numeric", minute: "2-digit", second: "2-digit" }),
}
const CROSSHAIR_DAY = utc({ month: "short", day: "numeric", year: "numeric" })
const CROSSHAIR_TIME = utc({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

/** Axis label for wall-clock seconds: "2026", "Nov", "Oct 26", "10:30 AM". */
export const tickLabel = (seconds: number, kind: TickKind) => TICK[kind].format(seconds * 1000)

/** The crosshair's time label for wall-clock seconds: "Oct 26, 10:30 AM", or "Oct 26, 2026" on a daily chart. */
export const crosshairLabel = (seconds: number, withTime: boolean) => (withTime ? CROSSHAIR_TIME : CROSSHAIR_DAY).format(seconds * 1000)

export type PriceRange = { minValue: number; maxValue: number }

/** A price range widened to take in extra values (levels, fill prices, a zero line). */
export const widen = (range: PriceRange | null, extra: number[]): PriceRange | null => {
  const values = extra.filter((v) => Number.isFinite(v))
  if (!values.length) return range
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return range ? { minValue: Math.min(range.minValue, lo), maxValue: Math.max(range.maxValue, hi) } : { minValue: lo, maxValue: hi }
}

/**
 * A price range at least `fraction` of its midpoint tall, grown evenly around the middle, so a
 * nearly flat series (equity moving by cents) doesn't fill the chart with noise.
 */
export const atLeast = (range: PriceRange | null, fraction: number): PriceRange | null => {
  if (!range || !(fraction > 0)) return range
  const mid = (range.minValue + range.maxValue) / 2
  const span = Math.abs(mid) * fraction
  if (range.maxValue - range.minValue >= span) return range
  return { minValue: mid - span / 2, maxValue: mid + span / 2 }
}

/** One sentence for screen readers: "Oct 1 to Oct 27: from $10,000 to $10,250, low $9,900, high $10,300." */
export const describe = (points: { t: number; value: number }[], time: (t: number) => string, value: (v: number) => string) => {
  if (!points.length) return "No data."
  const first = points[0]
  const last = points[points.length - 1]
  if (points.length === 1) return `${time(first.t)}: ${value(first.value)}.`
  let lo = first.value
  let hi = first.value
  for (const p of points) {
    if (p.value < lo) lo = p.value
    if (p.value > hi) hi = p.value
  }
  return `${time(first.t)} to ${time(last.t)}: from ${value(first.value)} to ${value(last.value)}, low ${value(lo)}, high ${value(hi)}.`
}

/** "1 day", "3 days". */
export const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The next point for a key press while a chart has focus, or null for other keys. */
export const stepIndex = (key: string, current: number | null, length: number): number | null => {
  if (!length) return null
  const last = length - 1
  switch (key) {
    case "ArrowRight":
      return current === null ? last : Math.min(last, current + 1)
    case "ArrowLeft":
      return current === null ? last : Math.max(0, current - 1)
    case "Home":
      return 0
    case "End":
      return last
    default:
      return null
  }
}
