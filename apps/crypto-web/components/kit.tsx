"use client"

import type { EngineEvent, EventDataMap } from "@mb/crypto-core/events"
import { AGENT_ICONS, agentDetail, agentLinks, isAgentEvent } from "@mb/ui/agent-events"
import type { BotKit } from "@mb/ui/kit"
import { AlertTriangleIcon, ArrowDownRightIcon, ArrowUpRightIcon, BotIcon, BrainIcon, NewspaperIcon, type LucideIcon, ShieldCheckIcon, WalletIcon, ZapIcon } from "lucide-react"
import Link from "next/link"
import { BotMark } from "@/components/bot-mark"
import { dateTime, pct, price, symbolSlug, time, tone } from "@/lib/format"

/**
 * CryptoMarketBot's kit for the shared dashboard components (@mb/ui/kit): brand, formatting,
 * links, and the catalog of crypto's events that drives the live UI.
 */

/** What the execution path is doing while the agent's decisions go through it. */
export const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  risk_check: "Risk check",
  placing_order: "Placing order",
}

const ICONS: Partial<Record<string, LucideIcon>> = {
  "ai.decision.proposed": BrainIcon,
  "order.submitted": WalletIcon,
  "order.filled": WalletIcon,
  "order.rejected": AlertTriangleIcon,
  "order.canceled": WalletIcon,
  "position.opened": ArrowUpRightIcon,
  "position.closed": ArrowDownRightIcon,
  "protection.triggered": ShieldCheckIcon,
  alert: AlertTriangleIcon,
  error: AlertTriangleIcon,
  "engine.status": BotIcon,
  "wire.item": NewspaperIcon,
  "wire.notable": NewspaperIcon,
  "wire.trigger": ZapIcon,
  ...AGENT_ICONS,
}

/** Extra line under an event: the agent's, the decision thesis, risk reasons, a news link, a sale's P&L. */
const detail = (e: EngineEvent): React.ReactNode => {
  if (isAgentEvent(e)) return agentDetail(e)
  const d = e.data as Record<string, unknown>
  if (e.type === "ai.decision.proposed") return String(d.thesis ?? "")
  if (e.type === "risk.checked" && !d.approved) return (d.reasons as string[] | undefined)?.join(" · ")
  if ((e.type === "wire.item" || e.type === "wire.notable") && typeof d.url === "string") {
    return (
      <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-foreground underline underline-offset-2">
        {String(d.source ?? "source")} · severity {String(d.severity)}
      </a>
    )
  }
  if (e.type === "wire.trigger") return `${String(d.action ?? "").replace(/_/g, " ")}: ${String(d.reason ?? "")}`
  if (e.type === "position.closed" && typeof d.realized_pnl_usd === "number") {
    return <span className={tone(d.realized_pnl_usd)}>{d.realized_pnl_usd >= 0 ? "+" : "−"}${Math.abs(d.realized_pnl_usd).toFixed(2)} realized{typeof d.return_pct === "number" ? ` (${pct(d.return_pct)})` : ""}</span>
  }
  return null
}

/** The feed line: the pair links to its market page, ahead of the summary (which loses its own "BTC/USD:" prefix). */
const summary = (e: EngineEvent): React.ReactNode => (
  <>
    {e.instrument ? (
      <Link prefetch href={`/markets/${symbolSlug(e.instrument)}`} className="font-mono font-semibold hover:underline">
        {e.instrument}
      </Link>
    ) : null}
    {e.instrument ? " " : null}
    {e.instrument ? e.summary.replace(new RegExp(`^${e.instrument.replace("/", "\\/")}:?\\s*`), "") : e.summary}
  </>
)

const links = (e: EngineEvent): React.ReactNode => (isAgentEvent(e) ? agentLinks(e) : null)

export const kit: BotKit<EngineEvent> = {
  name: "CryptoMarketBot",
  Mark: BotMark,
  stream: {
    maxEvents: 500,
    mapTicker: (data) => {
      const d = data as EventDataMap["market.ticker"]
      return { symbol: d.symbol, bid: d.bid, ask: d.ask, last: d.last, change_pct: d.change_pct }
    },
  },
  format: { price, time, dateTime },
  symbolHref: (symbol) => `/markets/${symbolSlug(symbol)}`,
  sourceLabel: (source, domain) => domain ?? source,
  statusStyles: {},
  events: {
    stateLabels: STATE_LABEL,
    icons: ICONS,
    filters: {
      ai: (e) => isAgentEvent(e) || e.type === "ai.decision.proposed" || e.type === "risk.checked",
      news: (e) => e.type === "wire.item" || e.type === "wire.notable" || e.type === "wire.trigger",
      trades: (e) => /^(order|position|protection|risk)\./.test(e.type),
      system: (e) => /^(engine|venue|market|command|alert|error|summary)/.test(e.type),
    },
    refreshOn: new Set(["order.filled", "position.opened", "position.closed", "position.updated", "engine.status", "command.completed", "command.failed", "summary.periodic", "engine.reconciled", "agent.woke", "agent.step", "agent.answered", "agent.watch", "agent.breaker"]),
    // The agent's lookups are debug-level, but worth a line in the feed.
    feedDebug: new Set(["agent.step"]),
    feedHidden: new Set([]),
    summary,
    detail,
    links,
  },
}
