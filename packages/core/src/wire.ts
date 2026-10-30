/**
 * The news engine ("wire"): document types for what an engine ingests from news, regulators,
 * venues, calendars and its own market-data anomaly detectors, and for the triggers those items
 * fire. The engine writes them; the dashboard reads them (News and Live pages).
 *
 * Everything in an item came from outside and is untrusted: titles and summaries are sanitized and
 * length-capped before storage, and rendered as plain text. Time-sensitive logic always uses
 * `first_seen_at` (when we ingested it), never `published_at` (what the source claims).
 *
 * The shapes are the same in both bots; only the category list differs. Each bot defines its
 * categories with their severity bases (`CATEGORY_BASE`) and binds the types below to them.
 */

/** 1 = primary or official (regulator, venue, issuer, our own market data), 2 = major outlet or wire, 3 = aggregator, social or unknown. */
export type WireTier = 1 | 2 | 3

export const WIRE_KINDS = ["news", "filing", "venue", "macro", "derivatives", "anomaly", "calendar", "sentiment"] as const
export type WireKind = (typeof WIRE_KINDS)[number]

export const TIER_FACTOR: Record<WireTier, number> = { 1: 1, 2: 0.85, 3: 0.6 }

export const NOTABLE_REASONS = ["triggered", "held", "focus", "market", "cited"] as const
export type NotableReason = (typeof NOTABLE_REASONS)[number]

/** A stored wire item, for a bot whose categories are `Category`. */
export type WireItemDoc<Category extends string> = {
  /** Dedupe id: sha256(source + canonical URL or the source's own id). */
  _id: string
  /** `_id` of the first item in its near-duplicate cluster (itself when it is the first). */
  cluster_id: string
  /** Catalog id, e.g. "anomaly". */
  source: string
  tier: WireTier
  kind: WireKind
  category: Category
  title: string
  summary: string | null
  url: string | null
  domain: string | null
  /** The bot's symbols; [] = market-wide. */
  symbols: string[]
  published_at: Date
  first_seen_at: Date
  /** Routing hint only: the AI judges direction. */
  polarity: -1 | 0 | 1
  severity: number
  severity_parts: Record<string, number>
  /** Later copies of the same story from other domains (identical syndicated titles count once). */
  confirmations: { domain: string; url: string | null; at: Date }[]
  /** symbol → mid at first_seen_at, when a live quote existed. */
  price_at_seen: Record<string, number>
  meta: Record<string, string | number | boolean | null>
  /** Shown on the Live page. Can flip to true later (triggered, cited), never back. */
  notable: boolean
  notable_reasons: NotableReason[]
  expires_at: Date
  /** A machine summary of the article behind the item (@mb/wire/enrich), once one was tried. */
  article?: WireArticle
}

/**
 * ok: summarized, and every number in it occurs in the article. skipped: not an article we
 * summarize (paywall, robots.txt, too short, not English). failed: the page or the model's answer
 * was unusable. rejected: the summary named a number the article doesn't have, or ran too long.
 */
export type WireArticleStatus = "ok" | "skipped" | "failed" | "rejected"

/**
 * The outcome of summarizing an item's article with the local model. Only
 * the summary is stored, never the article text. A machine summary can still put a number the
 * article does contain on the wrong thing, so it is always shown as one, with the article's link.
 */
export type WireArticle = {
  status: WireArticleStatus
  reason?: string
  summary?: string
  key_points?: string[]
  /** The whole article's length, as the scraper counted it. */
  words?: number
  /** The model that wrote it (or would have): the local server's alias, e.g. qwen3.6-35b-a3b-q2; llama3.2:3b before 2026-10-28. */
  model: string
  /** Time spent on the item: extraction plus summary. */
  ms: number
  at: Date
}

export type WireTriggerAction = "review" | "evaluate" | "gap_fill" | "market_review" | "emergency" | "alert_only"
export type WireTriggerStatus = "fired" | "queued" | "suppressed" | "shadow"

export type WireTriggerDoc = {
  _id: string
  at: Date
  /** Policy rule id, e.g. "held_negative". */
  rule: string
  action: WireTriggerAction
  status: WireTriggerStatus
  /** Why it fired, or why it was suppressed (cooldown, cap, budget, unconfirmed, mode…). */
  reason: string
  item_ids: string[]
  symbols: string[]
  severity: number
  cycle_id: string | null
  queue_wait_ms: number | null
  expires_at: Date
}

export type WireSourceState = "starting" | "ok" | "degraded" | "down" | "disabled"

export type WireSourceHealth = {
  id: string
  state: WireSourceState
  last_item_at: Date | null
  last_ok_at: Date | null
  last_error: string | null
  items_24h: number
  dropped_24h: number
  /** Seconds between an item's published_at and first_seen_at, for the latest item. */
  lag_s: number | null
  /** A short status line, e.g. a price feed's symbol count and data age. */
  detail?: string | null
}

/** The heartbeat's wire block (EngineStatusDoc.wire). */
export type WireStatus = {
  mode: "off" | "shadow" | "live"
  sources: WireSourceHealth[]
  items_last_hour: number
  triggers_today: number
}

/** What a trigger is about: one symbol (or market-wide), the rule and the items behind it. */
export type EventFocus = {
  symbol: string | null
  rule: string
  action: WireTriggerAction
  severity: number
  polarity: -1 | 0 | 1
  item_ids: string[]
  trigger_id: string
  /** One-line description for prompts and the dashboard. */
  headline: string
}

/** A trigger the policy wants acted on, handed to the engine. */
export type TriggerRequest = { focus: EventFocus; requested_at: Date }

/** A compact item row for prompts, events and the cycle trail. */
export type DossierRow<Category extends string> = {
  id: string
  at: string
  source: string
  tier: WireTier
  category: Category
  title: string
  url: string | null
  severity: number
  symbols: string[]
}
