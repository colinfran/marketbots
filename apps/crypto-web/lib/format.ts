/** Display formatting, shared by server and client components. */

export const TIME_ZONE = process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE || "America/Los_Angeles"

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

/** Crypto quantities: up to 8 decimals, trailing zeros trimmed. */
export const qty = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  return value.toFixed(8).replace(/\.?0+$/, "")
}

/** Prices with precision that suits the magnitude ($65,012.4 vs $0.1834). */
export const price = (value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  const digits = value >= 1_000 ? 2 : value >= 1 ? 3 : value >= 0.01 ? 4 : 6
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits })}`
}

export const num = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits })

/** Text color for a signed number. Always paired with a sign or arrow, never color alone. */
export const tone = (value: number | null | undefined) =>
  !value || Math.abs(value) < 0.005 ? "text-muted-foreground" : value > 0 ? "text-gain" : "text-loss"

export const titleCase = (value: string) => value.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

export const dateTime = (value: Date | string | number | null | undefined) =>
  value ? new Date(value).toLocaleString("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"

/** A UTC day ("2026-10-26") → "Mon, Oct 26, 2026". */
export const formatDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

export const time = (value: Date | string | number | null | undefined) =>
  value ? new Date(value).toLocaleTimeString("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—"

export const ago = (value: Date | string | number | null | undefined, now = Date.now()) => {
  if (!value) return "never"
  const s = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** "in 4m" for a future time, "now" once it has passed. */
export const until = (value: Date | string | number | null | undefined, now = Date.now()) => {
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

/** "BTC/USD" ↔ URL slug "BTC-USD". */
export const symbolSlug = (symbol: string) => symbol.replace("/", "-")
export const slugSymbol = (slug: string) => decodeURIComponent(slug).replace("-", "/").toUpperCase()
