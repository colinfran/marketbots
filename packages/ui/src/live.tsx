"use client"

import { cn } from "cn"
import { ArrowDownRightIcon, ArrowUpRightIcon, BrainIcon, CircleDotIcon, RefreshCwIcon, ShieldCheckIcon, ShieldXIcon, WifiIcon } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import { Badge } from "./components/badge"
import { type FeedFilter, useKit } from "./kit"
import { ago, pct, titleCase, tone } from "./lib/format"
import { type AnyEvent, useStream, useStreamEvents } from "./stream"

/**
 * The live UI both dashboards share: the header's status pill, the activity feed, what the AI is
 * doing now, live prices and the stream badge. What each bot's events mean (labels, icons,
 * filters, the lines under an event, links) comes from its kit's event catalog.
 */

/** Re-renders every few seconds so "x seconds ago" labels stay honest. */
export const useNow = (ms = 5_000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

/** A brief swell with a fading ring in the gain color. */
const PULSE: Keyframe[] = [
  { transform: "scale(1)", boxShadow: "0 0 0 0 color-mix(in oklab, var(--gain) 45%, transparent)" },
  { transform: "scale(1.08)", boxShadow: "0 0 0 3px color-mix(in oklab, var(--gain) 25%, transparent)", offset: 0.35 },
  { transform: "scale(1)", boxShadow: "0 0 0 6px color-mix(in oklab, var(--gain) 0%, transparent)" },
]

/** Header pills: what the engine is doing, and whether the live stream is connected. */
export function StatusPill({ initial }: { initial: { online: boolean; status: string | null; cycleState: string | null } }) {
  const { Mark, events: catalog, pillStateClassName } = useKit()
  const s = useStream()
  // Events can arrive several times a second, so the pill pulses at most every 2s: a heartbeat, not a flicker.
  // Animated imperatively so the pulse doesn't re-render (and restart) the spinning icon.
  const pill = useRef<HTMLSpanElement>(null)
  const lastBeat = useRef(0)
  useStreamEvents(() => {
    const now = Date.now()
    if (now - lastBeat.current < 2_000 || matchMedia("(prefers-reduced-motion: reduce)").matches) return
    lastBeat.current = now
    pill.current?.animate(PULSE, { duration: 700, easing: "ease-out" })
  })
  const engineStatus = s.engine?.status ?? (initial.online ? initial.status : "offline")
  const cycle = s.engine?.cycle_state ?? initial.cycleState
  const live = s.status === "live"
  const toneClass =
    !initial.online && !s.engine ? "bg-loss/10 text-loss" : engineStatus === "halted" ? "bg-loss/10 text-loss" : engineStatus === "paused" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-foreground"
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium", toneClass)} title="Engine state">
        <Mark className="size-3.5" />
        {titleCase(engineStatus ?? "offline")}
        {cycle && cycle !== "idle" && engineStatus !== "offline" && (
          <span className={cn("text-muted-foreground font-normal", pillStateClassName)}>· {catalog.stateLabels[cycle] ?? titleCase(cycle)}</span>
        )}
      </span>
      <span
        ref={pill}
        className={cn("hidden items-center gap-1.5 rounded-md px-2 py-1 font-medium sm:inline-flex", live ? "bg-gain/10 text-gain" : "bg-muted text-muted-foreground")}
        title={live ? "Live stream connected" : `Live stream ${s.status}`}
      >
        <RefreshCwIcon className={cn("size-3.5", live && "motion-safe:animate-[spin_2s_linear_infinite]")} aria-hidden />
        {live ? "Live" : s.status === "unconfigured" ? "No stream" : titleCase(s.status)}
      </span>
    </div>
  )
}

/** Refreshes server-rendered data when the engine reports something that changes it. */
export function LiveRefresh() {
  const { refreshOn } = useKit().events
  const router = useRouter()
  const { gapCount, status } = useStream()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedule = () => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      router.refresh()
    }, 1_500)
  }
  useStreamEvents((e) => {
    if (refreshOn.has(e.type)) schedule()
  })
  useEffect(() => {
    if (gapCount) router.refresh()
  }, [gapCount, router])
  // Fallback when the stream isn't connected: refresh every minute while visible.
  useEffect(() => {
    if (status === "live") return
    const t = setInterval(() => document.visibilityState === "visible" && router.refresh(), 60_000)
    return () => clearInterval(t)
  }, [status, router])
  return null
}

/**
 * The news engine reaches the feed only when it matters: notable items, and
 * triggers that fired or queued. Source health and everything else stay on the Research page.
 */
const newsWorthy = (e: AnyEvent) => {
  const d = e.data as { notable?: boolean; status?: string }
  if (e.type === "wire.item") return d.notable === true
  if (e.type === "wire.trigger") return d.status === "fired" || d.status === "queued"
  return e.type !== "wire.source"
}

type Filter = "all" | FeedFilter
const FILTERS: Filter[] = ["all", "ai", "news", "trades", "system"]

