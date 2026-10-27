"use client"

import type { EngineEvent } from "@mb/crypto-core/events"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  BotIcon,
  BrainIcon,
  CircleDotIcon,
  GlobeIcon,
  NewspaperIcon,
  type LucideIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  WalletIcon,
  WifiIcon,
  ZapIcon,
} from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import { BotMark } from "@/components/bot-mark"
import { Badge } from "@/components/ui/badge"
import { ago, price, pct, symbolSlug, time, titleCase, tone } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useStream, useStreamEvents } from "./stream"

/** Re-renders every few seconds so "x seconds ago" labels stay honest. */
export const useNow = (ms = 5_000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  waiting_for_data: "Waiting for data",
  screening: "Screening",
  researching: "Researching",
  evaluating: "AI evaluating",
  risk_check: "Risk check",
  placing_order: "Placing order",
  position_monitoring: "Monitoring",
}

/** A brief swell with a fading ring in the gain color. */
const PULSE: Keyframe[] = [
  { transform: "scale(1)", boxShadow: "0 0 0 0 color-mix(in oklab, var(--gain) 45%, transparent)" },
  { transform: "scale(1.08)", boxShadow: "0 0 0 3px color-mix(in oklab, var(--gain) 25%, transparent)", offset: 0.35 },
  { transform: "scale(1)", boxShadow: "0 0 0 6px color-mix(in oklab, var(--gain) 0%, transparent)" },
]

/** Header pills: what the engine is doing, and whether the live stream is connected. */
export function StatusPill({ initial }: { initial: { online: boolean; status: string | null; cycleState: string | null } }) {
  const s = useStream()
  // Tickers arrive several times a second, so the pill pulses at most every 2s: a heartbeat, not a flicker.
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
  const tone = !initial.online && !s.engine ? "bg-loss/10 text-loss" : engineStatus === "halted" ? "bg-loss/10 text-loss" : engineStatus === "paused" ? "bg-amber-500/15 text-amber-700 dark:text-amber-300" : "bg-muted text-foreground"
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-medium", tone)} title="Engine state">
        <BotMark className="size-3.5" />
        {titleCase(engineStatus ?? "offline")}
        {cycle && cycle !== "idle" && engineStatus !== "offline" && <span className="text-muted-foreground font-normal">· {STATE_LABEL[cycle] ?? titleCase(cycle)}</span>}
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
const REFRESH_ON = new Set(["order.filled", "position.opened", "position.closed", "position.updated", "cycle.completed", "cycle.skipped", "engine.status", "command.completed", "command.failed", "backtest.completed", "summary.periodic", "engine.reconciled"])

export function LiveRefresh() {
  const router = useRouter()
  const { gapCount } = useStream()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const schedule = () => {
    if (timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      router.refresh()
    }, 1_500)
  }
  useStreamEvents((e) => {
    if (REFRESH_ON.has(e.type)) schedule()
  })
  useEffect(() => {
    if (gapCount) router.refresh()
  }, [gapCount, router])
  // Fallback when the stream isn't connected: refresh every minute while visible.
  const { status } = useStream()
  useEffect(() => {
    if (status === "live") return
    const t = setInterval(() => document.visibilityState === "visible" && router.refresh(), 60_000)
    return () => clearInterval(t)
  }, [status, router])
  return null
}

