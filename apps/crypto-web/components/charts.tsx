"use client"

import {
  AreaSeries,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { useTheme } from "next-themes"
import { useEffect, useMemo, useRef, useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@mb/ui/components/tabs"
import { dateTime, pct, price, qty, usd } from "@/lib/format"

/**
 * Charts (TradingView Lightweight Charts). Encoding rules:
 * - single-series charts (equity, drawdown) have no legend; the card title names the series;
 * - polarity (candles, daily P&L) uses the validated blue-up / red-down pair, and P&L bars also
 *   encode sign by direction from the zero line, so color is never the only cue;
 * - trade markers are ink-colored ▲ buy / ▼ sell shapes, readable over either candle color;
 * - every chart has a crosshair tooltip.
 */

type Theme = { text: string; muted: string; grid: string; up: string; down: string; series: string; ink: string }

/** Chart colors from the CSS tokens (hex, so the canvas renderer can parse them). */
const readTheme = (): Theme => {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    text: v("--chart-ink", "#0b0b0b"),
    muted: v("--chart-axis", "#898781"),
    grid: v("--chart-grid", "#e1e0d9"),
    up: v("--up", "#2a78d6"),
    down: v("--down", "#e34948"),
    series: v("--series-1", "#2a78d6"),
    ink: v("--chart-ink", "#0b0b0b"),
  }
}

/** "#2a78d6" + 0.18 → "rgba(42,120,214,0.18)". */
const alpha = (hex: string, a: number) => {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6)
  const n = Number.parseInt(full, 16)
  return Number.isFinite(n) ? `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` : hex
}

/** Creates a chart in a container, keeps it sized and themed, and tears it down. */
const useChart = (build: (chart: IChartApi, theme: Theme, container: HTMLDivElement) => (() => void) | void, deps: unknown[], height: number) => {
  const ref = useRef<HTMLDivElement>(null)
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const theme = readTheme()
    const chart = createChart(el, {
      height,
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: theme.muted, fontFamily: "inherit", attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: theme.grid, style: LineStyle.Dotted } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: theme.muted, labelBackgroundColor: theme.text }, horzLine: { color: theme.muted, labelBackgroundColor: theme.text } },
      localization: { priceFormatter: (p: number) => price(p) },
    })
    const cleanup = build(chart, theme, el)
    return () => {
      cleanup?.()
      chart.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme, height, ...deps])
  return ref
}

function Tooltip({ data }: { data: { x: number; y: number; title: string; rows: [string, React.ReactNode][] } | null }) {
  if (!data) return null
  return (
    <div className="bg-popover pointer-events-none absolute z-10 grid min-w-40 gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg" style={{ left: data.x, top: data.y }}>
      <div className="font-medium">{data.title}</div>
      {data.rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  )
}

type TooltipData = { x: number; y: number; title: string; rows: [string, React.ReactNode][] } | null

/** Positions a tooltip near the cursor, flipped to stay inside the chart. */
const place = (param: MouseEventParams, width: number) => ({
  x: Math.min(Math.max(0, (param.point?.x ?? 0) + 14), Math.max(0, width - 180)),
  y: Math.max(0, (param.point?.y ?? 0) - 10),
})

const toTs = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp

/** Strictly increasing timestamps (lightweight-charts requirement): keep the last value per second. */
const dedupe = <T extends { time: UTCTimestamp }>(rows: T[]) => {
  const map = new Map<number, T>()
  for (const r of rows) map.set(r.time, r)
  return [...map.values()].sort((a, b) => a.time - b.time)
}

// ─────────────────────────────────────────────────────────────────────────────

export type ChartFill = { at: string | number | Date; side: "buy" | "sell"; price: number; qty: number }
export type ChartLevel = { label: string; value: number }

const INTERVALS = [
  { key: "15", label: "15m" },
  { key: "60", label: "1H" },
  { key: "240", label: "4H" },
  { key: "1440", label: "1D" },
]

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }

