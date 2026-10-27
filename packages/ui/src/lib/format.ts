/**
 * Display formatting both dashboards share, for server and client components. What differs per
 * bot stays in the app's lib/format: prices and quantities (crypto's magnitude-aware decimals vs
 * stock's cents and shares) and symbol URLs. Times use the time zone each app passes to
 * `zonedFormat` (crypto NEXT_PUBLIC_DISPLAY_TIMEZONE, stock New York).
 */

const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export const usd = (value: number | null | undefined, { sign = false, whole = false } = {}) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  value = Math.round(value * 100) / 100
  const text = (whole ? wholeUsd : usdFormatter).format(Math.abs(value))
  if (value < 0) return `−${text}`
  return sign && value > 0 ? `+${text}` : text
}

export const pct = (value: number | null | undefined, { sign = true, digits = 2 } = {}) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  value = Number(value.toFixed(digits))
  const text = `${Math.abs(value).toFixed(digits)}%`
  if (value < 0) return `−${text}`
  return sign && value > 0 ? `+${text}` : text
}

export const num = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits })

/** Text color for a signed number. Always paired with a sign or arrow, never color alone. */
export const tone = (value: number | null | undefined) =>
  !value || Math.abs(value) < 0.005 ? "text-muted-foreground" : value > 0 ? "text-gain" : "text-loss"

export const titleCase = (value: string) => value.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

type When = Date | string | number | null | undefined

/** "Oct 26, 10:30 AM" and "10:30:15 AM" in one time zone. */
export const zonedFormat = (timeZone: string) => ({
  dateTime: (value: When) =>
    value ? new Date(value).toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—",
  time: (value: When) => (value ? new Date(value).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—"),
})

export const ago = (value: When, now = Date.now()) => {
  if (!value) return "never"
  const s = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** "in 4m" for a future time, "now" once it has passed. */
export const until = (value: When, now = Date.now()) => {
  if (!value) return "—"
  const s = Math.round((new Date(value).getTime() - now) / 1000)
  if (s <= 0) return "now"
  if (s < 60) return `in ${s}s`
  if (s < 3_600) return `in ${Math.floor(s / 60)}m`
  return `in ${Math.floor(s / 3_600)}h`
}

export const duration = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return "—"
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
