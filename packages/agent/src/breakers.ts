import type { AgentActionOutcome, EpisodeStatus } from "@mb/core/agent"

/**
 * Circuit breakers (docs/plans/LOCAL-AI.md §9, ring 4): signs the agent is misbehaving. Above level
 * shadow a trip drops it back to shadow; at level shadow there is nothing lower to go to, so a trip
 * is recorded, streamed and alerted, and nothing is enforced.
 *
 * Pure: the runtime keeps the recent history (since the engine started) and asks after every
 * episode which breakers are tripped.
 */

export type BreakerHistory = {
  /** Episodes in the last hour, oldest first. */
  episodes: { at: number; status: Exclude<EpisodeStatus, "running"> }[]
  /** What became of each entry the agent proposed, oldest first (since the engine started). */
  entries: { at: number; outcome: AgentActionOutcome }[]
  /** Entries the envelope refused today. */
  envelopeBlocksToday: number
  /** The shadow book's day and total return, %. */
  dayPnlPct: number
  totalPnlPct: number
  /** Generation speed of the latest steps, tokens/s, oldest first. */
  speeds: number[]
}

export type Breaker = { name: string; detail: string }

const HOUR = 3_600_000
/** Generation slower than this means the model left the GPUs or something is crowding them (normal: 40-47). */
export const SLOW_TOKENS_PER_S = 35
const SLOW_STEPS = 5

export const trippedBreakers = (h: BreakerHistory, now: number): Breaker[] => {
  const out: Breaker[] = []
  const rejected = (o: AgentActionOutcome) => o === "rejected" || o === "blocked"
  const lastFive = h.entries.slice(-5)
  if (lastFive.length === 5 && lastFive.every((e) => e.outcome === "rejected")) out.push({ name: "risk_rejections", detail: "the risk checks rejected 5 entries in a row" })
  const hour = h.entries.filter((e) => now - e.at < HOUR)
  if (hour.length >= 4 && hour.filter((e) => rejected(e.outcome)).length > hour.length / 2) {
    out.push({ name: "rejection_rate", detail: `${hour.filter((e) => rejected(e.outcome)).length} of ${hour.length} entries rejected in the last hour` })
  }
  const episodes = h.episodes.filter((e) => now - e.at < HOUR)
  const invalid = episodes.filter((e) => e.status === "invalid").length
  if (episodes.length >= 5 && invalid / episodes.length > 0.1) out.push({ name: "invalid_answers", detail: `${invalid} of ${episodes.length} answers invalid in the last hour` })
  if (h.envelopeBlocksToday >= 3) out.push({ name: "envelope_blocks", detail: `the envelope refused ${h.envelopeBlocksToday} entries today` })
  if (h.dayPnlPct <= -3) out.push({ name: "daily_loss", detail: `the shadow book is down ${h.dayPnlPct.toFixed(2)}% today` })
  if (h.totalPnlPct <= -6) out.push({ name: "total_loss", detail: `the shadow book is down ${h.totalPnlPct.toFixed(2)}% in all` })
  const recent = h.speeds.slice(-SLOW_STEPS)
  if (recent.length === SLOW_STEPS && recent.every((s) => s > 0 && s < SLOW_TOKENS_PER_S)) {
    out.push({ name: "slow_model", detail: `the last ${SLOW_STEPS} steps generated under ${SLOW_TOKENS_PER_S} tokens/s (${recent.map((s) => Math.round(s)).join(", ")})` })
  }
  return out
}
