import type { SourceContext } from "../types"

/**
 * Small helpers shared by the crypto wave-2 sources: the universe as base assets, and the number
 * formats item titles use.
 */

/** "BTC/USD" → "BTC". */
export const baseOf = (symbol: string) => symbol.split("/")[0].toUpperCase()

/** The universe as base asset → bot symbol ("BTC" → "BTC/USD"). */
export const universeBases = (ctx: Pick<SourceContext, "symbols">) => new Map(ctx.symbols().universe.map((s) => [baseOf(s), s]))

export const signed = (n: number, digits = 1) => `${n > 0 ? "+" : ""}${n.toFixed(digits)}`

/** $1.2B, $48.2M, $950K, $12. */
export const usd = (n: number) => {
  const a = Math.abs(n)
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0)
  return `${n < 0 ? "-" : ""}$${s}`
}

export const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Runs independent requests; one failing doesn't sink the rest, but all failing is the poll's failure. */
export const settleAll = async <T>(jobs: (() => Promise<T>)[]): Promise<(T | null)[]> => {
  const results = await Promise.allSettled(jobs.map((j) => j()))
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
  if (failed.length && failed.length === results.length) throw failed[0].reason
  return results.map((r) => (r.status === "fulfilled" ? r.value : null))
}
