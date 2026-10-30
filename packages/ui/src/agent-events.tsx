"use client"

import { AGENT_EVENT_TYPES } from "@mb/core/events"
import { BellIcon, BotIcon, EyeIcon, SearchIcon, ShieldAlertIcon, type LucideIcon } from "lucide-react"
import Link from "next/link"
import type { AnyEvent } from "./stream"

/**
 * How the activity feed shows the agent's events, the same in both dashboards: each app's event
 * catalog (components/kit.tsx) spreads these into its own.
 */

export const AGENT_ICONS: Partial<Record<string, LucideIcon>> = {
  "agent.woke": BellIcon,
  "agent.step": SearchIcon,
  "agent.answered": BotIcon,
  "agent.watch": EyeIcon,
  "agent.breaker": ShieldAlertIcon,
}

export const isAgentEvent = (e: { type: string }) => (AGENT_EVENT_TYPES as readonly string[]).includes(e.type)

/** The line under an agent event: why it woke, what it did, a watch's note. Null for other events. */
export const agentDetail = (e: AnyEvent): React.ReactNode => {
  const d = e.data as Record<string, unknown>
  if (e.type === "agent.woke") return ((d.reasons as string[] | undefined) ?? []).slice(1, 3).join(" · ") || null
  if (e.type === "agent.answered") return ((d.actions as { symbol: string; action: string; outcome: string }[] | undefined) ?? []).map((a) => `${a.symbol} ${a.action.replace(/_/g, " ")}: ${a.outcome.replace(/_/g, " ")}`).join(" · ") || null
  if (e.type === "agent.watch") return String(d.note ?? "")
  return null
}

/** A link from an agent event to its episode. */
export const agentLinks = (e: AnyEvent): React.ReactNode => {
  const id = (e.data as { episode_id?: unknown }).episode_id
  return (e.type === "agent.answered" || e.type === "agent.woke") && typeof id === "string" ? (
    <Link href={`/agent/${id}`} className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2">
      View episode
    </Link>
  ) : null
}
