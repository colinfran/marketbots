"use client"

import {
  AreaSeries,
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  LineStyle,
  LineType,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts"
import { useTheme } from "next-themes"
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Tabs, TabsList, TabsTrigger } from "./components/tabs"
import { alpha, atLeast, barIndexes, chartClock, count, crosshairLabel, dedupe, describe, spread, stepIndex, tickLabel, TICK_KINDS, widen } from "./lib/chart-data"
import { pct, usd } from "./lib/format"

/**
 * The dashboards' charts (TradingView Lightweight Charts), shared by both bots. Encoding rules:
 * - single-series charts (equity, drawdown, cumulative P&L) have no legend; the card title names the series;
 * - polarity (candles, daily P&L) uses the --up / --down tokens (the validated blue / red pair unless an app
 *   maps them to its own P&L colors), and P&L bars also encode sign by direction from the zero line, so
 *   color is never the only cue;
 * - trade markers are ink-colored ▲ buy / ▼ sell shapes, readable over either candle color and over a line;
 * - every chart has a crosshair tooltip, also reachable from the keyboard (focus the chart, then ← → Home End),
 *   and a text summary for screen readers.
 *
 * What differs per bot comes in as props: the data, the formatters, and the time zone the time axis
 * reads in (none = UTC with the library's own labels).
 */

type Theme = { text: string; muted: string; grid: string; up: string; down: string; series: string; ink: string; palette: string[] }

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
    // The categorical order (styles.css), for charts with more than one line.
    palette: [v("--series-1", "#2a78d6"), v("--series-2", "#eb6834"), v("--series-3", "#1baf7a")],
  }
}

export type TooltipRow = [label: string, value: ReactNode]
export type TooltipContent = { title: string; rows: TooltipRow[] }
type TooltipData = (TooltipContent & { x: number; y: number }) | null

