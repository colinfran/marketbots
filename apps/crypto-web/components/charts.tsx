"use client"

import {
  DrawdownChart as SharedDrawdownChart,
  EquityChart as SharedEquityChart,
  PnlChart,
  PriceChart as SharedPriceChart,
  type ChartLevel,
  type PnlDay,
  type TooltipRow,
} from "@mb/ui/charts"
import { useEffect, useMemo, useState } from "react"
import { dateTime, pct, price, qty } from "@/lib/format"

/**
 * CryptoMarketBot's charts: the shared ones (@mb/ui/charts) with crypto's data and formats, drawn
 * as before the move: the time axis reads in UTC (the library's default), tooltips in the display
 * time zone, and every price axis uses the `price` format (so the drawdown axis shows its percent
 * values with a "$"; dropping `axisFormat` gives each chart its own format).
 */

export type { ChartLevel }
export type ChartFill = { at: string | number | Date; side: "buy" | "sell"; price: number; qty: number }

const INTERVALS = [
  { key: "15", label: "15m" },
  { key: "60", label: "1H" },
  { key: "240", label: "4H" },
  { key: "1440", label: "1D" },
]

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }
type Bar = { t: number; open: number; high: number; low: number; close: number }
type Mark = { t: number; side: "buy" | "sell"; price: number; qty: number }

/** Kraken candles for a pair (refreshed every minute), with the bot's paper fills and stop/target levels. */
export function PriceChart({ symbol, fills = [], levels = [], height = 360 }: { symbol: string; fills?: ChartFill[]; levels?: ChartLevel[]; height?: number }) {
  const [interval, setInterval_] = useState("60")
  const [candles, setCandles] = useState<Candle[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const res = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}`).catch(() => null)
      const body = res?.ok ? ((await res.json()) as { candles: Candle[] }) : null
      if (!alive) return
      if (body) {
        setCandles(body.candles)
        setError(null)
      } else setError("Couldn't load candles from Kraken.")
    }
    void load()
    const t = window.setInterval(load, 60_000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [symbol, interval])

  const bars = useMemo(() => candles?.map((c): Bar => ({ t: c.time * 1000, open: c.open, high: c.high, low: c.low, close: c.close })) ?? null, [candles])
  // Each fill is drawn on the candle it happened in.
  const marks = useMemo(() => fills.map((f): Mark => ({ t: new Date(f.at).getTime(), side: f.side, price: f.price, qty: f.qty })), [fills])

  return (
    <SharedPriceChart
      label={`${symbol} price`}
      kind="candles"
      bars={bars}
      error={error}
      tabs={{ value: interval, options: INTERVALS, onChange: setInterval_ }}
      marks={marks}
      levels={levels}
      price={price}
      height={height}
      tooltip={(c, here) => ({
        title: dateTime(c.t),
        rows: [
          ["Open", price(c.open)],
          ["High", price(c.high)],
          ["Low", price(c.low)],
          ["Close", price(c.close)],
          ["Change", pct((c.close / c.open - 1) * 100)],
          ...here.map((f, i): TooltipRow => [`${f.side === "buy" ? "▲ Bought" : "▼ Sold"}${here.length > 1 ? ` #${i + 1}` : ""}`, `${qty(f.qty)} @ ${price(f.price)}`]),
        ],
      })}
    />
  )
}

export function EquityChart({ points, baseline, height = 260 }: { points: { t: number; equity: number }[]; baseline: number; height?: number }) {
  return <SharedEquityChart points={points} baseline={baseline} height={height} dateTime={dateTime} axisFormat={price} empty="Not enough history yet: snapshots are taken every 5 minutes." />
}

export function DrawdownChart({ points, height = 180 }: { points: { t: number; dd_pct: number }[]; height?: number }) {
  return <SharedDrawdownChart points={points} height={height} dateTime={dateTime} axisFormat={price} empty="No drawdown history yet." />
}

export function DailyPnlChart({ days, height = 200 }: { days: PnlDay[]; height?: number }) {
  return <PnlChart days={days} height={height} axisFormat={price} empty="No completed days yet (days close at 00:00 UTC)." />
}
