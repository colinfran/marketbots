// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import { PollingSource, type PollFn } from "./poller"
import type { SourceContext, SourceSpec } from "./types"

/**
 * Numbers that become news only when they do something out of the ordinary: funding, open
 * interest, TVL, odds, app ranks, mention counts, fees. A MetricWatcher keeps each series' recent
 * history (bounded in time and points) and checks every new reading against rules:
 *
 *   level   |value| ≥ abs, optionally held on the same side for `forMin` minutes
 *   change  moved ≥ pct % or ≥ points within the last `windowMin` minutes (optionally one way)
 *   spike   value ≥ ratio × the trailing median over `windowMin` minutes
 *
 * A series' first reading is only a baseline, so nothing fires on boot (a reading that is already
 * out of the ordinary then waits for the next excursion). Each rule fires once per excursion, like
 * the anomaly detector's gate: it re-arms only after the reading falls below `rearmAt` (half) of
 * its threshold AND `rearmMs` (15 minutes) has passed. Rules return what crossed; the source turns
 * that into items. `crossingMeta` marks those items as readings (`meta.metric`), which the policy
 * and the dossier never take as the explanation of a price move.
 */

type CommonRule = {
  /** Unique per series, e.g. "funding". */
  id: string
  /** The rule only applies while |value| ≥ min (so 3 → 9 mentions isn't a "jump"). */
  min?: number
  /** Re-arms once the reading falls below this share of the threshold (default 0.5). */
  rearmAt?: number
  /** …and no sooner than this after it fired (default 15 minutes). */
  rearmMs?: number
}

export type LevelRule = CommonRule & {
  kind: "level"
  abs: number
  /** The level must hold, on the same side, for this many minutes of readings. */
  forMin?: number
  /** Also report the end of the excursion (the reading is back inside). */
  exits?: boolean
}
export type ChangeRule = CommonRule & { kind: "change"; windowMin: number; pct?: number; points?: number; direction?: "up" | "down" }
export type SpikeRule = CommonRule & { kind: "spike"; windowMin: number; ratio: number; minSamples?: number }
export type MetricRule = LevelRule | ChangeRule | SpikeRule

export type Crossing = {
  key: string
  rule: string
  kind: MetricRule["kind"]
  at: number
  value: number
  /** change: the reading it moved from (the window's low or high); spike: the trailing median; level: null. */
  ref: number | null
  /** value − ref, in the series' own units. */
  delta: number | null
  /** delta as a % of |ref| (null when ref is 0 or absent). */
  pct: number | null
  /** spike: value / median. */
  ratio: number | null
  windowMin: number | null
  /** A level excursion ended (rules with `exits`). */
  exit: boolean
}

export type Reading = { at: number; value: number }

export type WatcherOptions = {
  /** History kept per series; must cover the longest rule window (default 26 h). */
  historyMs?: number
  maxPoints?: number
  maxKeys?: number
}

type Gate = { armed: boolean; firedAt: number }
type Series = { points: Reading[]; gates: Map<string, Gate> }
type Score = { score: number; ref: number | null; delta: number | null; pct: number | null; ratio: number | null }

const REARM_MS = 15 * 60_000
const NONE: Score = { score: 0, ref: null, delta: null, pct: null, ratio: null }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const pctOf = (delta: number, ref: number) => (ref !== 0 ? (delta / Math.abs(ref)) * 100 : null)

export class MetricWatcher {
  private readonly series = new Map<string, Series>()
  private readonly historyMs: number
  private readonly maxPoints: number
  private readonly maxKeys: number

  constructor({ historyMs = 26 * 3_600_000, maxPoints = 2_000, maxKeys = 5_000 }: WatcherOptions = {}) {
    this.historyMs = historyMs
    this.maxPoints = maxPoints
    this.maxKeys = maxKeys
  }

  get size() {
    return this.series.size
  }

  last(key: string): Reading | null {
    return this.series.get(key)?.points.at(-1) ?? null
  }

  forget(key: string) {
    this.series.delete(key)
  }

  /** A new reading. Returns the rules it crossed (never on a series' first reading, or for a reading not newer than the last). */
  observe(key: string, value: number, at: number, rules: MetricRule[]): Crossing[] {
    return this.step(key, value, at, rules, true)
  }

  /** Loads history without reporting anything (oldest first); the gates still learn whether the series ends mid-excursion. */
  backfill(key: string, readings: Reading[], rules: MetricRule[]) {
    for (const r of readings) this.step(key, r.value, r.at, rules, false)
  }

