/** Display formatting, shared by server and client components. Times are shown in New York time, like the market. */

import { MARKET_TZ } from "@mb/stock-core/time"

const usdFormatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export const usd = (value: number | null | undefined, { sign = false, whole = false } = {}) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—"
  value = Math.round(value * 100) / 100
  const text = (whole ? compactUsd : usdFormatter).format(Math.abs(value))
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

export const qty = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(4))

export const price = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`)

export const num = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits })

/** Text color for a signed number. Always paired with a sign/arrow, never color alone. */
export const tone = (value: number | null | undefined) => (!value || Math.abs(value) < 0.005 ? "text-muted-foreground" : value > 0 ? "text-gain" : "text-loss")

export const titleCase = (value: string) => value.replace(/[_.]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())

const WIRE_SOURCE_LABEL: Record<string, string> = { alpaca_news: "Benzinga via Alpaca" }

/** Who published a news-engine item: Benzinga headlines reach us through Alpaca, so both get the credit. */
export const wireSource = (source: string, domain?: string | null) => WIRE_SOURCE_LABEL[source] ?? domain ?? source

/** "10:30:15 AM" in New York time (for live feeds). */
export const time = (value: Date | string | number | null | undefined) =>
  value ? new Date(value).toLocaleTimeString("en-US", { timeZone: MARKET_TZ, hour: "numeric", minute: "2-digit", second: "2-digit" }) : "—"

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
