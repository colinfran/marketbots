import type { AgentStatus, AgentStepDoc } from "./agent"

/**
 * The agent as the dashboards show it (docs/plans/LOCAL-AI.md §11): plain, serializable views of
 * its documents (dates as ISO strings). @mb/web-kit/agent builds them on the server; @mb/ui/agent
 * renders them.
 */

export type EpisodeRowView = {
  id: string
  started_at: string
  subject: string
  priority: number
  status: string
  kinds: string[]
  reply: string | null
  error: string | null
  duration_ms: number | null
  tools: string[]
  actions: { symbol: string; action: string; outcome: string }[]
}

export type StepView = Omit<AgentStepDoc, "thinking"> & { thinking: string | null }

export type EpisodeView = Omit<EpisodeRowView, "actions"> & {
  level: string
  question: string | null
  finished_at: string | null
  observations: { kind: string; priority: number; salience: number; summary: string; at: string; untrusted: boolean }[]
  brief: string
  steps: StepView[]
  /** The answer as JSON text (its decisions, watches, notes and reply). */
  answer: string | null
  actions: { symbol: string; action: string; conviction: number; outcome: string; detail: string | null }[]
  memory: string[]
  model: string
  prompt_version: string
  usage: { input: number; output: number }
}

export type ShadowPositionView = {
  id: string
  symbol: string
  status: string
  qty: number
  entry_price: number
  mark_price: number | null
  stop_price: number | null
  take_profit_price: number | null
  cost_usd: number
  realized_pnl_usd: number
  opened_at: string
  closed_at: string | null
  exit_price: number | null
  exit_reason: string | null
  horizon: string | null
  strategy: string | null
  thesis: string
  conviction: number
  episode_id: string
}

export type ShadowFillView = { id: string; symbol: string; side: string; qty: number; price: number; at: string; reason: string; realized_pnl_usd: number | null; episode_id: string | null }

export type WatchView = { id: string; kind: string; symbol: string | null; what: string; note: string; priority: number; created_at: string; expires_at: string; episode_id: string }

export type NoteView = { id: string; subject: string; text: string; created_at: string; expires_at: string; episode_id: string }

/** The heartbeat's agent block (AgentStatus) with its dates as ISO strings. */
export type AgentStatusView = Omit<AgentStatus, "episode" | "last_episode_at"> & {
  episode: (Omit<NonNullable<AgentStatus["episode"]>, "started_at"> & { started_at: string }) | null
  last_episode_at: string | null
}

export const toAgentStatusView = (s: AgentStatus): AgentStatusView => ({
  ...s,
  episode: s.episode ? { ...s.episode, started_at: new Date(s.episode.started_at).toISOString() } : null,
  last_episode_at: s.last_episode_at ? new Date(s.last_episode_at).toISOString() : null,
})