  private step(key: string, value: number, at: number, rules: MetricRule[], report: boolean): Crossing[] {
    if (!Number.isFinite(value) || !Number.isFinite(at)) return []
    let s = this.series.get(key)
    const baseline = !s
    if (!s) {
      s = { points: [], gates: new Map() }
      this.series.set(key, s)
      // Bounded: the oldest series goes first (Map keeps insertion order).
      if (this.series.size > this.maxKeys) this.series.delete(this.series.keys().next().value!)
    }
    const last = s.points.at(-1)
    if (last && at <= last.at) return []
    const out: Crossing[] = []
    for (const rule of rules) {
      const sc = Math.abs(value) < (rule.min ?? 0) ? NONE : this.score(s.points, rule, value, at)
      const gate = s.gates.get(rule.id) ?? { armed: true, firedAt: -Infinity }
      const crossing = (exit: boolean): Crossing => ({ key, rule: rule.id, kind: rule.kind, at, value, ref: sc.ref, delta: sc.delta, pct: sc.pct, ratio: sc.ratio, windowMin: rule.kind === "level" ? (rule.forMin ?? null) : rule.windowMin, exit })
      if (!gate.armed && sc.score < (rule.rearmAt ?? 0.5) && at - gate.firedAt >= (rule.rearmMs ?? REARM_MS)) {
        gate.armed = true
        if (rule.kind === "level" && rule.exits) out.push(crossing(true))
      }
      if (gate.armed && sc.score >= 1) {
        gate.armed = false
        gate.firedAt = at
        out.push(crossing(false))
      }
      s.gates.set(rule.id, gate)
    }
    s.points.push({ at, value })
    const cutoff = at - this.historyMs
    while (s.points.length > this.maxPoints || (s.points.length > 1 && s.points[0].at < cutoff)) s.points.shift()
    return report && !baseline ? out : []
  }

  /** How far past its threshold the reading is: ≥ 1 crosses, below `rearmAt` re-arms. */
  private score(points: Reading[], rule: MetricRule, value: number, at: number): Score {
    if (rule.kind === "level") {
      let v = Math.abs(value)
      if (rule.forMin) {
        // Held: the reading at the start of the window and every one since are on the same side.
        const since = at - rule.forMin * 60_000
        const start = points.findLastIndex((p) => p.at <= since)
        if (start < 0) return NONE
        for (const p of points.slice(start)) v = Math.sign(p.value) === Math.sign(value) ? Math.min(v, Math.abs(p.value)) : 0
      }
      return { ...NONE, score: v / rule.abs }
    }
    const since = at - rule.windowMin * 60_000
    const window = points.filter((p) => p.at >= since).map((p) => p.value)
    if (!window.length) return NONE
    if (rule.kind === "spike") {
      if (window.length < (rule.minSamples ?? 5)) return NONE
      const med = median(window)
      if (!(med > 0) || !(value > 0)) return NONE
      const ratio = value / med
      return { score: ratio / rule.ratio, ref: med, delta: value - med, pct: pctOf(value - med, med), ratio }
    }
    // change: from the window's low (a rise) or its high (a fall), whichever is larger.
    let best = NONE
    for (const ref of [Math.min(...window), Math.max(...window)]) {
      const delta = value - ref
      if ((rule.direction === "up" && delta <= 0) || (rule.direction === "down" && delta >= 0)) continue
      const pct = pctOf(delta, ref)
      const score = Math.max(rule.pct && pct !== null ? Math.abs(pct) / rule.pct : 0, rule.points ? Math.abs(delta) / rule.points : 0)
      if (score > best.score) best = { score, ref, delta, pct, ratio: null }
    }
    return best
  }
}

const round = (n: number | null) => (n === null ? null : Number(n.toPrecision(6)))

/** Item meta for a crossing. `metric` marks the item as one of our own readings. */
export const crossingMeta = (c: Crossing): Record<string, string | number | boolean | null> => ({
  metric: c.key,
  rule: c.rule,
  value: round(c.value),
  ref: round(c.ref),
  delta: round(c.delta),
  pct: c.pct === null ? null : Math.round(c.pct * 100) / 100,
  ratio: c.ratio === null ? null : Math.round(c.ratio * 100) / 100,
  window_min: c.windowMin,
  exit: c.exit,
})

/** A stable item id for a crossing: one per series, rule, direction and minute. */
export const crossingId = (c: Crossing) => `${c.key}|${c.rule}|${c.exit ? "exit" : "in"}|${new Date(c.at).toISOString().slice(0, 16)}`

/** A polled source whose poll feeds a watcher and returns items only for what crossed. */
export const metricSource = (spec: SourceSpec, ctx: SourceContext, make: (watch: MetricWatcher) => PollFn, opts?: WatcherOptions) => new PollingSource(spec, ctx, make(new MetricWatcher(opts)))