export const ICONS: Partial<Record<string, LucideIcon>> = {
  "screen.candidates": ScanSearchIcon,
  "research.started": SearchIcon,
  "research.query": SearchIcon,
  "research.source": GlobeIcon,
  "research.completed": SearchIcon,
  "ai.decision.started": BrainIcon,
  "ai.decision.proposed": BrainIcon,
  "ai.decision.completed": BrainIcon,
  "ai.decision.failed": AlertTriangleIcon,
  "order.submitted": WalletIcon,
  "order.filled": WalletIcon,
  "order.rejected": AlertTriangleIcon,
  "order.canceled": WalletIcon,
  "position.opened": ArrowUpRightIcon,
  "position.closed": ArrowDownRightIcon,
  "protection.triggered": ShieldCheckIcon,
  "budget.exhausted": AlertTriangleIcon,
  alert: AlertTriangleIcon,
  error: AlertTriangleIcon,
  "cycle.started": ActivityIcon,
  "cycle.completed": ActivityIcon,
  "cycle.failed": AlertTriangleIcon,
  "engine.status": BotIcon,
  "wire.item": NewspaperIcon,
  "wire.notable": NewspaperIcon,
  "wire.trigger": ZapIcon,
  "wire.dossier": NewspaperIcon,
}

type Filter = "all" | "ai" | "news" | "trades" | "system"
const FILTERS: Record<Filter, (e: EngineEvent) => boolean> = {
  all: () => true,
  ai: (e) => /^(research|ai|screen|cycle)\./.test(e.type) || e.type === "wire.dossier",
  news: (e) => e.type === "wire.item" || e.type === "wire.notable" || e.type === "wire.trigger",
  trades: (e) => /^(order|position|protection|risk)\./.test(e.type),
  system: (e) => /^(engine|venue|market|budget|command|alert|error|summary)/.test(e.type),
}

/**
 * The news engine reaches the feed only when it matters (MASTER_PLAN §3.12): notable items, and
 * triggers that fired or queued. Source health and everything else stay on the Research page.
 */
const newsWorthy = (e: EngineEvent) => {
  const d = e.data as { notable?: boolean; status?: string }
  if (e.type === "wire.item") return d.notable === true
  if (e.type === "wire.trigger") return d.status === "fired" || d.status === "queued"
  return e.type !== "wire.source"
}

/** Extra line under an event: the decision thesis, risk reasons, a source link. */
const detail = (e: EngineEvent): React.ReactNode => {
  const d = e.data as Record<string, unknown>
  if (e.type === "ai.decision.proposed") return String(d.thesis ?? "")
  if (e.type === "risk.checked" && !d.approved) return (d.reasons as string[] | undefined)?.join(" · ")
  if (e.type === "research.source") {
    return (
      <a href={String(d.url)} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-foreground underline underline-offset-2">
        {String(d.domain || d.url)}
      </a>
    )
  }
  if (e.type === "research.progress") return String(d.excerpt ?? "")
  if ((e.type === "wire.item" || e.type === "wire.notable") && typeof d.url === "string") {
    return (
      <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-foreground underline underline-offset-2">
        {String(d.source ?? "source")} · severity {String(d.severity)}
      </a>
    )
  }
  if (e.type === "wire.trigger") return `${String(d.action ?? "").replace(/_/g, " ")}: ${String(d.reason ?? "")}`
  if (e.type === "cycle.completed") return String(d.summary ?? "")
  if (e.type === "position.closed" && typeof d.realized_pnl_usd === "number") {
    return <span className={tone(d.realized_pnl_usd)}>{d.realized_pnl_usd >= 0 ? "+" : "−"}${Math.abs(d.realized_pnl_usd).toFixed(2)} realized{typeof d.return_pct === "number" ? ` (${pct(d.return_pct)})` : ""}</span>
  }
  return null
}

