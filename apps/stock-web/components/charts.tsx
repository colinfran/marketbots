"use client"

import { useState } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { CumulativePoint, PriceRange, PriceRow } from "@/lib/queries"
import { pct, price, qty, usd } from "@/lib/format"

/**
 * Charts are single-series (equity) or polarity (daily P&L), so neither needs a legend: the card
 * title names the series. P&L bars also encode sign by direction from the zero line, so color is
 * never the only cue.
 */

type Point = { t: number; equity: number }

const equityConfig = { equity: { label: "Equity", color: "var(--series-1)" } } satisfies ChartConfig

const tzOpts = { timeZone: "America/New_York" } as const
const fmtTick = (t: number, intraday: boolean) =>
  new Date(t).toLocaleString("en-US", intraday ? { ...tzOpts, hour: "numeric", minute: "2-digit" } : { ...tzOpts, month: "short", day: "numeric" })
const fmtFull = (t: number) =>
  new Date(t).toLocaleString("en-US", { ...tzOpts, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

function TooltipCard({ title, rows }: { title: string; rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <div className="bg-background grid min-w-36 gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{row.label}</span>
          <span className="font-mono font-medium tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  )
}

export function EquityChart({
  series,
  baseline,
}: {
  series: { key: string; label: string; points: Point[] }[]
  baseline: number
}) {
  const [range, setRange] = useState(series.find((s) => s.points.length > 1)?.key ?? series[0]?.key)
  const current = series.find((s) => s.key === range) ?? series[0]
  const points = current?.points ?? []
  const intraday = range === "1D" || range === "1W"
  const first = points[0]?.equity
  const values = points.map((p) => p.equity)
  // Only pull the starting-balance line into view when it's near the data; otherwise it flattens the curve.
  const showBaseline = values.length > 0 && Math.abs(baseline - values[values.length - 1]) / baseline < 0.25
  const min = Math.min(...values, ...(showBaseline ? [baseline] : []))
  const max = Math.max(...values, ...(showBaseline ? [baseline] : []))
  const pad = Math.max((max - min) * 0.1, max * 0.002)

  return (
    <div className="space-y-3">
      <Tabs value={range} onValueChange={setRange}>
        <TabsList>
          {series.map((s) => (
            <TabsTrigger key={s.key} value={s.key}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {points.length < 2 ? (
        <p className="text-muted-foreground flex h-64 items-center justify-center text-sm">Not enough history yet.</p>
      ) : (
        <ChartContainer config={equityConfig} className="aspect-auto h-64 w-full">
          <AreaChart data={points} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-equity)" stopOpacity={0.18} />
                <stop offset="100%" stopColor="var(--color-equity)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t) => fmtTick(t, intraday)}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              domain={[min - pad, max + pad]}
              tickFormatter={(v) => usd(v, { whole: true })}
              tickLine={false}
              axisLine={false}
              width={72}
            />
            {showBaseline && (
              <ReferenceLine
                y={baseline}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 4"
                label={{ value: `Start ${usd(baseline, { whole: true })}`, position: "insideBottomLeft", fill: "var(--muted-foreground)", fontSize: 11 }}
              />
            )}
            <ChartTooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
              content={({ active, payload }) => {
                const p = active ? (payload?.[0]?.payload as Point | undefined) : undefined
                if (!p) return null
                return (
                  <TooltipCard
                    title={fmtFull(p.t)}
                    rows={[
                      { label: "Equity", value: usd(p.equity) },
                      { label: "vs range start", value: first ? pct(((p.equity - first) / first) * 100) : "—" },
                      { label: `vs ${usd(baseline, { whole: true })} start`, value: pct(((p.equity - baseline) / baseline) * 100) },
                    ]}
                  />
                )
              }}
            />
            <Area
              dataKey="equity"
              type="monotone"
              stroke="var(--color-equity)"
              strokeWidth={2}
              fill="url(#equityFill)"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ChartContainer>
      )}
    </div>
  )
}

type DayPoint = { day: string; pnl: number; pnl_pct: number }

const pnlConfig = { pnl: { label: "Daily P&L" } } satisfies ChartConfig

export function DailyPnlChart({ days }: { days: DayPoint[] }) {
  if (days.length === 0) {
    return <p className="text-muted-foreground flex h-48 items-center justify-center text-sm">No completed trading days yet.</p>
  }
  return (
    <ChartContainer config={pnlConfig} className="aspect-auto h-48 w-full">
      <BarChart data={days} margin={{ left: 4, right: 8, top: 8, bottom: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="day"
          tickFormatter={(d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis tickFormatter={(v) => usd(v, { whole: true })} tickLine={false} axisLine={false} width={64} />
        <ReferenceLine y={0} stroke="var(--border)" />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.5 }}
          content={({ active, payload }) => {
            const d = active ? (payload?.[0]?.payload as DayPoint | undefined) : undefined
            if (!d) return null
            return (
              <TooltipCard
                title={new Date(`${d.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}
                rows={[
                  { label: "P&L", value: usd(d.pnl, { sign: true }) },
                  { label: "Return", value: pct(d.pnl_pct) },
                ]}
              />
            )
          }}
        />
        <Bar dataKey="pnl" radius={[4, 4, 4, 4]} maxBarSize={28} isAnimationActive={false}>
          {days.map((d) => (
            <Cell key={d.day} fill={d.pnl >= 0 ? "var(--gain)" : "var(--loss)"} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  )
}

const ROLE: Record<PriceRow["fills"][number]["role"], string> = {
  entry: "entry",
  exit: "exit",
  take_profit: "take profit",
  stop_loss: "stop loss",
  spread: "spread",
}

/** ▲ for buys / ▼ for sells, drawn at the actual fill price with a surface ring so it reads over the line. */
const tradeMarker = (side: "buy" | "sell") =>
  function Marker(props: { cx?: number; cy?: number; index?: number; payload?: PriceRow }) {
    const { cx, cy, index, payload } = props
    if (cx == null || cy == null || payload?.[side] == null) return <g key={`${side}-${index}`} />
    const s = 7
    const d = side === "buy" ? `M${cx},${cy - s} L${cx + s},${cy + s * 0.8} L${cx - s},${cy + s * 0.8} Z` : `M${cx},${cy + s} L${cx + s},${cy - s * 0.8} L${cx - s},${cy - s * 0.8} Z`
    return <path key={`${side}-${index}`} d={d} fill={side === "buy" ? "var(--gain)" : "var(--loss)"} stroke="var(--background)" strokeWidth={2} />
  }

const BuyMarker = tradeMarker("buy")
const SellMarker = tradeMarker("sell")

export type PriceLevel = { label: string; value: number }

export function PriceChart({ ranges, levels }: { ranges: PriceRange[]; levels: PriceLevel[] }) {
  const [range, setRange] = useState(ranges.find((r) => r.rows.length > 1)?.key ?? ranges[0]?.key)
  const current = ranges.find((r) => r.key === range) ?? ranges[0]
  const rows = current?.rows ?? []
  const last = rows[rows.length - 1]?.c
  // Only show stop/target/entry lines that are near the visible prices.
  const visibleLevels = last ? levels.filter((l) => Math.abs(l.value - last) / last < 0.2) : []
  const values = [...rows.flatMap((r) => [r.c, r.buy, r.sell]), ...visibleLevels.map((l) => l.value)].filter((v): v is number => typeof v === "number")
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = Math.max((max - min) * 0.08, max * 0.002)
  const hasBuys = rows.some((r) => r.buy !== null)
  const hasSells = rows.some((r) => r.sell !== null)
  const tick = (i: number) => {
    const t = rows[Math.round(i)]?.t
    if (!t) return ""
    if (range === "1D") return new Date(t).toLocaleTimeString("en-US", { ...tzOpts, hour: "numeric", minute: "2-digit" })
    return new Date(t).toLocaleDateString("en-US", { ...tzOpts, month: "short", day: "numeric" })
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={range} onValueChange={setRange}>
          <TabsList>
            {ranges.map((r) => (
              <TabsTrigger key={r.key} value={r.key}>
                {r.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-series-1 h-0.5 w-4 rounded" /> Price
          </span>
          {hasBuys && <span className="inline-flex items-center gap-1"><span className="text-gain">▲</span> Buy</span>}
          {hasSells && <span className="inline-flex items-center gap-1"><span className="text-loss">▼</span> Sell</span>}
          {visibleLevels.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="border-muted-foreground w-4 border-t border-dashed" /> Stop / target</span>}
        </div>
      </div>
      {rows.length < 2 ? (
        <p className="text-muted-foreground flex h-72 items-center justify-center text-sm">No price data for this range.</p>
      ) : (
        <ChartContainer config={{ c: { label: "Price", color: "var(--series-1)" } }} className="aspect-auto h-72 w-full">
          <ComposedChart data={rows} margin={{ left: 4, right: 8, top: 12, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="i" type="number" domain={[0, rows.length - 1]} tickFormatter={tick} tickLine={false} axisLine={false} minTickGap={40} allowDecimals={false} />
            <YAxis domain={[min - pad, max + pad]} tickFormatter={(v: number) => `$${v.toFixed(max - min < 20 ? 2 : 0)}`} tickLine={false} axisLine={false} width={68} />
            {visibleLevels.map((l) => (
              <ReferenceLine
                key={l.label}
                y={l.value}
                stroke="var(--muted-foreground)"
                strokeDasharray="4 4"
                label={{ value: `${l.label} ${price(l.value)}`, position: "insideTopRight", fill: "var(--muted-foreground)", fontSize: 11 }}
              />
            ))}
            <ChartTooltip
              cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
              content={({ active, payload }) => {
                const row = active ? (payload?.[0]?.payload as PriceRow | undefined) : undefined
                if (!row) return null
                return (
                  <TooltipCard
                    title={current.intraday ? fmtFull(row.t) : new Date(row.t).toLocaleDateString("en-US", { ...tzOpts, weekday: "short", month: "short", day: "numeric" })}
                    rows={[
                      { label: current.intraday ? "Close" : "Day close", value: price(row.c) },
                      ...row.fills.map((f, i) => ({
                        label: `${f.side === "buy" ? "▲ Bought" : "▼ Sold"} (${ROLE[f.role]})`,
                        value: `${qty(f.qty)} @ ${price(f.price)}${f.realized_pnl !== null ? ` · ${usd(f.realized_pnl, { sign: true })}` : ""}${row.fills.length > 1 ? ` #${i + 1}` : ""}`,
                      })),
                    ]}
                  />
                )
              }}
            />
            <Line dataKey="c" type="linear" stroke="var(--color-c)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }} isAnimationActive={false} />
            <Line dataKey="buy" stroke="transparent" dot={BuyMarker} activeDot={false} legendType="none" isAnimationActive={false} />
            <Line dataKey="sell" stroke="transparent" dot={SellMarker} activeDot={false} legendType="none" isAnimationActive={false} />
          </ComposedChart>
        </ChartContainer>
      )}
    </div>
  )
}

export function CumulativePnlChart({ points }: { points: CumulativePoint[] }) {
  if (points.length < 2) {
    return <p className="text-muted-foreground flex h-56 items-center justify-center text-sm">No closed trades yet.</p>
  }
  return (
    <ChartContainer config={{ cum: { label: "Cumulative realized P&L", color: "var(--series-1)" } }} className="aspect-auto h-56 w-full">
      <LineChart data={points} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="i"
          type="number"
          domain={[0, points.length - 1]}
          tickFormatter={(i: number) => {
            const t = points[Math.round(i)]?.t
            return t ? new Date(t).toLocaleDateString("en-US", { ...tzOpts, month: "short", day: "numeric" }) : ""
          }}
          tickLine={false}
          axisLine={false}
          minTickGap={40}
          allowDecimals={false}
        />
        <YAxis
          domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
          tickFormatter={(v) => usd(v, { whole: true })}
          tickLine={false}
          axisLine={false}
          width={64}
        />
        <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeOpacity={0.6} />
        <ChartTooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeWidth: 1 }}
          content={({ active, payload }) => {
            const p = active ? (payload?.[0]?.payload as CumulativePoint | undefined) : undefined
            if (!p || !p.symbol) return null
            return (
              <TooltipCard
                title={`${p.symbol} · ${fmtFull(p.t)}`}
                rows={[
                  { label: "This trade", value: usd(p.pnl, { sign: true }) },
                  { label: "Running total", value: usd(p.cum, { sign: true }) },
                ]}
              />
            )
          }}
        />
        <Line dataKey="cum" type="stepAfter" stroke="var(--color-cum)" strokeWidth={2} dot={points.length <= 60 ? { r: 2.5, fill: "var(--color-cum)", strokeWidth: 0 } : false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  )
}
