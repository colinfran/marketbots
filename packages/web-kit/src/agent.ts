import "server-only"
import { describeWatch, type AgentEpisodeDoc, type AgentNoteDoc, type AgentStatus, type AgentWatchDoc } from "@mb/core/agent"
import { toAgentStatusView, type AgentStatusView, type EpisodeRowView, type EpisodeView, type NoteView, type WatchView } from "@mb/core/agent-views"

export type { AgentStatusView, EpisodeRowView, EpisodeView, NoteView, StepView, WatchView } from "@mb/core/agent-views"

/** The heartbeat's agent block as the page shows it, or null before the engine reported one. */
export const agentStatusView = (status: { agent?: AgentStatus } | null): AgentStatusView | null => (status?.agent ? toAgentStatusView(status.agent) : null)
import type { Collection } from "mongodb"
import { connection } from "next/server"
import { localDayWindowStart } from "./queries"

/**
 * The agent's pages (docs/plans/LOCAL-AI.md §11), the same in both dashboards: its episodes, its
 * watches and notes. Only plain, serializable values leave this module (dates
 * as ISO strings). The model's thinking is owner-only unless the bot's `agent.public_thinking` is
 * on: the caller says whether to include it.
 */

export type AgentCollections = {
  agentEpisodes: Collection<AgentEpisodeDoc>
  agentWatches: Collection<AgentWatchDoc>
  agentNotes: Collection<AgentNoteDoc>
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)

/** The agent card's clock (`getEpisodeTimes`; the same shape as @mb/ui/agent's `AgentStatusCard` `episodes`). */
export type EpisodeTimes = { started: number[]; lastAt: string | null }

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

  /**
   * The agent card's clock, from the stored episodes. `started`: when each episode of the last 26
   * hours started (ms), for "Episodes today" in the viewer's day (./queries `localDayWindowStart`;
   * the heartbeat's `episodes_today` counts the bot's day). `lastAt`: when the latest one finished
   * (ISO): the heartbeat's `last_episode_at` is kept in memory, so it is null from an engine restart
   * until the next episode ends. Episodes run one at a time, so the latest started is the latest finished.
   */
  const getEpisodeTimes = async (): Promise<EpisodeTimes> => {
    await connection()
    const { agentEpisodes } = await collections()
    const [docs, latest] = await Promise.all([
      agentEpisodes.find({ started_at: { $gte: localDayWindowStart() } }, { projection: { _id: 0, started_at: 1 } }).toArray(),
      agentEpisodes.findOne({}, { sort: { started_at: -1 }, projection: { _id: 0, started_at: 1, finished_at: 1 } }),
    ])
    return { started: docs.map((d) => d.started_at.getTime()), lastAt: iso(latest?.finished_at ?? latest?.started_at) }
  }

  /** The episodes that started in [from, to), oldest first (a journal day). */
  const getEpisodesBetween = async (from: Date, to: Date) => {
    await connection()
    const { agentEpisodes } = await collections()
    return (await agentEpisodes.find({ started_at: { $gte: from, $lt: to } }, { projection: { brief: 0, answer: 0 } }).sort({ started_at: 1 }).limit(500).toArray()).map(toRow)
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

  return { getEpisodes, getEpisodeTimes, getEpisodesBetween, getEpisode, getAgentMemory }
}
