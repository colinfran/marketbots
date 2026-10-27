"use client"

import type { EngineEvent, EventDataMap } from "@mb/crypto-core/events"
import type { BotKit } from "@mb/ui/kit"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  BotIcon,
  BrainIcon,
  GlobeIcon,
  NewspaperIcon,
  type LucideIcon,
  ScanSearchIcon,
  SearchIcon,
  ShieldCheckIcon,
  WalletIcon,
  ZapIcon,
} from "lucide-react"
import Link from "next/link"
import { BotMark } from "@/components/bot-mark"
import { dateTime, pct, price, symbolSlug, time, tone } from "@/lib/format"

/**
 * CryptoMarketBot's kit for the shared dashboard components (@mb/ui/kit): brand, formatting,
 * links, and the catalog of crypto's events that drives the live UI.
 */

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

const ICONS: Partial<Record<string, LucideIcon>> = {
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

/** The feed line: the pair links to its market page, ahead of the summary (which loses its own "BTC/USD:" prefix). */
const summary = (e: EngineEvent): React.ReactNode => (
  <>
    {e.instrument && e.type !== "research.query" ? (
      <Link href={`/markets/${symbolSlug(e.instrument)}`} className="font-mono font-semibold hover:underline">
        {e.instrument}
      </Link>
    ) : null}
    {e.instrument && e.type !== "research.query" ? " " : null}
    {e.instrument ? e.summary.replace(new RegExp(`^${e.instrument.replace("/", "\\/")}:?\\s*`), "") : e.summary}
  </>
)

const links = (e: EngineEvent): React.ReactNode =>
  e.cycle_id && (e.type === "cycle.completed" || e.type === "ai.decision.completed") ? (
    <Link href={`/research/${e.cycle_id}`} className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
      View cycle
    </Link>
  ) : null

export const kit: BotKit<EngineEvent> = {
  name: "CryptoMarketBot",
  Mark: BotMark,
  stream: {
    maxEvents: 300,
    mapTicker: (data) => {
      const d = data as EventDataMap["market.ticker"]
      return { symbol: d.symbol, bid: d.bid, ask: d.ask, last: d.last, change_pct: d.change_pct }
    },
  },
  format: { price, time, dateTime },
  symbolHref: (symbol) => `/markets/${symbolSlug(symbol)}`,
  sourceLabel: (source, domain) => domain ?? source,
  statusStyles: {},
  triggerLink: "cycle",
  events: {
    stateLabels: STATE_LABEL,
    icons: ICONS,
    filters: {
      ai: (e) => /^(research|ai|screen|cycle)\./.test(e.type) || e.type === "wire.dossier",
      news: (e) => e.type === "wire.item" || e.type === "wire.notable" || e.type === "wire.trigger",
      trades: (e) => /^(order|position|protection|risk)\./.test(e.type),
      system: (e) => /^(engine|venue|market|budget|command|alert|error|summary)/.test(e.type),
    },
    refreshOn: new Set(["order.filled", "position.opened", "position.closed", "position.updated", "cycle.completed", "cycle.skipped", "engine.status", "command.completed", "command.failed", "backtest.completed", "summary.periodic", "engine.reconciled"]),
    feedDebug: new Set(["research.query", "research.source", "research.progress"]),
    feedHidden: new Set(),
    summary,
    detail,
    links,
    work: {
      events: new Set(["screen.candidates", "research.query", "research.source", "research.progress", "ai.decision.proposed", "risk.checked"]),
      text: (e) => e.summary,
    },
  },
}
