import { marketClock, marketDay } from "@mb/stock-core/time"
import { HttpError } from "@mb/engine-kit/util/http"
import type { SourceContext } from "../types"

/**
 * Small helpers shared by the stock wave-2 sources: which symbols a source covers, the number and
 * date formats item titles use, and the browser User-Agent a few sites insist on.
 */

/**
 * CNN, Nasdaq, openinsider, Finviz and the FDA's site answer browsers only. The key is lowercase on
 * purpose: wire/fetch.ts spreads a spec's headers after its own lowercase "user-agent", so this
 * replaces it instead of being sent alongside it.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
}

/** Held (including option underlyings) and watched symbols: what the per-symbol sources cover. */
export const watched = (ctx: Pick<SourceContext, "symbols">) => {
  const s = ctx.symbols()
  return new Set([...s.held, ...s.focus])
}

/** Every symbol the wire tags items with: held, watched, benchmarks and today's movers. */
export const tracked = (ctx: Pick<SourceContext, "symbols">) => {
  const s = ctx.symbols()
  return new Set([...s.universe, ...s.held, ...s.focus])
}

export const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[$,%\s]/g, "")) : NaN
  return Number.isFinite(n) ? n : null
}

export const signed = (n: number, digits = 1) => `${n > 0 ? "+" : ""}${n.toFixed(digits)}`

/** $1.2B, $48.2M, $950K, $12. */
export const usd = (n: number) => {
  const a = Math.abs(n)
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0)
  return `${n < 0 ? "-" : ""}$${s}`
}

/** 1.2B, 48.2M, 950K, 12 (share counts). */
export const count = (n: number) => usd(n).replace("$", "")

/** Runs independent requests; one failing doesn't sink the rest, but all failing is the poll's failure. */
export const settleAll = async <T>(jobs: (() => Promise<T>)[]): Promise<(T | null)[]> => {
  const results = await Promise.allSettled(jobs.map((j) => j()))
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
  if (failed.length && failed.length === results.length) throw failed[0].reason
  return results.map((r) => (r.status === "fulfilled" ? r.value : null))
}

/** A missing file or page (FINRA answers 403 for a day it hasn't published). */
export const isMissing = (error: unknown) => error instanceof HttpError && (error.status === 403 || error.status === 404)

/** "10/27/2026" → "2026-10-27" (null when it isn't a US date). */
export const usDate = (s: string | null | undefined) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec((s ?? "").trim())
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null
}

/** "20261015" or "2026-10-15T00:00:00" → "2026-10-15". */
export const isoDay = (s: string | null | undefined) => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec((s ?? "").trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** A calendar day as an instant (midnight UTC), for daily data that has no time of its own. */
export const dayStart = (day: string) => new Date(`${day}T00:00:00Z`)

/** "Oct 16" for a YYYY-MM-DD day. */
export const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/** Weekday (0 Sunday … 6 Saturday) and wall-clock minutes in New York. */
export const etNow = (now: Date) => {
  const day = marketDay(now)
  const [h, m] = marketClock(now).split(":").map(Number)
  return { day, weekday: new Date(`${day}T12:00:00Z`).getUTCDay(), minutes: h * 60 + m }
}

/** The weekdays before `day` (YYYY-MM-DD), newest first. Exchange holidays are not known here; their files are simply missing. */
export const previousWeekdays = (day: string, n: number) => {
  const out: string[] = []
  const d = new Date(`${day}T12:00:00Z`)
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() - 1)
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/** The next `n` days from `day` (YYYY-MM-DD) that are weekdays, `day` included when it is one. */
export const nextWeekdays = (day: string, n: number) => {
  const out: string[] = []
  const d = new Date(`${day}T12:00:00Z`)
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
