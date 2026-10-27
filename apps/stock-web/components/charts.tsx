"use client"

import { MARKET_TZ } from "@mb/stock-core/time"
import {
  CumulativePnlChart as SharedCumulativePnlChart,
  EquityChart as SharedEquityChart,
  PnlChart,
  PriceChart as SharedPriceChart,
  type ChartLevel,
  type PnlDay,
  type TooltipRow,
} from "@mb/ui/charts"
import { zonedFormat } from "@mb/ui/lib/format"
import { useMemo, useState } from "react"
import type { CumulativePoint, PriceRange, PriceRow } from "@/lib/queries"
import { pct, price, qty, usd } from "@/lib/format"

/**
 * StockMarketBot's charts: the shared ones (@mb/ui/charts) with stock's data and formats. Times,
 * on the axis and in tooltips, are New York times, like the market. Charts are single-series
 * (equity, cumulative P&L) or polarity (daily P&L), so none needs a legend: the card title names
 * the series. P&L bars also encode sign by direction from the zero line.
 */

const { dateTime } = zonedFormat(MARKET_TZ)

/** Equity and price axes span at least 0.4% of the value, so moves of a few cents don't look like swings. */
const MIN_SPAN = 0.004

/** "Mon, Oct 26" for a market day. */
const weekdayDate = (t: number) => new Date(t).toLocaleDateString("en-US", { timeZone: MARKET_TZ, weekday: "short", month: "short", day: "numeric" })

type Point = { t: number; equity: number }

export function EquityChart({ series, baseline }: { series: { key: string; label: string; points: Point[] }[]; baseline: number }) {
  const [range, setRange] = useState(series.find((s) => s.points.length > 1)?.key ?? series[0]?.key ?? "")
  const current = series.find((s) => s.key === range) ?? series[0]
  const points = current?.points ?? []
  const last = points.at(-1)?.equity
  // Only pull the starting-balance line into view when it's near the data; otherwise it flattens the curve.
  const near = last !== undefined && Math.abs(baseline - last) / baseline < 0.25
  return (
    <SharedEquityChart
      points={points}
      baseline={baseline}
      fitBaseline={near}
      minSpan={MIN_SPAN}
      height={256}
      timeZone={MARKET_TZ}
      dateTime={dateTime}
      empty="Not enough history yet."
      tabs={{ value: range, options: series.map((s) => ({ key: s.key, label: s.label })), onChange: setRange }}
      rows={(p, first) => [
        ["Equity", usd(p.equity)],
        ["vs range start", first.equity ? pct(((p.equity - first.equity) / first.equity) * 100) : "—"],
        [`vs ${usd(baseline, { whole: true })} start`, pct(((p.equity - baseline) / baseline) * 100)],
      ]}
    />
  )
}

export function DailyPnlChart({ days }: { days: PnlDay[] }) {
  return (
    <PnlChart
      days={days}
      height={192}
      maxBarSpacing={30}
      timeZone={MARKET_TZ}
      empty="No completed trading days yet."
      formatDay={(d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
    />
  )
}

const ROLE: Record<PriceRow["fills"][number]["role"], string> = {
  entry: "entry",
  exit: "exit",
  take_profit: "take profit",
  stop_loss: "stop loss",
  spread: "spread",
}

export type PriceLevel = ChartLevel

type Bar = { t: number; close: number; row: PriceRow }
type Mark = { t: number; side: "buy" | "sell"; price: number }

/** Regular-session closes on an index axis (no overnight or weekend gaps), with the bot's fills at their prices. */
export function PriceChart({ symbol, ranges, levels }: { symbol: string; ranges: PriceRange[]; levels: PriceLevel[] }) {
  const [range, setRange] = useState(ranges.find((r) => r.rows.length > 1)?.key ?? ranges[0]?.key ?? "")
  const current = ranges.find((r) => r.key === range) ?? ranges[0]
  const rows = useMemo(() => current?.rows ?? [], [current])
  const intraday = current?.intraday ?? true
  const last = rows.at(-1)?.c
  // Only show stop/target/entry lines that are near the visible prices.
  const visibleLevels = last ? levels.filter((l) => Math.abs(l.value - last) / last < 0.2) : []
  const bars = useMemo(() => rows.map((row): Bar => ({ t: row.t, close: row.c, row })), [rows])
  // One ▲ / ▼ per side per bar, at that side's fill price.
  const marks = useMemo(
    () =>
      rows.flatMap((r): Mark[] => [
        ...(r.buy !== null ? [{ t: r.t, side: "buy" as const, price: r.buy }] : []),
        ...(r.sell !== null ? [{ t: r.t, side: "sell" as const, price: r.sell }] : []),
      ]),
    [rows],
  )

  return (
    <SharedPriceChart
      label={`${symbol} price`}
      kind="line"
      bars={bars}
      empty="No price data for this range."
      tabs={{ value: range, options: ranges.map((r) => ({ key: r.key, label: r.label })), onChange: setRange }}
      marks={marks}
      levels={visibleLevels}
      fitLevels
      minSpan={MIN_SPAN}
      price={price}
      height={288}
      timeZone={MARKET_TZ}
      intraday={intraday}
      tooltip={({ t, close, row }) => ({
        title: intraday ? dateTime(t) : weekdayDate(t),
        rows: [
          [intraday ? "Close" : "Day close", price(close)],
          ...row.fills.map((f, i): TooltipRow => [
            `${f.side === "buy" ? "▲ Bought" : "▼ Sold"} (${ROLE[f.role]})`,
            `${qty(f.qty)} @ ${price(f.price)}${f.realized_pnl !== null ? ` · ${usd(f.realized_pnl, { sign: true })}` : ""}${row.fills.length > 1 ? ` #${i + 1}` : ""}`,
          ]),
        ],
      })}
    />
  )
}

export function CumulativePnlChart({ points }: { points: CumulativePoint[] }) {
  return <SharedCumulativePnlChart points={points} height={224} timeZone={MARKET_TZ} dateTime={dateTime} empty="No closed trades yet." />
}
