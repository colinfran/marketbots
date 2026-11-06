/** Small numeric helpers shared by the engines and the dashboards. */

export const round = (value: number | null | undefined, digits = 2): number | null => {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Like `round` but for values that are known to be finite. */
export const roundTo = (value: number, digits = 2): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

export const mean = (values: number[]) => (values.length ? sum(values) / values.length : 0)

/** Sample standard deviation (n - 1). */
export const stdev = (values: number[]) => {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1))
}

export const median = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Floors `value` to a multiple of `step` (e.g. a lot size), without float drift: a value within
 * 1e-13 of a multiple (relative, or 1e-9 steps when that's larger) counts as that multiple. Float
 * error grows with the number of steps (150,000 coins at 5 lot decimals is 1.5e10 steps), so a
 * fixed tolerance would floor an amount sitting on a lot boundary down a whole step.
 */
export const floorToStep = (value: number, step: number): number => {
  if (step <= 0) return value
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  const steps = value / step
  return Number((Math.floor(steps + Math.max(1e-9, Math.abs(steps) * 1e-13)) * step).toFixed(decimals))
}

/** Rounds `value` to the nearest multiple of `step` (e.g. a price tick). */
export const roundToStep = (value: number, step: number): number => {
  if (step <= 0) return value
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  return Number((Math.round(value / step) * step).toFixed(decimals))
}

export const bps = (fraction: number) => fraction * 10_000
export const fromBps = (value: number) => value / 10_000

/**
 * How much of an entry's base risk it takes, by its conviction: 0.75x at the minimum conviction
 * the rules accept, 1x halfway, 1.25x at the top. Conviction ranks ideas; it isn't a probability,
 * so it moves size only a little either way.
 */
export const convictionScale = (conviction: number, min: number, max: number) => (max > min ? 0.75 + 0.5 * clamp((conviction - min) / (max - min), 0, 1) : 1)
