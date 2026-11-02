import { z } from "zod"
import type { TokenUsage } from "./db"

/**
 * The agent (docs/plans/LOCAL-AI.md §8): what both bots mean the same thing by. Code turns what it
 * sees into observations; the attention queue turns observations into wake-ups; each wake-up is an
 * episode, in which the local model looks things up with read-only tools and answers with the
 * bot's decisions, watches and notes, and its decisions trade the paper account through the bot's
 * own risk checks and execution.
 *
 * The runtime is @mb/agent; each engine's src/agent/ holds the bot's tools, brief and prompts.
 */

/**
 * on = the agent trades the paper account through the bot's own risk checks and execution, inside
 * its envelope; off = nothing decides (stops, targets and the risk halts still protect positions).
 * A tripped breaker pauses its new entries until the owner resumes them; it never turns it off.
 */
export const AGENT_LEVELS = ["off", "on"] as const
export type AgentLevel = (typeof AGENT_LEVELS)[number]

/** 0 = risk to a holding, 1 = an opportunity, 2 = a review, 3 = background. Lower runs first. */
export type Priority = 0 | 1 | 2 | 3
export const PRIORITY_KEYS = ["p0", "p1", "p2", "p3"] as const
export const PRIORITY_LABEL: Record<Priority, string> = { 0: "risk", 1: "opportunity", 2: "review", 3: "background" }

/** Subjects that aren't a symbol: the whole market, the agent's own book, an owner's question. */
export const MARKET_SUBJECT = "MARKET"
export const BOOK_SUBJECT = "BOOK"
export const OWNER_SUBJECT = "OWNER"

export const OBSERVATION_KINDS = ["news", "setup", "price", "fill", "calendar", "session", "watch", "sweep", "owner"] as const
export type ObservationKind = (typeof OBSERVATION_KINDS)[number]

/** Something that might deserve a decision, scored by code. */
export type Observation = {
  id: string
  /** A symbol, MARKET_SUBJECT, BOOK_SUBJECT or OWNER_SUBJECT. */
  subject: string
  kind: ObservationKind
  priority: Priority
  /** 0-100, computed in code (a news item's severity, a watch's priority…). */
  salience: number
  /** One line for the brief and the dashboard. */
  summary: string
  /** The summary quotes outside text (a headline): the brief fences it as untrusted. */
  untrusted?: boolean
  /** Wakes the agent even inside the subject's cooldown: the agent asked for it (a watch) or the owner did. */
  urgent?: boolean
  /** `symbol`: the pair or ticker a market-wide observation is about (a setup among several). */
  refs: { item_ids?: string[]; trigger_id?: string; watch_id?: string; position_id?: string; symbol?: string }
  at: Date
}

export type AgentStepKind = "tool" | "answer" | "invalid"

/** One step of an episode: the model's thinking, then one tool call or the answer. */
export type AgentStepDoc = {
  n: number
  kind: AgentStepKind
  tool: string | null
  /** The model's label for the call (at most 25 words). */
  purpose: string | null
  /** The call's arguments as JSON (capped). */
  args: string | null
  /** What the tool returned (capped). */
  result: string | null
  /** The model's thinking before this step (capped); never read by code. */
  thinking: string | null
  ms: number
  prompt_tokens: number
  cached_tokens: number
  completion_tokens: number
  /** Generation speed the server measured, tokens/s. */
  gen_per_s: number
  error: string | null
}

export type EpisodeStatus = "running" | "answered" | "no_answer" | "invalid" | "aborted" | "failed"

/** What became of one decision in the answer: its fill, or why not. */
export type AgentActionOutcome = "filled" | "updated" | "held" | "rejected" | "blocked" | "not_applicable" | "read_only"

export type AgentAction = { symbol: string; action: string; conviction: number; outcome: AgentActionOutcome; detail: string | null }

