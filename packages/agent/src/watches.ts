import { randomUUID } from "node:crypto"
import {
  AGENT_LIMITS,
  BOOK_SUBJECT,
  describeWatch,
  MARKET_SUBJECT,
  WATCH_PRIORITY,
  type AgentNoteDoc,
  type AgentWatchDoc,
  type NoteRequest,
  type Observation,
  type WatchRequest,
} from "@mb/core/agent"
import { cleanLine } from "@mb/engine-kit/util/text"

export { describeWatch }

/**
 * Watches and notes (docs/plans/LOCAL-AI.md §8.5). A watch is how the agent acts in real time
 * without polling: code checks it on every price tick, news item and second, and a watch that fires
 * becomes an observation that wakes the agent. A watch only wakes the agent; it never places an
 * order. Notes are the agent's working memory per subject, shown in every brief on it.
 *
 * Both are the model's output, so they are normalized like decisions: known symbols only, bounded
 * numbers, capped text, and the limits in AGENT_LIMITS.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** A time watch stays armed this long past its time (a restart or a busy queue). */
const TIME_GRACE_MS = 10 * 60_000
/** News watches below this severity would wake the agent on noise. */
const MIN_NEWS_SEVERITY = 30
const DEFAULT_NEWS_SEVERITY = 55

export type WatchEnv = {
  now: Date
  /** The latest price, or null when there is none. */
  price: (symbol: string) => number | null
  /** Whether the bot knows the symbol (its universe, holdings, watchlist…). */
  known: (symbol: string) => boolean
  /** The active watches, for the limits. */
  active: readonly AgentWatchDoc[]
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Turns one requested watch into a stored one, or says why not. */
export const normalizeWatch = (w: WatchRequest, episodeId: string, env: WatchEnv): { watch: AgentWatchDoc } | { rejected: string } => {
  const symbol = w.symbol?.trim().toUpperCase() || null
  if (symbol === null && w.kind !== "news" && w.kind !== "time") return { rejected: `${w.kind} needs a symbol` }
  if (symbol !== null && !env.known(symbol)) return { rejected: `unknown symbol ${symbol}` }
  const active = env.active.filter((a) => a.status === "active")
  if (active.length >= AGENT_LIMITS.watches_total) return { rejected: `already ${AGENT_LIMITS.watches_total} active watches` }
  if (symbol && active.filter((a) => a.symbol === symbol).length >= AGENT_LIMITS.watches_per_symbol) return { rejected: `already ${AGENT_LIMITS.watches_per_symbol} active watches on ${symbol}` }
  const now = env.now.getTime()
  const hours = clamp(Number.isFinite(w.hours) ? w.hours : 24, 1, AGENT_LIMITS.watch_max_hours)
  let level: number | null = null
  let refPrice: number | null = null
  let at: Date | null = null
  let expires = now + hours * HOUR
  const price = symbol ? env.price(symbol) : null
  if (w.kind === "price_above" || w.kind === "price_below") {
    if (w.level === null || !Number.isFinite(w.level) || w.level <= 0) return { rejected: `${w.kind} needs a price` }
    if (price !== null && (w.kind === "price_above" ? price >= w.level : price <= w.level)) return { rejected: `${symbol} is already ${w.kind === "price_above" ? "above" : "below"} ${w.level} (${price})` }
    level = w.level
  } else if (w.kind === "move_pct") {
    if (price === null) return { rejected: `no price for ${symbol}` }
    if (w.level === null || !Number.isFinite(w.level) || w.level <= 0) return { rejected: "move_pct needs a % move" }
    level = Math.round(clamp(w.level, 0.5, 50) * 100) / 100
    refPrice = price
  } else if (w.kind === "news") {
    level = Math.round(clamp(w.level !== null && Number.isFinite(w.level) ? w.level : DEFAULT_NEWS_SEVERITY, MIN_NEWS_SEVERITY, 100))
  } else {
    const t = w.at ? Date.parse(w.at) : Number.NaN
    if (!Number.isFinite(t)) return { rejected: "time needs `at` as an ISO date-time" }
    if (t <= now) return { rejected: `${w.at} is in the past` }
    if (t > now + AGENT_LIMITS.watch_max_hours * HOUR) return { rejected: `${w.at} is more than ${AGENT_LIMITS.watch_max_hours} hours away` }
    at = new Date(t)
    expires = t + TIME_GRACE_MS
  }
  const note = cleanLine(w.note, AGENT_LIMITS.watch_note_chars)
  const created = env.now
  return {
    watch: {
      _id: randomUUID(),
      episode_id: episodeId,
      kind: w.kind,
      symbol,
      level,
      ref_price: refPrice,
      at,
      priority: WATCH_PRIORITY[w.priority] ?? 2,
      note: note || describeWatch({ kind: w.kind, symbol, level, ref_price: refPrice, at }),
      status: "active",
      created_at: created,
      expires_at: new Date(expires),
      ended_at: null,
      purge_at: new Date(expires + 30 * DAY),
    },
  }
}

/** Whether a price or time watch fires now. News watches fire on items (`newsWatchFires`). */
export const watchFires = (w: AgentWatchDoc, now: Date, price: (symbol: string) => number | null): boolean => {
  if (w.status !== "active") return false
  if (w.kind === "time") return !!w.at && now >= w.at
  if (w.kind === "news" || !w.symbol || w.level === null) return false
  const p = price(w.symbol)
  if (p === null) return false
  if (w.kind === "price_above") return p >= w.level
  if (w.kind === "price_below") return p <= w.level
  return !!w.ref_price && Math.abs(p / w.ref_price - 1) * 100 >= w.level
}

/** Whether a news item fires a news watch: about its symbol (or market-wide for a market watch), at its severity or more. */
export const newsWatchFires = (w: AgentWatchDoc, item: { symbols: readonly string[]; severity: number }) =>
  w.status === "active" && w.kind === "news" && item.severity >= (w.level ?? DEFAULT_NEWS_SEVERITY) && (w.symbol ? item.symbols.includes(w.symbol) : item.symbols.length === 0)

/** The observation a fired watch becomes: it wakes the agent even inside the subject's cooldown. */
export const watchObservation = (w: AgentWatchDoc, now: Date, detail?: string): Observation => ({
  id: `watch:${w._id}`,
  subject: w.symbol ?? MARKET_SUBJECT,
  kind: "watch",
  priority: w.priority,
  salience: 80,
  summary: `Your watch fired: ${describeWatch(w)}${detail ? ` (${detail})` : ""}. Your note: ${w.note}`,
  untrusted: !!detail,
  urgent: true,
  refs: { watch_id: w._id },
  at: now,
})

/** Turns one requested note into a stored one, or says why not. */
export const normalizeNote = (n: NoteRequest, episodeId: string, env: Pick<WatchEnv, "now" | "known">): { note: AgentNoteDoc } | { rejected: string } => {
  const subject = n.subject.trim().toUpperCase()
  if (subject !== MARKET_SUBJECT && subject !== BOOK_SUBJECT && !env.known(subject)) return { rejected: `unknown subject ${subject}` }
  const text = cleanLine(n.text, AGENT_LIMITS.note_chars)
  if (!text) return { rejected: "empty note" }
  return { note: { _id: randomUUID(), episode_id: episodeId, subject, text, created_at: env.now, expires_at: new Date(env.now.getTime() + AGENT_LIMITS.note_days * DAY) } }
}
