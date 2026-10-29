import type { Observation, Priority } from "@mb/core/agent"

/**
 * The attention queue (docs/plans/LOCAL-AI.md §8.1): observations become wake-ups.
 *
 * - Coalesce per subject: a burst (twelve headlines about one hack) becomes one wake-up. A subject
 *   is ready once nothing new has arrived for its priority's quiet time, or 20 s after its first
 *   observation, whichever comes first.
 * - Priority: P0 risk > P1 opportunity > P2 review > P3 background; then salience; then age.
 * - Cooldown: a subject that woke the agent doesn't wake it again for the cooldown, unless its
 *   salience is 15 points above that wake's, or it's a P0, or an observation is `urgent` (a watch
 *   the agent set, the owner's question). Observations wait out the cooldown; none is lost to it.
 * - Observations expire after 30 minutes unserved (a paused engine, a long queue): old news
 *   shouldn't start an episode.
 *
 * Preemption is the runtime's: it asks `urgentReady` between steps.
 */

export type Wake = { subject: string; priority: Priority; salience: number; observations: Observation[] }

/** How long a subject waits for the rest of a burst, by priority. */
export const COALESCE_MS: Record<Priority, number> = { 0: 2_000, 1: 5_000, 2: 10_000, 3: 10_000 }
export const MAX_COALESCE_MS = 20_000
export const OBSERVATION_TTL_MS = 30 * 60_000
export const SALIENCE_BREAK = 15

type Entry = { subject: string; observations: Map<string, Observation>; priority: Priority; salience: number; urgent: boolean; firstAt: number; lastAt: number }

export class AttentionQueue {
  private readonly entries = new Map<string, Entry>()
  private readonly woke = new Map<string, { at: number; salience: number }>()

  constructor(
    private readonly cooldownMs: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  add(o: Observation) {
    const t = this.now()
    const e = this.entries.get(o.subject) ?? { subject: o.subject, observations: new Map(), priority: o.priority, salience: o.salience, urgent: false, firstAt: t, lastAt: t }
    if (e.observations.has(o.id)) return
    e.observations.set(o.id, o)
    e.priority = Math.min(e.priority, o.priority) as Priority
    e.salience = Math.max(e.salience, o.salience)
    e.urgent ||= !!o.urgent
    e.lastAt = t
    this.entries.set(o.subject, e)
  }

  private expire(t: number) {
    for (const [subject, e] of this.entries) {
      for (const [id, o] of e.observations) if (t - o.at.getTime() > OBSERVATION_TTL_MS) e.observations.delete(id)
      if (!e.observations.size) this.entries.delete(subject)
    }
  }

  private ready(e: Entry, t: number) {
    return t - e.lastAt >= COALESCE_MS[e.priority] || t - e.firstAt >= MAX_COALESCE_MS
  }

  private eligible(e: Entry, t: number) {
    const last = this.woke.get(e.subject)
    return !last || t - last.at >= this.cooldownMs() || e.priority === 0 || e.urgent || e.salience >= last.salience + SALIENCE_BREAK
  }

  /** The next wake-up that is ready and out of its cooldown, removed from the queue; null when there is none. */
  take(): Wake | null {
    const t = this.now()
    this.expire(t)
    const next = [...this.entries.values()]
      .filter((e) => this.ready(e, t) && this.eligible(e, t))
      .sort((a, b) => a.priority - b.priority || b.salience - a.salience || a.firstAt - b.firstAt)[0]
    if (!next) return null
    this.entries.delete(next.subject)
    this.woke.set(next.subject, { at: t, salience: next.salience })
    if (this.woke.size > 2_000) this.woke.delete(this.woke.keys().next().value!)
    return { subject: next.subject, priority: next.priority, salience: next.salience, observations: [...next.observations.values()].sort((a, b) => a.at.getTime() - b.at.getTime()) }
  }

  /** A P0 is ready to wake the agent: the runtime preempts a running P1-P3 episode for it. */
  urgentReady(): boolean {
    const t = this.now()
    return [...this.entries.values()].some((e) => e.priority === 0 && this.ready(e, t))
  }

  /** What's waiting, most urgent first (the heartbeat and the dashboard). */
  pending() {
    return [...this.entries.values()]
      .sort((a, b) => a.priority - b.priority || b.salience - a.salience)
      .map((e) => ({ subject: e.subject, priority: e.priority, salience: e.salience, observations: e.observations.size }))
  }

  get size() {
    return this.entries.size
  }

  clear() {
    this.entries.clear()
  }
}