/** One wake-up, as the dashboard reads it. The history store keeps the uncapped copy. */
export type AgentEpisodeDoc = {
  _id: string
  level: AgentLevel
  priority: Priority
  /** The subject that woke the agent. */
  subject: string
  observations: Observation[]
  /** The owner's question (OWNER_SUBJECT episodes). */
  question: string | null
  started_at: Date
  finished_at: Date | null
  duration_ms: number | null
  status: EpisodeStatus
  error: string | null
  /** The brief the model got (capped). */
  brief: string
  steps: AgentStepDoc[]
  /** The normalized answer: the bot's decisions, watches, notes and reply. */
  answer: unknown
  /** The answer's reply line: what the agent saw and did. */
  reply: string | null
  actions: AgentAction[]
  /** What became of the answer's watches and notes, one line each ("set: SOL/USD above 182", "refused: …"). */
  memory: string[]
  watches_set: number
  notes_set: number
  model: string
  prompt_version: string
  settings_version: number
  usage: TokenUsage
  /** TTL: episodes that traded are kept (null), the rest expire. */
  expires_at: Date | null
}

export const WATCH_KINDS = ["price_above", "price_below", "move_pct", "news", "time"] as const
export type WatchKind = (typeof WATCH_KINDS)[number]

export type WatchStatus = "active" | "fired" | "expired" | "canceled"

/** A condition the agent asked to be woken on. Code checks it on every price tick, item and minute. */
export type AgentWatchDoc = {
  _id: string
  episode_id: string
  kind: WatchKind
  /** The symbol, or null for news and time watches on the whole market. */
  symbol: string | null
  /** price_above / price_below: the price; move_pct: the move in % either way; news: the minimum severity. */
  level: number | null
  /** move_pct: the price when the watch was set. */
  ref_price: number | null
  /** time: when to wake. */
  at: Date | null
  priority: Priority
  /** What to check when it fires (at most 300 characters). */
  note: string
  status: WatchStatus
  created_at: Date
  expires_at: Date
  ended_at: Date | null
  /** TTL: removed 30 days after it ends. */
  purge_at: Date
}

/** "SOL/USD above 182": one line for briefs, events and the dashboard. */
export const describeWatch = (w: Pick<AgentWatchDoc, "kind" | "symbol" | "level" | "ref_price" | "at">) => {
  const subject = w.symbol ?? "the market"
  switch (w.kind) {
    case "price_above":
      return `${subject} above ${w.level}`
    case "price_below":
      return `${subject} below ${w.level}`
    case "move_pct":
      return `${subject} moves ${w.level}% from ${w.ref_price}`
    case "news":
      return `news on ${subject} at severity ${w.level}+`
    case "time":
      return `at ${w.at?.toISOString().slice(0, 16)}Z`
  }
}

/** The agent's working memory about a subject: shown in every brief on it. */
export type AgentNoteDoc = { _id: string; episode_id: string; subject: string; text: string; created_at: Date; expires_at: Date }

/** At most this many active watches per symbol and per bot, notes per subject; and their lengths and lifetimes. */
export const AGENT_LIMITS = {
  watches_per_symbol: 5,
  watches_total: 40,
  watch_note_chars: 300,
  watch_max_hours: 168,
  notes_per_subject: 5,
  note_chars: 500,
  note_days: 14,
} as const

/**
 * The parts of an agent's answer both bots share: watches, notes and the reply. Each bot's answer
 * is `z.object({ decisions: …, ...agentAnswerFields })`. As in the decision schemas, bounds are in
 * the descriptions and enforced by code afterwards (providers and grammars differ in which
 * JSON-schema keywords they accept).
 */
export const WATCH_PRIORITIES = ["risk", "opportunity", "review"] as const
export const WATCH_PRIORITY: Record<(typeof WATCH_PRIORITIES)[number], Priority> = { risk: 0, opportunity: 1, review: 2 }

