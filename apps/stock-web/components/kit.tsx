"use client"

import type { EngineEvent, EventDataMap } from "@mb/stock-core/events"
import { formatDateTime } from "@mb/stock-core/time"
import type { BotKit } from "@mb/ui/kit"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  BotIcon,
  BrainIcon,
  DatabaseIcon,
  GlobeIcon,
  LandmarkIcon,
  LayersIcon,
  type LucideIcon,
  NewspaperIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  SparklesIcon,
  WalletIcon,
  ZapIcon,
} from "lucide-react"
import Link from "next/link"
import { STATUS_STYLES } from "@/components/bits"
import { pct, price, time, tone, wireSource } from "@/lib/format"

/**
 * StockMarketBot's kit for the shared dashboard components (@mb/ui/kit): brand, formatting,
 * links, and the catalog of stock's events that drives the live UI.
 */

export const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  gathering_data: "Gathering data",
  loading_options: "Loading option chains",
  researching: "Researching",
  deciding: "AI deciding",
  executing: "Executing",
  protecting: "Checking stops",
  reviewing: "Reviewing the day",
}

const ICONS: Partial<Record<string, LucideIcon>> = {
  "context.built": DatabaseIcon,
  "options.chains": LayersIcon,
  "research.started": SearchIcon,
  "research.query": SearchIcon,
  "research.source": GlobeIcon,
  "research.progress": BrainIcon,
  "research.completed": SearchIcon,
  "ai.reasoning": SparklesIcon,
  "ai.decision.started": BrainIcon,
  "ai.decision.progress": BrainIcon,
  "ai.decision.proposed": BrainIcon,
  "ai.decision.completed": BrainIcon,
  "ai.decision.failed": AlertTriangleIcon,
  "ai.report": SparklesIcon,
  "decision.result": ActivityIcon,
  "order.submitted": WalletIcon,
  "order.filled": WalletIcon,
  "order.rejected": AlertTriangleIcon,
  "order.canceled": WalletIcon,
  "position.opened": ArrowUpRightIcon,
  "position.closed": ArrowDownRightIcon,
  "protection.placed": ShieldCheckIcon,
  "protection.triggered": ShieldXIcon,
  alert: AlertTriangleIcon,
  error: AlertTriangleIcon,
  "cycle.started": ActivityIcon,
  "cycle.step": ActivityIcon,
  "cycle.completed": ActivityIcon,
  "cycle.failed": AlertTriangleIcon,
  "engine.status": BotIcon,
  "wire.item": NewspaperIcon,
  "wire.notable": NewspaperIcon,
  "wire.trigger": ZapIcon,
  "wire.dossier": NewspaperIcon,
  "core.review.started": LandmarkIcon,
  "core.review.completed": LandmarkIcon,
}

const NOTABLE_WHY: Record<string, string> = { triggered: "it started a review", held: "it names a holding", focus: "it's on the radar", market: "market-wide", cited: "cited by the AI" }

/** Extra line under an event: the decision rationale, risk reasons, a source link, the memo as it's written. */
const detail = (e: EngineEvent): React.ReactNode => {
  const d = e.data as Record<string, unknown>
  if (e.type === "ai.decision.proposed") return [d.detail, d.rationale].filter(Boolean).join(" · ")
  if (e.type === "risk.checked" && !d.approved) return (d.reasons as string[] | undefined)?.join(" · ")
  if (e.type === "research.source") {
    return (
      <a href={String(d.url)} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-foreground underline underline-offset-2">
        {String(d.domain || d.url)}
      </a>
    )
  }
  if (e.type === "research.progress" || e.type === "ai.reasoning") return `…${String(d.excerpt ?? "")}`
  if (e.type === "ai.report") return String(d.summary ?? "")
  if (e.type === "decision.result" && d.reason) return String(d.reason)
  if (e.type === "wire.item" && typeof d.url === "string") {
    return (
      <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-foreground underline underline-offset-2">
        {wireSource(String(d.source ?? "source"))} · severity {String(d.severity)}
      </a>
    )
  }
  if (e.type === "core.review.completed") return String(d.summary ?? d.error ?? "")
  if (e.type === "wire.notable") return `Now notable: ${NOTABLE_WHY[String(d.reason)] ?? String(d.reason)} · severity ${String(d.severity)}`
  if (e.type === "wire.trigger") return `${String(d.action ?? "").replace(/_/g, " ")}: ${String(d.reason ?? "")}`
  if (e.type === "position.closed" && typeof d.realized_pnl_usd === "number") {
    return (
      <span className={tone(d.realized_pnl_usd)}>
        {d.realized_pnl_usd >= 0 ? "+" : "−"}${Math.abs(d.realized_pnl_usd).toFixed(2)} realized{typeof d.return_pct === "number" ? ` (${pct(d.return_pct)})` : ""}
      </span>
    )
  }
  return null
}

