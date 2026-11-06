import type { EpisodeStatus } from "@mb/core/agent"

/**
 * Circuit breakers (docs/plans/LOCAL-AI.md §9, ring 4), for extreme cases only. A drawdown of
 * `MAX_DRAWDOWN_PCT` from the account's peak pauses new entries until the owner resumes them. A
 * slow model or a run of invalid answers pauses them only while it lasts (`selfClearing`). Exits
 * carry on either way.
 *
 * A risk check or the envelope refusing an entry is the rules working, not the agent misbehaving,
 * so refusals trip nothing; a day's loss is the risk engines' daily limit, which lifts the next day.
 *
 * Pure: the runtime keeps the recent history and asks after every episode, and whenever it reads the
 * account, which breakers are tripped.
 */

export type BreakerHistory = {
  /** Episodes in the last hour, oldest first. */
  episodes: { at: number; status: Exclude<EpisodeStatus, "running"> }[]
  /** The account against its highest equity since the agent was turned on or its entries resumed, % (0 or below). */
  drawdownPct: number
  /** Generation speed of the latest steps, tokens/s, oldest first. */
  speeds: number[]
}

/** `owner`: the pause lasts until the owner resumes entries; otherwise only while the condition holds. */
export type Breaker = { name: string; detail: string; owner: boolean }

const HOUR = 3_600_000
/** Generation slower than this means the model left the GPUs or something is crowding them (normal: 40-47). */
export const SLOW_TOKENS_PER_S = 35
const SLOW_STEPS = 5
/** Invalid answers count only over at least this many episodes in an hour, and only when most are invalid. */
const INVALID_MIN_EPISODES = 10
const INVALID_SHARE = 0.5
/** The account this far below its peak pauses new entries until the owner resumes them. */
export const MAX_DRAWDOWN_PCT = 20

export const trippedBreakers = (h: BreakerHistory, now: number): Breaker[] => {
  const out: Breaker[] = []
  if (h.drawdownPct <= -MAX_DRAWDOWN_PCT) out.push({ name: "drawdown", detail: `the paper account is ${Math.abs(h.drawdownPct).toFixed(2)}% below its peak`, owner: true })
  const invalid = invalidAnswers(h.episodes, now)
  if (invalid) out.push(invalid)
  const slow = slowModel(h.speeds)
  if (slow) out.push(slow)
  return out
}

/** The breakers that pause entries only while they last: a slow model, most answers invalid. */
export const selfClearing = (h: Pick<BreakerHistory, "episodes" | "speeds">, now: number): Breaker | null => slowModel(h.speeds) ?? invalidAnswers(h.episodes, now)

/** Most of the last hour's answers (at least INVALID_MIN_EPISODES of them) were invalid. */
export const invalidAnswers = (episodes: BreakerHistory["episodes"], now: number): Breaker | null => {
  const hour = episodes.filter((e) => now - e.at < HOUR)
  const invalid = hour.filter((e) => e.status === "invalid").length
  if (hour.length < INVALID_MIN_EPISODES || invalid / hour.length <= INVALID_SHARE) return null
  return { name: "invalid_answers", detail: `${invalid} of ${hour.length} answers invalid in the last hour`, owner: false }
}

/** The model left the GPUs or something is crowding them: the last steps all generated too slowly. */
export const slowModel = (speeds: readonly number[]): Breaker | null => {
  const recent = speeds.slice(-SLOW_STEPS)
  if (recent.length < SLOW_STEPS || !recent.every((s) => s > 0 && s < SLOW_TOKENS_PER_S)) return null
  return { name: "slow_model", detail: `the last ${SLOW_STEPS} steps generated under ${SLOW_TOKENS_PER_S} tokens/s (${recent.map((s) => Math.round(s)).join(", ")})`, owner: false }
}