/** The real-time activity timeline: research, AI decisions, risk checks, orders, fills, system events. */
export function ActivityFeed({ limit = 60, className, compact = false }: { limit?: number; className?: string; compact?: boolean }) {
  const { events, status } = useStream()
  const now = useNow()
  const [filter, setFilter] = useState<Filter>("all")
  const shown = useMemo(
    () => events.filter((e) => (e.level !== "debug" || e.type === "research.query" || e.type === "research.source" || e.type === "research.progress") && newsWorthy(e)).filter(FILTERS[filter]).slice(0, limit),
    [events, filter, limit],
  )
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {!compact && (
        <div className="mb-2 flex flex-wrap gap-1" role="tablist" aria-label="Filter activity">
          {(Object.keys(FILTERS) as Filter[]).map((f) => (
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
        <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
          {status === "unconfigured" ? "The live stream isn't configured (ENGINE_STREAM_URL)." : "No activity yet."}
        </p>
      ) : (
        <ol className="space-y-0.5 overflow-y-auto" aria-live="polite">
          {shown.map((e, i) => {
            const Icon = ICONS[e.type] ?? CircleDotIcon
            const extra = detail(e)
            const warn = e.level === "warn" || e.level === "error"
            return (
              <li key={e.seq ? e.seq : `${e.ts}-${i}`} className="hover:bg-muted/40 flex gap-2.5 rounded-md px-1.5 py-1.5">
                <Icon className={cn("mt-0.5 size-4 shrink-0", warn ? "text-loss" : "text-muted-foreground")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className={cn("text-sm leading-snug", warn && "text-loss")}>
                      {e.instrument && e.type !== "research.query" ? (
                        <Link href={`/markets/${symbolSlug(e.instrument)}`} className="font-mono font-semibold hover:underline">
                          {e.instrument}
                        </Link>
                      ) : null}
                      {e.instrument && e.type !== "research.query" ? " " : null}
                      {e.instrument ? e.summary.replace(new RegExp(`^${e.instrument.replace("/", "\\/")}:?\\s*`), "") : e.summary}
                    </p>
                    <time className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums" dateTime={e.ts} title={time(e.ts)}>
                      {ago(e.ts, now)}
                    </time>
                  </div>
                  {extra && !compact && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{extra}</p>}
                  {e.cycle_id && !compact && (e.type === "cycle.completed" || e.type === "ai.decision.completed") && (
                    <Link href={`/research/${e.cycle_id}`} className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
                      View cycle
                    </Link>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** What the AI is doing right now, with the live research trail (queries and sources) of the current cycle. */
export function CurrentWork() {
  const { events, engine } = useStream()
  const now = useNow(2_000)
  const lastStart = events.find((e) => e.type === "cycle.started")
  const active =
    lastStart && !events.slice(0, events.indexOf(lastStart)).some((e) => (e.type === "cycle.completed" || e.type === "cycle.skipped" || e.type === "cycle.failed") && (e.cycle_id === lastStart.cycle_id || !e.cycle_id))
  const trail = active
    ? events
        .slice(0, events.indexOf(lastStart))
        .filter((e) => e.type === "screen.candidates" || e.type === "research.query" || e.type === "research.source" || e.type === "research.progress" || e.type === "ai.decision.proposed" || e.type === "risk.checked")
        .slice(0, 8)
    : []
  const state = engine?.cycle_state ?? "idle"
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className={cn("size-2 rounded-full", active ? "bg-up animate-pulse" : "bg-muted-foreground/40")} aria-hidden />
        <span className="font-medium">{active ? STATE_LABEL[state] ?? titleCase(state) : "Idle"}</span>
        {active && lastStart && <span className="text-muted-foreground text-xs">cycle started {ago(lastStart.ts, now)} · {String((lastStart.data as { trigger?: string }).trigger ?? "")}</span>}
      </div>
      {trail.length > 0 && (
        <ul className="text-muted-foreground space-y-1 text-xs">
          {trail.map((e, i) => {
            const Icon =
              e.type === "risk.checked" ? ((e.data as { approved?: boolean }).approved ? ShieldCheckIcon : ShieldXIcon) : (ICONS[e.type] ?? (e.type === "research.progress" ? BrainIcon : CircleDotIcon))
            return (
              <li key={`${e.ts}-${i}`} className="flex items-center gap-1.5">
                <Icon className="size-3 shrink-0" aria-hidden />
                <span className="line-clamp-1">{e.summary}</span>
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

/** A live last price with its 24h change, falling back to the server-rendered value. */
export function LivePrice({ symbol, initial, initialChange, className }: { symbol: string; initial: number | null; initialChange?: number | null; className?: string }) {
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
