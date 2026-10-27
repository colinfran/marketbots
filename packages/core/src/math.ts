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

/** Floors `value` to a multiple of `step` (e.g. a lot size), without float drift. */
export const floorToStep = (value: number, step: number): number => {
  if (step <= 0) return value
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  return Number((Math.floor(value / step + 1e-9) * step).toFixed(decimals))
}

/** Rounds `value` to the nearest multiple of `step` (e.g. a price tick). */
export const roundToStep = (value: number, step: number): number => {
  if (step <= 0) return value
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)))
  return Number((Math.round(value / step) * step).toFixed(decimals))
}

export const bps = (fraction: number) => fraction * 10_000
export const fromBps = (value: number) => value / 10_000