export const watchRequestSchema = z.object({
  kind: z
    .enum(WATCH_KINDS)
    .describe(
      "price_above / price_below: wake when the symbol trades above / below `level`. move_pct: wake when it moves `level` % either way from now. news: wake when an item about the symbol (null = market-wide) reaches severity `level` (0-100). time: wake at `at`.",
    ),
  symbol: z.string().nullable().describe("The symbol exactly as listed. null only for news and time watches about the whole market."),
  level: z.number().nullable().describe("The price, the % move or the minimum severity, as `kind` says. null for time watches."),
  at: z.string().nullable().describe("time watches only: when to wake, as an ISO date-time with its offset. null otherwise."),
  hours: z.number().describe(`How long the watch lasts, 1-${AGENT_LIMITS.watch_max_hours} hours.`),
  priority: z.enum(WATCH_PRIORITIES).describe("risk = something you hold is in danger; opportunity = a possible entry; review = anything else."),
  note: z.string().describe(`At most ${AGENT_LIMITS.watch_note_chars} characters: what to check when it fires. You will see it then.`),
})
export type WatchRequest = z.infer<typeof watchRequestSchema>

export const noteRequestSchema = z.object({
  subject: z.string().describe(`A symbol exactly as listed, ${MARKET_SUBJECT} or ${BOOK_SUBJECT}.`),
  text: z.string().describe(`At most ${AGENT_LIMITS.note_chars} characters you want to see in your next brief on this subject (kept ${AGENT_LIMITS.note_days} days).`),
})
export type NoteRequest = z.infer<typeof noteRequestSchema>

export const agentAnswerFields = {
  watches: z.array(watchRequestSchema).describe("0-5 conditions to wake you on. Prefer a watch to deciding early."),
  cancel_watches: z.array(z.string()).describe("Ids of your own watches (from YOUR WATCHES) that no longer matter."),
  notes: z.array(noteRequestSchema).describe("0-3 notes for later: a level that matters, what you are waiting for, what you learned."),
  reply: z.string().describe("1-3 sentences in plain English: what you saw and what you did about it. To an owner's question: the answer."),
}

/** The fields the runtime reads from every bot's answer. */
export type AgentAnswerBase = { watches: WatchRequest[]; cancel_watches: string[]; notes: NoteRequest[]; reply: string }

/** The paper account the agent trades, summarized for the heartbeat, the breakers and the dashboard. */
export type BookAccount = {
  starting_usd: number
  cash_usd: number
  equity_usd: number
  exposure_usd: number
  realized_pnl_usd: number
  unrealized_pnl_usd: number
  return_pct: number
  open_positions: number
  closed_positions: number
}

/** The heartbeat's agent block (EngineStatusBase.agent). */
export type AgentStatus = {
  level: AgentLevel
  /** off: level off or no model; idle; queued: waiting (the reason is in `blocked`); running. */
  state: "off" | "idle" | "queued" | "running"
  blocked: string | null
  model: string
  episode: { id: string; subject: string; priority: Priority; started_at: Date; step: number } | null
  queue: { subject: string; priority: Priority; salience: number; observations: number }[]
  episodes_today: number
  last_episode_at: Date | null
  /** The error of the last episode that failed or answered invalid JSON, and when it finished; the next answered episode clears both. */
  last_error: string | null
  last_error_at: Date | null
  watches: number
  /** The latest step's generation speed, tokens/s. */
  tokens_per_s: number | null
  /** The paper account it trades. */
  account: BookAccount | null
  /** Circuit breakers tripped today: each pauses its new entries until the owner resumes them, except a slow model, which pauses them until it is fast again. */
  breakers: string[]
  /** Why the agent's new entries are paused (a breaker, a slow model), or null. Its exits carry on. */
  entries_paused: string | null
  /** A breaker's pause on new entries, which only the owner lifts (Admin → Resume entries), or null. */
  pause: { at: Date; reason: string } | null
}
