"use client"

import type { EngineEvent, EventDataMap } from "@mb/stock-core/events"
import { formatDateTime } from "@mb/stock-core/time"
import { AGENT_ICONS, agentDetail, agentLinks, isAgentEvent } from "@mb/ui/agent-events"
import type { BotKit } from "@mb/ui/kit"
import { ActivityIcon, AlertTriangleIcon, ArrowDownRightIcon, ArrowUpRightIcon, BotIcon, BrainIcon, type LucideIcon, NewspaperIcon, ShieldCheckIcon, ShieldXIcon, WalletIcon, ZapIcon } from "lucide-react"
import Link from "next/link"
import { STATUS_STYLES } from "@/components/bits"
import { pct, price, time, tone, wireSource } from "@/lib/format"

/**
 * StockMarketBot's kit for the shared dashboard components (@mb/ui/kit): brand, formatting,
 * links, and the catalog of stock's events that drives the live UI.
 */

/** What the execution path is doing while the agent's decisions go through it. */
export const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  executing: "Executing",
  protecting: "Checking stops",
}

const ICONS: Partial<Record<string, LucideIcon>> = {
  "ai.decision.proposed": BrainIcon,
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
  "engine.status": BotIcon,
  "wire.item": NewspaperIcon,
  "wire.notable": NewspaperIcon,
  "wire.trigger": ZapIcon,
  ...AGENT_ICONS,
}

const NOTABLE_WHY: Record<string, string> = { triggered: "it woke the agent", held: "it names a holding", focus: "the agent is watching it", market: "market-wide", cited: "cited by the AI" }

/** Extra line under an event: the agent's, the decision rationale, risk reasons, a news link, a sale's P&L. */
const detail = (e: EngineEvent): React.ReactNode => {
  if (isAgentEvent(e)) return agentDetail(e)
  const d = e.data as Record<string, unknown>
  if (e.type === "ai.decision.proposed") return [d.detail, d.rationale].filter(Boolean).join(" · ")
  if (e.type === "risk.checked" && !d.approved) return (d.reasons as string[] | undefined)?.join(" · ")
  if (e.type === "decision.result" && d.reason) return String(d.reason)
  if (e.type === "wire.item" && typeof d.url === "string") {
    return (
      <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-foreground underline underline-offset-2">
        {wireSource(String(d.source ?? "source"))} · severity {String(d.severity)}
      </a>
    )
  }
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

/** Under an event: its episode (the agent's) or its symbol. */
const links = (e: EngineEvent): React.ReactNode => {
  if (isAgentEvent(e)) return agentLinks(e)
  if (!e.instrument) return null
  return (
    <p className="mt-0.5 flex gap-3 text-xs">
      <Link href={`/markets/${encodeURIComponent(e.instrument)}`} className="text-muted-foreground hover:text-foreground font-mono underline underline-offset-2">
        {e.instrument}
      </Link>
    </p>
  )
}

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
  // The header keeps the engine's state off phone widths.
  pillStateClassName: "hidden md:inline",
  events: {
    stateLabels: STATE_LABEL,
    icons: ICONS,
    filters: {
      ai: (e) => isAgentEvent(e) || /^(ai|decision)\./.test(e.type),
      news: (e) => e.type === "wire.item" || e.type === "wire.notable" || e.type === "wire.trigger",
      trades: (e) => /^(order|position|protection|risk|decision)\./.test(e.type),
      system: (e) => /^(engine|broker|market|command|alert|error|summary|daily)/.test(e.type),
    },
    refreshOn: new Set([
      "order.filled",
      "position.opened",
      "position.closed",
      "decision.result",
      "engine.status",
      "command.completed",
      "command.failed",
      "summary.periodic",
      "daily.stats",
      "market.session",
      "agent.woke",
      "agent.step",
      "agent.answered",
      "agent.watch",
      "agent.breaker",
    ]),
    // The agent's lookups are debug-level, but worth a line in the feed.
    feedDebug: new Set(["agent.step"]),
    feedHidden: new Set([]),
    summary: (e) => e.summary,
    detail,
    links,
  },
}
