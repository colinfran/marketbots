import "server-only"
import { describeWatch, type AgentEpisodeDoc, type AgentNoteDoc, type AgentStatus, type AgentWatchDoc, type ShadowFillDoc, type ShadowPositionDoc } from "@mb/core/agent"
import { toAgentStatusView, type AgentStatusView, type EpisodeRowView, type EpisodeView, type NoteView, type ShadowFillView, type ShadowPositionView, type WatchView } from "@mb/core/agent-views"

export type { AgentStatusView, EpisodeRowView, EpisodeView, NoteView, ShadowFillView, ShadowPositionView, StepView, WatchView } from "@mb/core/agent-views"

/** The heartbeat's agent block as the page shows it, or null before the engine reported one. */
export const agentStatusView = (status: { agent?: AgentStatus } | null): AgentStatusView | null => (status?.agent ? toAgentStatusView(status.agent) : null)
import type { Collection } from "mongodb"
import { connection } from "next/server"

/**
 * The agent's pages (docs/plans/LOCAL-AI.md §11), the same in both dashboards: its episodes, its
 * watches and notes, and the shadow book. Only plain, serializable values leave this module (dates
 * as ISO strings). The model's thinking is owner-only unless the bot's `agent.public_thinking` is
 * on: the caller says whether to include it.
 */

export type AgentCollections = {
  agentEpisodes: Collection<AgentEpisodeDoc>
  agentWatches: Collection<AgentWatchDoc>
  agentNotes: Collection<AgentNoteDoc>
  shadowPositions: Collection<ShadowPositionDoc>
  shadowFills: Collection<ShadowFillDoc>
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

const toRow = (e: AgentEpisodeDoc): EpisodeRowView => ({
  id: e._id,
  started_at: e.started_at.toISOString(),
  subject: e.subject,
  priority: e.priority,
  status: e.status,
  kinds: [...new Set(e.observations.map((o) => o.kind))],
  reply: e.reply,
  error: e.error,
  duration_ms: e.duration_ms,
  tools: e.steps.filter((s) => s.kind === "tool" && s.tool).map((s) => s.tool!),
  actions: e.actions.map((a) => ({ symbol: a.symbol, action: a.action, outcome: a.outcome })),
})

const toPosition = (p: ShadowPositionDoc): ShadowPositionView => ({
  id: p._id,
  symbol: p.symbol,
  status: p.status,
  qty: p.qty,
  entry_price: p.entry_price,
  mark_price: p.mark_price,
  stop_price: p.stop_price,
  take_profit_price: p.take_profit_price,
  cost_usd: p.cost_usd,
  realized_pnl_usd: p.realized_pnl_usd,
  opened_at: p.opened_at.toISOString(),
  closed_at: iso(p.closed_at),
  exit_price: p.exit_price,
  exit_reason: p.exit_reason,
  horizon: p.horizon,
  strategy: p.strategy,
  thesis: p.thesis,
  conviction: p.conviction,
  episode_id: p.episode_id,
})

export const createAgentQueries = <Cols extends AgentCollections>({ collections }: { collections: () => Promise<Cols> }) => {
  const getEpisodes = async (limit = 50): Promise<EpisodeRowView[]> => {
    await connection()
    const { agentEpisodes } = await collections()
    const docs = await agentEpisodes.find({}, { projection: { brief: 0, answer: 0, "steps.thinking": 0, "steps.result": 0, "steps.args": 0 } }).sort({ started_at: -1 }).limit(limit).toArray()
    return docs.map(toRow)
  }

  const getEpisode = async (id: string, { thinking }: { thinking: boolean }): Promise<EpisodeView | null> => {
    await connection()
    const { agentEpisodes } = await collections()
    const e = await agentEpisodes.findOne({ _id: id })
    if (!e) return null
    return {
      ...toRow(e),
      level: e.level,
      question: e.question,
      finished_at: iso(e.finished_at),
      observations: e.observations.map((o) => ({ kind: o.kind, priority: o.priority, salience: o.salience, summary: o.summary, at: new Date(o.at).toISOString(), untrusted: !!o.untrusted })),
      brief: e.brief,
      steps: e.steps.map((s) => ({ ...s, thinking: thinking ? s.thinking : null })),
      answer: e.answer === null || e.answer === undefined ? null : JSON.stringify(e.answer, null, 2),
      actions: e.actions,
      memory: e.memory ?? [],
      model: e.model,
      prompt_version: e.prompt_version,
      usage: { input: e.usage.input, output: e.usage.output },
    }
  }

  /** The shadow book's open positions, its last closed ones and its last fills. */
  const getShadowBook = async () => {
    await connection()
    const { shadowPositions, shadowFills } = await collections()
    const [open, closed, fills] = await Promise.all([
      shadowPositions.find({ status: "open" }).sort({ opened_at: -1 }).toArray(),
      shadowPositions.find({ status: "closed" }).sort({ closed_at: -1 }).limit(20).toArray(),
      shadowFills.find({}).sort({ at: -1 }).limit(30).toArray(),
    ])
    return {
      open: open.map(toPosition),
      closed: closed.map(toPosition),
      fills: fills.map((f): ShadowFillView => ({ id: f._id, symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, at: f.at.toISOString(), reason: f.reason, realized_pnl_usd: f.realized_pnl_usd, episode_id: f.episode_id })),
    }
  }

  /** The agent's active watches and its notes. */
  const getAgentMemory = async () => {
    await connection()
    const { agentWatches, agentNotes } = await collections()
    const [watches, notes] = await Promise.all([agentWatches.find({ status: "active" }).sort({ created_at: -1 }).limit(40).toArray(), agentNotes.find({ expires_at: { $gt: new Date() } }).sort({ created_at: -1 }).limit(60).toArray()])
    return {
      watches: watches.map((w): WatchView => ({ id: w._id, kind: w.kind, symbol: w.symbol, what: describeWatch(w), note: w.note, priority: w.priority, created_at: w.created_at.toISOString(), expires_at: w.expires_at.toISOString(), episode_id: w.episode_id })),
      notes: notes.map((n): NoteView => ({ id: n._id, subject: n.subject, text: n.text, created_at: n.created_at.toISOString(), expires_at: n.expires_at.toISOString(), episode_id: n.episode_id })),
    }
  }

  return { getEpisodes, getEpisode, getShadowBook, getAgentMemory }
}
