import { SYMBOL_PATTERN } from "@mb/crypto-core/venues"
import { NextResponse } from "next/server"

/**
 * Price candles for the charts, straight from Kraken's public OHLC endpoint (no key). Vercel's
 * IPs are separate from the trading server's, so chart traffic never eats into the engine's
 * Kraken rate limit. Responses are cached briefly at the edge.
 */

const INTERVALS = new Set([5, 15, 60, 240, 1440])
const V2_TO_REST: Record<string, string> = { BTC: "XBT", DOGE: "XDG" }

export async function GET(request: Request) {
  const url = new URL(request.url)
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase()
  const interval = Number(url.searchParams.get("interval") ?? "60")
  if (!SYMBOL_PATTERN.test(symbol) || !INTERVALS.has(interval)) return NextResponse.json({ error: "bad symbol or interval" }, { status: 400 })
  const [base, quote] = symbol.split("/")
  const pair = `${V2_TO_REST[base] ?? base}${quote}`
  const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`, {
    next: { revalidate: interval <= 15 ? 30 : 120 },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!res?.ok) return NextResponse.json({ error: "Kraken unavailable" }, { status: 502 })
  const body = (await res.json()) as { error?: string[]; result?: Record<string, unknown> }
  if (body.error?.length || !body.result) return NextResponse.json({ error: body.error?.join(", ") ?? "no data" }, { status: 502 })
  const rows = Object.entries(body.result).find(([k]) => k !== "last")?.[1]
  if (!Array.isArray(rows)) return NextResponse.json({ candles: [] })
  const candles = (rows as [number, string, string, string, string, string, string, number][]).map((r) => ({
    time: r[0],
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[6]),
  }))
  return NextResponse.json({ candles }, { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } })
}