export function PriceChart({ symbol, fills = [], levels = [], height = 360 }: { symbol: string; fills?: ChartFill[]; levels?: ChartLevel[]; height?: number }) {
  const [interval, setInterval_] = useState("60")
  const [candles, setCandles] = useState<Candle[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tip, setTip] = useState<TooltipData>(null)

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

  const fillKey = useMemo(() => JSON.stringify(fills.map((f) => [f.at, f.side, f.price])), [fills])
  const levelKey = useMemo(() => JSON.stringify(levels), [levels])

  const ref = useChart(
    (chart, theme, el) => {
      if (!candles?.length) return
      const series = chart.addSeries(CandlestickSeries, {
        upColor: theme.up,
        downColor: theme.down,
        wickUpColor: theme.up,
        wickDownColor: theme.down,
        borderVisible: false,
      })
      const data = dedupe(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })))
      series.setData(data)
      const step = Number(interval) * 60
      const first = data[0]?.time ?? 0
      // Snap each fill to the candle it happened in.
      const markers: SeriesMarker<Time>[] = fills
        .map((f) => ({ f, t: Math.floor(new Date(f.at).getTime() / 1000 / step) * step }))
        .filter(({ t }) => t >= first)
        .sort((a, b) => a.t - b.t)
        .map(({ f, t }) => ({
          time: t as UTCTimestamp,
          position: f.side === "buy" ? "belowBar" : "aboveBar",
          shape: f.side === "buy" ? "arrowUp" : "arrowDown",
          color: theme.ink,
          text: f.side === "buy" ? "B" : "S",
          size: 1,
        }))
      createSeriesMarkers(series, markers)
      for (const l of levels) {
        series.createPriceLine({ price: l.value, color: theme.muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: l.label })
      }
      chart.timeScale().fitContent()
      const byTime = new Map(data.map((c) => [c.time as number, c]))
      const handler = (param: MouseEventParams) => {
        const c = param.time ? byTime.get(param.time as number) : undefined
        if (!c || !param.point) return setTip(null)
        const here = fills.filter((f) => Math.floor(new Date(f.at).getTime() / 1000 / step) * step === c.time)
        setTip({
          ...place(param, el.clientWidth),
          title: dateTime(c.time * 1000),
          rows: [
            ["Open", price(c.open)],
            ["High", price(c.high)],
            ["Low", price(c.low)],
            ["Close", price(c.close)],
            ["Change", pct((c.close / c.open - 1) * 100)],
            ...here.map((f, i): [string, React.ReactNode] => [`${f.side === "buy" ? "▲ Bought" : "▼ Sold"}${here.length > 1 ? ` #${i + 1}` : ""}`, `${qty(f.qty)} @ ${price(f.price)}`]),
          ],
        })
      }
      chart.subscribeCrosshairMove(handler)
      return () => chart.unsubscribeCrosshairMove(handler)
    },
    [candles, fillKey, levelKey, interval],
    height,
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={interval} onValueChange={setInterval_}>
          <TabsList>
            {INTERVALS.map((i) => (
              <TabsTrigger key={i.key} value={i.key}>
                {i.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-up inline-block size-2.5 rounded-sm" /> Up candle
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-down inline-block size-2.5 rounded-sm" /> Down candle
          </span>
          {fills.length > 0 && <span>▲ buy · ▼ sell (paper fills)</span>}
          {levels.length > 0 && <span className="inline-flex items-center gap-1.5"><span className="border-muted-foreground w-4 border-t border-dashed" /> Stop / target</span>}
        </div>
      </div>
      <div className="relative" style={{ height }}>
        {error ? (
          <p className="text-muted-foreground flex h-full items-center justify-center text-sm">{error}</p>
        ) : !candles ? (
          <div className="bg-muted/40 h-full animate-pulse rounded-lg" />
        ) : (
          <>
            <div ref={ref} className="h-full w-full" />
            <Tooltip data={tip} />
          </>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

export function EquityChart({ points, baseline, height = 260 }: { points: { t: number; equity: number }[]; baseline: number; height?: number }) {
  const [tip, setTip] = useState<TooltipData>(null)
  const key = points.length ? `${points[0].t}-${points.at(-1)!.t}-${points.length}-${points.at(-1)!.equity}` : "empty"
  const ref = useChart(
    (chart, theme, el) => {
      if (points.length < 2) return
      const series = chart.addSeries(AreaSeries, {
        lineColor: theme.series,
        lineWidth: 2,
        topColor: alpha(theme.series, 0.18),
        bottomColor: alpha(theme.series, 0),
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: "custom", formatter: (v: number) => usd(v, { whole: true }) },
      })
      const data = dedupe(points.map((p) => ({ time: toTs(p.t), value: p.equity })))
      series.setData(data)
      series.createPriceLine({ price: baseline, color: theme.muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "start" })
      chart.timeScale().fitContent()
      const byTime = new Map(data.map((d) => [d.time as number, d.value]))
      const handler = (param: MouseEventParams) => {
        const v = param.time ? byTime.get(param.time as number) : undefined
        if (v === undefined || !param.point) return setTip(null)
        setTip({ ...place(param, el.clientWidth), title: dateTime((param.time as number) * 1000), rows: [["Equity", usd(v)], ["vs start", pct((v / baseline - 1) * 100)]] })
      }
      chart.subscribeCrosshairMove(handler)
      return () => chart.unsubscribeCrosshairMove(handler)
    },
    [key, baseline],
    height,
  )
  if (points.length < 2) return <p className="text-muted-foreground flex items-center justify-center text-sm" style={{ height }}>Not enough history yet: snapshots are taken every 5 minutes.</p>
  return (
    <div className="relative" style={{ height }}>
      <div ref={ref} className="h-full w-full" />
      <Tooltip data={tip} />
    </div>
  )
}

export function DrawdownChart({ points, height = 180 }: { points: { t: number; dd_pct: number }[]; height?: number }) {
  const [tip, setTip] = useState<TooltipData>(null)
  const key = points.length ? `${points[0].t}-${points.at(-1)!.t}-${points.length}` : "empty"
  const ref = useChart(
    (chart, theme, el) => {
      if (points.length < 2) return
      const series = chart.addSeries(AreaSeries, {
        lineColor: theme.down,
        lineWidth: 2,
        topColor: alpha(theme.down, 0),
        bottomColor: alpha(theme.down, 0.22),
        invertFilledArea: true,
        priceLineVisible: false,
        priceFormat: { type: "custom", formatter: (v: number) => pct(v, { digits: 1 }) },
      })
      const data = dedupe(points.map((p) => ({ time: toTs(p.t), value: p.dd_pct })))
      series.setData(data)
      chart.timeScale().fitContent()
      const byTime = new Map(data.map((d) => [d.time as number, d.value]))
      const handler = (param: MouseEventParams) => {
        const v = param.time ? byTime.get(param.time as number) : undefined
        if (v === undefined || !param.point) return setTip(null)
        setTip({ ...place(param, el.clientWidth), title: dateTime((param.time as number) * 1000), rows: [["Below peak", pct(v)]] })
      }
      chart.subscribeCrosshairMove(handler)
      return () => chart.unsubscribeCrosshairMove(handler)
    },
    [key],
    height,
  )
  if (points.length < 2) return <p className="text-muted-foreground flex items-center justify-center text-sm" style={{ height }}>No drawdown history yet.</p>
  return (
    <div className="relative" style={{ height }}>
      <div ref={ref} className="h-full w-full" />
      <Tooltip data={tip} />
    </div>
  )
}

export function DailyPnlChart({ days, height = 200 }: { days: { day: string; pnl: number; pnl_pct: number }[]; height?: number }) {
  const [tip, setTip] = useState<TooltipData>(null)
  const key = days.map((d) => `${d.day}:${d.pnl}`).join(",")
  const ref = useChart(
    (chart, theme, el) => {
      if (!days.length) return
      const series = chart.addSeries(HistogramSeries, { priceLineVisible: false, priceFormat: { type: "custom", formatter: (v: number) => usd(v, { whole: true }) } })
      const data = dedupe(days.map((d) => ({ time: toTs(Date.parse(`${d.day}T12:00:00Z`)), value: d.pnl, color: d.pnl >= 0 ? theme.up : theme.down })))
      series.setData(data)
      chart.timeScale().applyOptions({ timeVisible: false })
      chart.timeScale().fitContent()
      const byDay = new Map(days.map((d) => [toTs(Date.parse(`${d.day}T12:00:00Z`)) as number, d]))
      const handler = (param: MouseEventParams) => {
        const d = param.time ? byDay.get(param.time as number) : undefined
        if (!d || !param.point) return setTip(null)
        setTip({ ...place(param, el.clientWidth), title: d.day, rows: [["P&L", usd(d.pnl, { sign: true })], ["Return", pct(d.pnl_pct)]] })
      }
      chart.subscribeCrosshairMove(handler)
      return () => chart.unsubscribeCrosshairMove(handler)
    },
    [key],
    height,
  )
  if (!days.length) return <p className="text-muted-foreground flex items-center justify-center text-sm" style={{ height }}>No completed days yet (days close at 00:00 UTC).</p>
  return (
    <div className="relative" style={{ height }}>
      <div ref={ref} className="h-full w-full" />
      <Tooltip data={tip} />
    </div>
  )
}