function Tooltip({ data }: { data: TooltipData }) {
  if (!data) return null
  return (
    <div className="bg-popover pointer-events-none absolute z-10 grid min-w-40 gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-lg" style={{ left: data.x, top: data.y }}>
      <div className="font-medium">{data.title}</div>
      {data.rows.map(([label, value], i) => (
        <div key={`${i}:${label}`} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  )
}

/** Positions a tooltip near a point, kept inside the chart. */
const place = (point: { x: number; y: number }, width: number) => ({
  x: Math.min(Math.max(0, point.x + 14), Math.max(0, width - 180)),
  y: Math.max(0, point.y - 10),
})

/** What a chart kind hands back after adding its series. */
type Plot = {
  series: ISeriesApi<SeriesType>
  /** Each data point's chart time and value, in time order (the keyboard's stops). */
  stops: { time: number; value: number }[]
  /** The tooltip for a chart time, or null for none. */
  tip(time: number): TooltipContent | null
}

type Setup = {
  height: number
  /** The time zone the axis reads in; omitted: UTC with the library's own tick labels. */
  timeZone?: string
  /** Times of day on the axis and crosshair (false for one point per day). */
  intraday?: boolean
  /** One format for every price on the chart (axis, last value, crosshair), over the series' own. */
  priceFormatter?: (p: number) => string
  /** The widest a bar may get (px), so a few bars don't fill the whole chart. */
  maxBarSpacing?: number
}

type Build = (chart: IChartApi, theme: Theme, clock: (ms: number) => number) => Plot | null

/**
 * The chart's box: the canvas (an image to assistive tech, with a text summary) and its tooltip.
 * Creates the chart, keeps it sized and themed, rebuilds it when `deps` change, and tears it down.
 */
function Canvas({ build, deps, setup, label, summary }: { build: Build; deps: unknown[]; setup: Setup; label: string; summary: string }) {
  const { height, timeZone, intraday = true, priceFormatter, maxBarSpacing } = setup
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const live = useRef<{ chart: IChartApi; plot: Plot } | null>(null)
  const focus = useRef<number | null>(null)
  const [tip, setTip] = useState<TooltipData>(null)
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
      timeScale: {
        borderVisible: false,
        timeVisible: intraday,
        secondsVisible: false,
        ...(maxBarSpacing ? { maxBarSpacing } : {}),
        ...(timeZone ? { tickMarkFormatter: (time: Time, type: number) => tickLabel(time as number, TICK_KINDS[type] ?? "day") } : {}),
      },
      crosshair: { vertLine: { color: theme.muted, labelBackgroundColor: theme.text }, horzLine: { color: theme.muted, labelBackgroundColor: theme.text } },
      localization: {
        ...(priceFormatter ? { priceFormatter } : {}),
        ...(timeZone ? { timeFormatter: (time: Time) => crosshairLabel(time as number, intraday) } : {}),
      },
    })
    const plot = build(chart, theme, chartClock(timeZone))
    live.current = plot ? { chart, plot } : null
    focus.current = null
    const handler = (param: MouseEventParams) => {
      const content = plot && param.time !== undefined ? plot.tip(param.time as number) : null
      if (!content || !param.point) return setTip(null)
      setTip({ ...place(param.point, el.clientWidth), ...content })
    }
    if (plot) {
      chart.timeScale().fitContent()
      chart.subscribeCrosshairMove(handler)
    }
    return () => {
      if (plot) chart.unsubscribeCrosshairMove(handler)
      live.current = null
      chart.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme, height, timeZone, intraday, maxBarSpacing, ...deps])

  /** ← → Home End walk the crosshair and tooltip through the points. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = live.current
    const el = ref.current
    if (!cur || !el) return
    const i = stepIndex(e.key, focus.current, cur.plot.stops.length)
    if (i === null) return
    e.preventDefault()
    focus.current = i
    const stop = cur.plot.stops[i]
    const time = stop.time as UTCTimestamp
    cur.chart.setCrosshairPosition(stop.value, time, cur.plot.series)
    const x = cur.chart.timeScale().timeToCoordinate(time)
    const y = cur.plot.series.priceToCoordinate(stop.value)
    const content = cur.plot.tip(stop.time)
    setTip(content && x !== null && y !== null ? { ...place({ x, y }, el.clientWidth), ...content } : null)
  }
  const onBlur = () => {
    focus.current = null
    live.current?.chart.clearCrosshairPosition()
    setTip(null)
  }

  return (
    <div className="relative" style={{ height }}>
      <div
        ref={ref}
        role="img"
        aria-label={label}
        aria-describedby={id}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="focus-visible:ring-ring/50 h-full w-full rounded-sm outline-none focus-visible:ring-[3px]"
      />
      <Tooltip data={tip} />
      {/* Dates and money render on the server and again in the browser, whose Intl data can differ by a space. */}
      <p id={id} className="sr-only" suppressHydrationWarning>
        {summary}
      </p>
    </div>
  )
}

/** The message shown in a chart's place when there is nothing to draw. */
export function ChartEmpty({ height, children }: { height: number; children: ReactNode }) {
  return (
    <p className="text-muted-foreground flex items-center justify-center text-sm" style={{ height }}>
      {children}
    </p>
  )
}

export type ChartTabs = { value: string; options: { key: string; label: string }[]; onChange(value: string): void }

