import type { AgentEpisodeDoc } from "@mb/core/agent"
import { cap } from "./tools"

/**
 * The journal (docs/plans/LOCAL-AI.md §8.6). Every episode is kept twice:
 *
 * - in MongoDB (`agent_episodes`) for the dashboard, with its long text capped (the brief, each
 *   step's thinking and tool result) and a 14-day TTL, because the Atlas tier may be the free one.
 *   An episode that changed the shadow book is kept for good, so the dashboard can always show why;
 * - in the history store (`EpisodeArchive`), uncapped, for replays and debugging.
 */

export const EPISODE_TTL_DAYS = 14

export const ATLAS_CAPS = { brief: 8_000, args: 600, result: 1_000, thinking: 2_000 } as const

/** The full episode record's other home: the bot's history store. */
export type EpisodeArchive = { saveEpisode(doc: AgentEpisodeDoc): Promise<void> }

/** The dashboard's copy of an episode. */
export const compactEpisode = (doc: AgentEpisodeDoc): AgentEpisodeDoc => ({
  ...doc,
  brief: cap(doc.brief, ATLAS_CAPS.brief),
  steps: doc.steps.map((s) => ({
    ...s,
    args: s.args === null ? null : cap(s.args, ATLAS_CAPS.args),
    result: s.result === null ? null : cap(s.result, ATLAS_CAPS.result),
    thinking: s.thinking === null ? null : cap(s.thinking, ATLAS_CAPS.thinking),
  })),
})

/** When an episode's dashboard copy expires: never once it changed the shadow book. */
export const episodeExpiry = (doc: Pick<AgentEpisodeDoc, "started_at" | "actions">): Date | null =>
  doc.actions.some((a) => a.outcome === "filled" || a.outcome === "updated") ? null : new Date(doc.started_at.getTime() + EPISODE_TTL_DAYS * 86_400_000)
