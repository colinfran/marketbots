/** Display formatting, shared by server and client components. */

import { zonedFormat } from "@mb/ui/lib/format"

export { ago, duration, num, pct, titleCase, tone, until, usd } from "@mb/ui/lib/format"

export const TIME_ZONE = process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE || "America/Los_Angeles"

export const { dateTime, time } = zonedFormat(TIME_ZONE)

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

/** A UTC day ("2026-10-26") → "Mon, Oct 26, 2026". */
export const formatDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

/** "BTC/USD" ↔ URL slug "BTC-USD". */
export const symbolSlug = (symbol: string) => symbol.replace("/", "-")
export const slugSymbol = (slug: string) => decodeURIComponent(slug).replace("-", "/").toUpperCase()