/** Range or interval tabs above a chart. */
export function ChartTabsList({ tabs }: { tabs: ChartTabs }) {
  return (
    <Tabs value={tabs.value} onValueChange={tabs.onChange}>
      <TabsList>
        {tabs.options.map((o) => (
          <TabsTrigger key={o.key} value={o.key}>
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

/** Merges extra values into a series' automatic price range, then keeps it at least `minSpan` of its midpoint tall. */
const fitting =
  (extra: () => number[], minSpan = 0) =>
  (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
    const info = original()
    const priceRange = atLeast(widen(info?.priceRange ?? null, extra()), minSpan)
    return priceRange ? { ...info, priceRange } : info
  }

// ─── Price ───────────────────────────────────────────────────────────────────

/** One bar. Candles need open/high/low; a line uses close. `t` is the bar's start (ms). */
export type PriceBar = { t: number; close: number; open?: number; high?: number; low?: number }
/** A trade at time `t` (ms) and its price, drawn on the bar whose window holds it. */
export type TradeMark = { t: number; side: "buy" | "sell"; price: number }
export type ChartLevel = { label: string; value: number }

/**
 * Price as candles (crypto) or a line of closes (stock), with the bot's trades as ▲ buy / ▼ sell
 * markers (above/below a candle; at the fill price on a line) and stop/target levels as dashed
 * lines. The app owns the data (fetching, ranges) and the tooltip's content.
 */
export function PriceChart<B extends PriceBar, M extends TradeMark>({
  label,
  kind,
  bars,
  error,
  empty,
  tabs,
  marks = [],
  levels = [],
  fitLevels = false,
  minSpan = 0,
  price,
  tooltip,
  height = 360,
  timeZone,
  intraday = true,
}: {
  /** What the chart shows, for assistive tech ("BTC/USD price"). */
  label: string
  kind: "candles" | "line"
  /** null while loading. */
  bars: B[] | null
  error?: string | null
  /** Shown instead of a chart with fewer than two bars; without it, the chart is drawn anyway. */
  empty?: string
  tabs?: ChartTabs
  marks?: M[]
  levels?: ChartLevel[]
  /** Pull the levels into the visible price range (otherwise they show only when the prices reach them). */
  fitLevels?: boolean
  /** The smallest visible price range, as a fraction of the price (0.004 = 0.4%). */
  minSpan?: number
  price(value: number): string
  /** The tooltip for a bar and the marks drawn on it. */
  tooltip(bar: B, marks: M[]): TooltipContent
  height?: number
  timeZone?: string
  /** Times of day on the axis (false for daily bars). */
  intraday?: boolean
}) {
  const rows = bars ?? []
  const markKey = JSON.stringify(marks.map((m) => [m.t, m.side, m.price]))
  const levelKey = JSON.stringify(levels)

  const build: Build = (chart, theme, clock) => {
    if (!rows.length) return null
    const keyed = dedupe(rows.map((bar) => ({ time: clock(bar.t), bar })))
    const index = barIndexes(
      keyed.map((k) => k.bar.t),
      marks.map((m) => m.t),
    )
    const marksAt = new Map<number, M[]>()
    marks.forEach((m, i) => {
      if (index[i] < 0) return
      const time = keyed[index[i]].time
      marksAt.set(time, [...(marksAt.get(time) ?? []), m])
    })
    const extra = () => [...(fitLevels ? levels.map((l) => l.value) : []), ...(kind === "line" ? marks.map((m) => m.price) : [])]
    let series: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">
    if (kind === "candles") {
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: theme.up,
        downColor: theme.down,
        wickUpColor: theme.up,
        wickDownColor: theme.down,
        borderVisible: false,
        ...(fitLevels || minSpan ? { autoscaleInfoProvider: fitting(extra, minSpan) } : {}),
      })
      candles.setData(keyed.map(({ time, bar }) => ({ time: time as UTCTimestamp, open: bar.open ?? bar.close, high: bar.high ?? bar.close, low: bar.low ?? bar.close, close: bar.close })))
      series = candles
    } else {
      const line = chart.addSeries(LineSeries, { color: theme.series, lineWidth: 2, priceFormat: { type: "custom", formatter: price }, autoscaleInfoProvider: fitting(extra, minSpan) })
      line.setData(keyed.map(({ time, bar }) => ({ time: time as UTCTimestamp, value: bar.close })))
      series = line
    }
    const markers = [...marksAt.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([time, here]) =>
        here.map((m): SeriesMarker<Time> => {
          const buy = m.side === "buy"
          const common = { time: time as UTCTimestamp, shape: buy ? "arrowUp" : "arrowDown", color: theme.ink, text: buy ? "B" : "S", size: 1 } as const
          return kind === "candles" ? { ...common, position: buy ? "belowBar" : "aboveBar" } : { ...common, position: buy ? "atPriceBottom" : "atPriceTop", price: m.price }
        }),
      )
    createSeriesMarkers(series, markers)
    for (const l of levels) {
      series.createPriceLine({ price: l.value, color: theme.muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: l.label })
    }
    const byTime = new Map(keyed.map((k) => [k.time, k.bar]))
    return {
      series,
      stops: keyed.map(({ time, bar }) => ({ time, value: bar.close })),
      tip: (time) => {
        const bar = byTime.get(time)
        return bar ? tooltip(bar, marksAt.get(time) ?? []) : null
      },
    }
  }

  const buys = marks.filter((m) => m.side === "buy").length
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {tabs ? <ChartTabsList tabs={tabs} /> : <span />}
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {kind === "candles" ? (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="bg-up inline-block size-2.5 rounded-sm" /> Up candle
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="bg-down inline-block size-2.5 rounded-sm" /> Down candle
              </span>
            </>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="bg-series-1 h-0.5 w-4 rounded" /> Price
            </span>
          )}
          {marks.length > 0 && <span>▲ buy · ▼ sell (paper fills)</span>}
          {levels.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="border-muted-foreground w-4 border-t border-dashed" /> Stop / target
            </span>
          )}
        </div>
      </div>
      {error ? (
        <Message height={height}>{error}</Message>
      ) : !bars ? (
        <div className="relative" style={{ height }}>
          <div className="bg-muted/40 h-full animate-pulse rounded-lg" />
        </div>
      ) : empty !== undefined && rows.length < 2 ? (
        <Message height={height}>{empty}</Message>
      ) : (
        <Canvas
          build={build}
          deps={[bars, markKey, levelKey, kind, fitLevels, minSpan]}
          setup={{ height, timeZone, intraday, priceFormatter: price }}
          label={label}
          summary={`${describe(
            rows.map((b) => ({ t: b.t, value: b.close })),
            (t) => tooltip(rows.find((b) => b.t === t)!, []).title,
            price,
          )}${marks.length ? ` ${count(buys, "buy")} and ${count(marks.length - buys, "sell")} marked.` : ""}`}
        />
      )}
    </div>
  )
}

/** A message in the chart's box (an error, or nothing to show for this range). */
function Message({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div className="relative" style={{ height }}>
      <p className="text-muted-foreground flex h-full items-center justify-center text-sm">{children}</p>
    </div>
  )
}

// ─── Equity ──────────────────────────────────────────────────────────────────

export type EquityPoint = { t: number; equity: number }

/** Account value over time as an area, with the starting balance as a dashed line. */
export function EquityChart({
  points,
  baseline,
  dateTime,
  empty,
  rows,
  tabs,
  fitBaseline = false,
  minSpan = 0,
  axisFormat,
  label = "Account equity",
  height = 260,
  timeZone,
}: {
  points: EquityPoint[]
  /** The starting balance. */
  baseline: number
  /** Tooltip titles. */
  dateTime(ms: number): string
  /** Shown instead of a chart with fewer than two points. */
  empty: string
  /** Tooltip rows (default: the equity and the change since the start). */
  rows?: (point: EquityPoint, first: EquityPoint) => TooltipRow[]
  tabs?: ChartTabs
  /** Pull the starting balance into the visible range (otherwise it shows only when equity reaches it). */
  fitBaseline?: boolean
  /** The smallest visible value range, as a fraction of the value (0.004 = 0.4%). */
  minSpan?: number
  /** Axis labels (default: whole dollars). */
  axisFormat?: (value: number) => string
  label?: string
  height?: number
  timeZone?: string
}) {
  const key = points.length ? `${points[0].t}-${points.at(-1)!.t}-${points.length}-${points.at(-1)!.equity}` : "empty"
  const build: Build = (chart, theme, clock) => {
    const series = chart.addSeries(AreaSeries, {
      lineColor: theme.series,
      lineWidth: 2,
      topColor: alpha(theme.series, 0.18),
      bottomColor: alpha(theme.series, 0),
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: { type: "custom", formatter: (v: number) => usd(v, { whole: true }) },
      ...(fitBaseline || minSpan ? { autoscaleInfoProvider: fitting(() => (fitBaseline ? [baseline] : []), minSpan) } : {}),
    })
    const data = dedupe(points.map((p) => ({ time: clock(p.t), value: p.equity, p })))
    series.setData(data.map(({ time, value }) => ({ time: time as UTCTimestamp, value })))
    series.createPriceLine({ price: baseline, color: theme.muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: "start" })
    const byTime = new Map(data.map((d) => [d.time, d.p]))
    const first = data[0].p
    return {
      series,
      stops: data.map(({ time, value }) => ({ time, value })),
      tip: (time) => {
        const p = byTime.get(time)
        if (!p) return null
        return {
          title: dateTime(p.t),
          rows: rows
            ? rows(p, first)
            : [
                ["Equity", usd(p.equity)],
                ["vs start", pct((p.equity / baseline - 1) * 100)],
              ],
        }
      },
    }
  }
  const body =
    points.length < 2 ? (
      <ChartEmpty height={height}>{empty}</ChartEmpty>
    ) : (
      <Canvas
        build={build}
        deps={[key, baseline, fitBaseline, minSpan]}
        setup={{ height, timeZone, priceFormatter: axisFormat }}
        label={label}
        summary={describe(
          points.map((p) => ({ t: p.t, value: p.equity })),
          dateTime,
          (v) => usd(v),
        )}
      />
    )
  if (!tabs) return body
  return (
    <div className="space-y-3">
      <ChartTabsList tabs={tabs} />
      {body}
    </div>
  )
}

// ─── Drawdown ────────────────────────────────────────────────────────────────

/** How far below its running peak the account was, as an inverted area. */
export function DrawdownChart({
  points,
  dateTime,
  empty,
  axisFormat,
  label = "Drawdown from peak",
  height = 180,
  timeZone,
}: {
  points: { t: number; dd_pct: number }[]
  dateTime(ms: number): string
  empty: string
  /** Axis labels (default: percent, one decimal). */
  axisFormat?: (value: number) => string
  label?: string
  height?: number
  timeZone?: string
}) {
  if (points.length < 2) return <ChartEmpty height={height}>{empty}</ChartEmpty>
  const key = `${points[0].t}-${points.at(-1)!.t}-${points.length}`
  const build: Build = (chart, theme, clock) => {
    const series = chart.addSeries(AreaSeries, {
      lineColor: theme.down,
      lineWidth: 2,
      topColor: alpha(theme.down, 0),
      bottomColor: alpha(theme.down, 0.22),
      invertFilledArea: true,
      priceLineVisible: false,
      priceFormat: { type: "custom", formatter: (v: number) => pct(v, { digits: 1 }) },
    })
    const data = dedupe(points.map((p) => ({ time: clock(p.t), value: p.dd_pct, t: p.t })))
    series.setData(data.map(({ time, value }) => ({ time: time as UTCTimestamp, value })))
    const byTime = new Map(data.map((d) => [d.time, d]))
    return {
      series,
      stops: data.map(({ time, value }) => ({ time, value })),
      tip: (time) => {
        const d = byTime.get(time)
        return d ? { title: dateTime(d.t), rows: [["Below peak", pct(d.value)]] } : null
      },
    }
  }
  return (
    <Canvas
      build={build}
      deps={[key]}
      setup={{ height, timeZone, priceFormatter: axisFormat }}
      label={label}
      summary={describe(
        points.map((p) => ({ t: p.t, value: p.dd_pct })),
        dateTime,
        (v) => pct(v),
      )}
    />
  )
}

// ─── Daily P&L ───────────────────────────────────────────────────────────────

export type PnlDay = { day: string; pnl: number; pnl_pct: number }

/** One bar per day ("2026-10-26"), up days blue above zero and down days red below it. */
export function PnlChart({
  days,
  empty,
  formatDay = (day) => day,
  axisFormat,
  maxBarSpacing,
  label = "Daily profit and loss",
  height = 200,
  timeZone,
}: {
  days: PnlDay[]
  empty: string
  /** Tooltip titles (default: the day as given). */
  formatDay?: (day: string) => string
  /** Axis labels (default: whole dollars). */
  axisFormat?: (value: number) => string
  /** The widest a day's slot may get (px); default: as wide as fits. */
  maxBarSpacing?: number
  label?: string
  height?: number
  timeZone?: string
}) {
  if (!days.length) return <ChartEmpty height={height}>{empty}</ChartEmpty>
  const key = days.map((d) => `${d.day}:${d.pnl}`).join(",")
  const build: Build = (chart, theme, clock) => {
    const series = chart.addSeries(HistogramSeries, { priceLineVisible: false, priceFormat: { type: "custom", formatter: (v: number) => usd(v, { whole: true }) } })
    // Noon UTC keeps each bar on its own date in any time zone the axis reads in.
    const data = dedupe(days.map((d) => ({ time: clock(Date.parse(`${d.day}T12:00:00Z`)), value: d.pnl, color: d.pnl >= 0 ? theme.up : theme.down, d })))
    series.setData(data.map(({ time, value, color }) => ({ time: time as UTCTimestamp, value, color })))
    const byTime = new Map(data.map((x) => [x.time, x.d]))
    return {
      series,
      stops: data.map(({ time, value }) => ({ time, value })),
      tip: (time) => {
        const d = byTime.get(time)
        return d
          ? {
              title: formatDay(d.day),
              rows: [
                ["P&L", usd(d.pnl, { sign: true })],
                ["Return", pct(d.pnl_pct)],
              ],
            }
          : null
      },
    }
  }
  const up = days.filter((d) => d.pnl > 0).length
  const down = days.filter((d) => d.pnl < 0).length
  const total = days.reduce((s, d) => s + d.pnl, 0)
  return (
    <Canvas
      build={build}
      deps={[key]}
      setup={{ height, timeZone, intraday: false, priceFormatter: axisFormat, maxBarSpacing }}
      label={label}
      summary={`${days.length > 1 ? `${formatDay(days[0].day)} to ${formatDay(days.at(-1)!.day)}` : formatDay(days[0].day)}: ${count(days.length, "day")}, ${up} up and ${down} down, ${usd(total, { sign: true })} in total.`}
    />
  )
}

// ─── Cumulative realized P&L ─────────────────────────────────────────────────

/** A running total: the first point is the $0 start, then one point per closing trade. */
export type CumulativePoint = { t: number; symbol: string; pnl: number; cum: number }

/** Realized P&L added up trade by trade, as steps from $0 (the zero line always in view). */
export function CumulativePnlChart({
  points,
  dateTime,
  empty,
  axisFormat,
  label = "Realized profit and loss over time",
  height = 224,
  timeZone,
}: {
  points: CumulativePoint[]
  dateTime(ms: number): string
  empty: string
  /** Axis labels (default: whole dollars). */
  axisFormat?: (value: number) => string
  label?: string
  height?: number
  timeZone?: string
}) {
  if (points.length < 2) return <ChartEmpty height={height}>{empty}</ChartEmpty>
  const key = points.map((p) => `${p.t}:${p.cum}`).join(",")
  const build: Build = (chart, theme, clock) => {
    const series = chart.addSeries(LineSeries, {
      color: theme.series,
      lineWidth: 2,
      lineType: LineType.WithSteps,
      pointMarkersVisible: points.length <= 60,
      pointMarkersRadius: 2.5,
      priceLineVisible: false,
      priceFormat: { type: "custom", formatter: (v: number) => usd(v, { whole: true }) },
      autoscaleInfoProvider: fitting(() => [0]),
    })
    // One point per trade, even when several close in the same second.
    const times = spread(points.map((p) => clock(p.t)))
    series.setData(points.map((p, i) => ({ time: times[i] as UTCTimestamp, value: p.cum })))
    series.createPriceLine({ price: 0, color: alpha(theme.muted, 0.6), lineStyle: LineStyle.Solid, lineWidth: 1, axisLabelVisible: false })
    const byTime = new Map(points.map((p, i) => [times[i], p]))
    return {
      series,
      stops: points.map((p, i) => ({ time: times[i], value: p.cum })),
      tip: (time) => {
        const p = byTime.get(time)
        if (!p?.symbol) return null
        return {
          title: `${p.symbol} · ${dateTime(p.t)}`,
          rows: [
            ["This trade", usd(p.pnl, { sign: true })],
            ["Running total", usd(p.cum, { sign: true })],
          ],
        }
      },
    }
  }
  return (
    <Canvas
      build={build}
      deps={[key]}
      setup={{ height, timeZone, intraday: false, priceFormatter: axisFormat }}
      label={label}
      summary={`${describe(
        points.map((p) => ({ t: p.t, value: p.cum })),
        dateTime,
        (v) => usd(v, { sign: true }),
      )} ${count(points.length - 1, "closing trade")}.`}
    />
  )
}

// ─── Lines ───────────────────────────────────────────────────────────────────

/** One line: its name, its categorical slot (1–3, fixed per entity across a page), and a value per time (null: no reading). */
export type LineSpec = { key: string; label: string; slot: 1 | 2 | 3; values: (number | null)[] }

/** Tailwind classes for each slot's legend swatch. */
const SWATCH = { 1: "bg-series-1", 2: "bg-series-2", 3: "bg-series-3" } as const

/**
 * Up to three measures in one unit over time (the CPU's and each GPU's temperature, say), a line
 * each. A missing value, or a stretch longer than `gapMs` without points, breaks the line rather
 * than joining across it. Each line's name is on its axis label and in the legend (above it, for
 * two or more lines); a single line needs neither, the card names it. `range` pins the value axis
 * (0–100 for a percentage).
 */
export function LinesChart({
  times,
  lines,
  format,
  dateTime,
  empty,
  label,
  height = 180,
  timeZone,
  range,
  gapMs,
}: {
  times: number[]
  lines: LineSpec[]
  /** Values on the axis, the tooltip and the summary. */
  format(value: number): string
  dateTime(ms: number): string
  empty: string
  label: string
  height?: number
  timeZone?: string
  range?: { min: number; max: number }
  gapMs?: number
}) {
  const drawn = lines.filter((l) => l.values.some((v) => v !== null))
  if (times.length < 2 || !drawn.length) return <ChartEmpty height={height}>{empty}</ChartEmpty>
  const key = `${times[0]}-${times.at(-1)}-${times.length}-${drawn.map((l) => `${l.key}:${l.values.at(-1)}`).join(",")}`
  const build: Build = (chart, theme, clock) => {
    const chartTimes = times.map(clock)
    const all = drawn.map((line) => {
      const series = chart.addSeries(LineSeries, {
        color: theme.palette[line.slot - 1],
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        ...(drawn.length > 1 ? { title: line.label } : {}),
        priceFormat: { type: "custom", formatter: format },
        ...(range ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: range.min, maxValue: range.max } }) } : {}),
      })
      const data: ({ time: UTCTimestamp; value: number } | { time: UTCTimestamp })[] = []
      times.forEach((t, i) => {
        // A whitespace point inside a long gap breaks the line there.
        if (gapMs && i > 0 && t - times[i - 1] > gapMs) data.push({ time: (chartTimes[i - 1] + 1) as UTCTimestamp })
        const v = line.values[i]
        data.push(v === null ? { time: chartTimes[i] as UTCTimestamp } : { time: chartTimes[i] as UTCTimestamp, value: v })
      })
      series.setData(dedupe(data))
      // A pinned range keeps only a sliver of margin, so 0–100% doesn't label its top 120%.
      if (range) series.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } })
      return { line, series }
    })
    const byTime = new Map(chartTimes.map((time, i) => [time, i]))
    const first = all[0]
    return {
      series: first.series,
      stops: chartTimes.flatMap((time, i) => (first.line.values[i] === null ? [] : [{ time, value: first.line.values[i]! }])),
      tip: (time) => {
        const i = byTime.get(time)
        if (i === undefined) return null
        return { title: dateTime(times[i]), rows: all.map(({ line }) => [line.label, line.values[i] === null ? "—" : format(line.values[i]!)] as TooltipRow) }
      },
    }
  }
  return (
    <div className="space-y-2">
      {drawn.length > 1 && (
        <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {drawn.map((l) => (
            <li key={l.key} className="flex items-center gap-1.5">
              <span className={`${SWATCH[l.slot]} inline-block h-0.5 w-3 rounded-full`} aria-hidden />
              {l.label}
            </li>
          ))}
        </ul>
      )}
      <Canvas
        build={build}
        deps={[key, range?.min, range?.max, gapMs]}
        setup={{ height, timeZone, priceFormatter: format }}
        label={label}
        summary={drawn
          .map(
            (l) =>
              `${l.label}: ${describe(
                times.flatMap((t, i) => (l.values[i] === null ? [] : [{ t, value: l.values[i]! }])),
                dateTime,
                format,
              )}`,
          )
          .join(" ")}
      />
    </div>
  )
}