/** The real-time activity timeline: research, AI decisions, risk checks, orders, fills, system events. */
export function ActivityFeed({ limit = 60, className, compact = false }: { limit?: number; className?: string; compact?: boolean }) {
  const { events: catalog } = useKit()
  const { events, status } = useStream()
  const now = useNow()
  const [filter, setFilter] = useState<Filter>("all")
  const shown = useMemo(
    () =>
      events
        .filter((e) => (e.level !== "debug" || catalog.feedDebug.has(e.type)) && !catalog.feedHidden.has(e.type) && newsWorthy(e))
        .filter((e) => filter === "all" || catalog.filters[filter](e))
        .slice(0, limit),
    [events, filter, limit, catalog],
  )
  const { time } = useKit().format
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {!compact && (
        <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Filter activity">
          {FILTERS.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn("rounded-md px-2 py-1 text-xs", filter === f ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {f === "ai" ? "AI" : titleCase(f)}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">{status === "unconfigured" ? "The live stream isn't configured (ENGINE_STREAM_URL)." : "No activity yet."}</p>
      ) : (
        <ol className="space-y-0.5 overflow-y-auto" aria-live="polite">
          {shown.map((e, i) => {
            const Icon = catalog.icons[e.type] ?? CircleDotIcon
            const extra = catalog.detail(e)
            const warn = e.level === "warn" || e.level === "error"
            return (
              <li key={e.seq ? e.seq : `${e.ts}-${i}`} className="hover:bg-muted/40 flex gap-2.5 rounded-md px-1.5 py-1.5">
                <Icon className={cn("mt-0.5 size-4 shrink-0", warn ? "text-loss" : "text-muted-foreground")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className={cn("text-sm leading-snug break-words", warn && "text-loss")}>{catalog.summary(e)}</p>
                    <time className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums" dateTime={e.ts} title={time(e.ts)}>
                      {ago(e.ts, now)}
                    </time>
                  </div>
                  {extra && !compact && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{extra}</p>}
                  {!compact && catalog.links(e)}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** What the AI is doing right now, with the latest steps of the running cycle (compact, for the overview). */
export function CurrentWork() {
  const { events: catalog } = useKit()
  const { events, engine } = useStream()
  const now = useNow(2_000)
  const lastStart = events.find((e) => e.type === "cycle.started")
  const newer = lastStart ? events.slice(0, events.indexOf(lastStart)) : []
  const active = !!lastStart && !newer.some((e) => (e.type === "cycle.completed" || e.type === "cycle.failed" || e.type === "cycle.skipped") && (!e.cycle_id || e.cycle_id === lastStart.cycle_id))
  const trail = active ? newer.filter((e) => catalog.work.events.has(e.type)).slice(0, 8) : []
  const state = engine?.cycle_state ?? "idle"
  const started = (lastStart?.data ?? {}) as { trigger?: string; phase?: string }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn("size-2 rounded-full", active ? "bg-up animate-pulse" : "bg-muted-foreground/40")} aria-hidden />
        <span className="font-medium">{active ? (catalog.stateLabels[state] ?? titleCase(state)) : "Idle"}</span>
        {active && lastStart && (
          <span className="text-muted-foreground text-xs">
            {started.phase ? `${titleCase(started.phase)} cycle · started` : "cycle started"} {ago(lastStart.ts, now)} · {String(started.trigger ?? "")}
          </span>
        )}
      </div>
      {trail.length > 0 && (
        <ul className="text-muted-foreground space-y-1 text-xs">
          {trail.map((e, i) => {
            const Icon =
              e.type === "risk.checked" ? ((e.data as { approved?: boolean }).approved ? ShieldCheckIcon : ShieldXIcon) : (catalog.icons[e.type] ?? (e.type === "research.progress" ? BrainIcon : CircleDotIcon))
            return (
              <li key={`${e.ts}-${i}`} className="flex items-center gap-1.5">
                <Icon className="size-3 shrink-0" aria-hidden />
                <span className="line-clamp-1">{catalog.work.text(e)}</span>
              </li>
            )
          })}
        </ul>
      )}
      <Link href="/live" className="text-muted-foreground hover:text-foreground inline-block text-xs underline underline-offset-2">
        Watch the full thinking process
      </Link>
    </div>
  )
}

/** A live price with its change, falling back to the server-rendered value. */
export function LivePrice({ symbol, initial, initialChange, className }: { symbol: string; initial: number | null; initialChange?: number | null; className?: string }) {
  const { price } = useKit().format
  const { tickers } = useStream()
  const t = tickers[symbol]
  const value = t?.last ?? initial
  const change = t?.change_pct ?? initialChange ?? null
  return (
    <span className={cn("inline-flex items-baseline gap-2 tabular-nums", className)}>
      <span>{price(value)}</span>
      {change !== null && (
        <span className={cn("inline-flex items-center text-xs", tone(change))}>
          {change > 0 ? <ArrowUpRightIcon className="size-3" aria-hidden /> : change < 0 ? <ArrowDownRightIcon className="size-3" aria-hidden /> : null}
          {pct(change)}
        </span>
      )}
    </span>
  )
}

export function StreamBadge() {
  const { status, scope } = useStream()
  return (
    <Badge variant="outline" className="gap-1 font-normal">
      {status === "live" ? <WifiIcon className="size-3" aria-hidden /> : <ShieldXIcon className="size-3" aria-hidden />}
      {status === "live" ? `Live${scope === "owner" ? " (owner)" : ""}` : titleCase(status)}
    </Badge>
  )
}