/** Under an event: its symbol and, for a finished cycle or core review, its report. */
const links = (e: EngineEvent): React.ReactNode => {
  const reportId = e.type === "cycle.completed" ? String((e.data as { report_id?: string }).report_id ?? "") : e.type === "core.review.completed" ? String((e.data as { review_id?: string }).review_id ?? "") : ""
  if (!e.instrument && !reportId) return null
  return (
    <p className="mt-0.5 flex gap-3 text-xs">
      {e.instrument && (
        <Link href={`/markets/${encodeURIComponent(e.instrument)}`} className="text-muted-foreground hover:text-foreground font-mono underline underline-offset-2">
          {e.instrument}
        </Link>
      )}
      {reportId && (
        <Link href={`/research/${reportId}`} className="text-muted-foreground hover:text-foreground underline underline-offset-2">
          View report
        </Link>
      )}
    </p>
  )
}

/** The memo and reasoning lines show their latest words. */
const workText = (e: EngineEvent) => (e.type === "research.progress" || e.type === "ai.reasoning" ? `${e.summary}: …${String((e.data as { excerpt?: string }).excerpt ?? "").slice(-120)}` : e.summary)

function StockMark({ className }: { className?: string }) {
  return <BotIcon className={className} aria-hidden />
}

export const kit: BotKit<EngineEvent> = {
  name: "StockMarketBot",
  Mark: StockMark,
  stream: {
    maxEvents: 500,
    mapTicker: (data) => {
      const d = data as EventDataMap["market.ticker"]
      return { symbol: d.symbol, bid: d.bid, ask: d.ask, last: d.price, change_pct: d.change_pct }
    },
  },
  format: { price, time, dateTime: formatDateTime },
  symbolHref: (symbol) => `/markets/${encodeURIComponent(symbol)}`,
  sourceLabel: wireSource,
  statusStyles: STATUS_STYLES,
  triggerLink: "report",
  // The header keeps the cycle state off phone widths.
  pillStateClassName: "hidden md:inline",
  events: {
    stateLabels: STATE_LABEL,
    icons: ICONS,
    filters: {
      ai: (e) => /^(research|ai|cycle|context|options|decision|core)\b/.test(e.type) || e.type === "wire.dossier",
      news: (e) => e.type === "wire.item" || e.type === "wire.notable" || e.type === "wire.trigger",
      trades: (e) => /^(order|position|protection|risk|decision)\./.test(e.type),
      system: (e) => /^(engine|broker|market|budget|command|alert|error|summary|daily)/.test(e.type),
    },
    refreshOn: new Set([
      "order.filled",
      "position.opened",
      "position.closed",
      "decision.result",
      "cycle.completed",
      "cycle.failed",
      "cycle.skipped",
      "core.review.completed",
      "engine.status",
      "command.completed",
      "command.failed",
      "summary.periodic",
      "daily.stats",
      "market.session",
    ]),
    // Thinking-trail events that are worth showing even though they're logged at debug level.
    feedDebug: new Set(["research.query", "research.source", "research.progress", "ai.reasoning", "ai.decision.progress"]),
    feedHidden: new Set(["ai.decision.progress", "cycle.state"]),
    summary: (e) => e.summary,
    detail,
    links,
    work: {
      events: new Set(["research.query", "research.source", "research.progress", "ai.reasoning", "ai.decision.progress", "ai.report", "ai.decision.proposed", "risk.checked", "context.built", "options.chains", "wire.dossier"]),
      text: workText,
    },
  },
}
