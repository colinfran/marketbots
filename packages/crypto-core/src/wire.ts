/**
 * The news engine ("wire"): shared document types for what the engine ingests from news,
 * regulators, venues, calendars and its own market-data anomaly detectors, and for the triggers
 * those items fire. The engine writes them; the dashboard reads them (Research and Live pages).
 *
 * Everything in an item came from outside and is untrusted: titles and summaries are sanitized and
 * length-capped before storage, and rendered as plain text. Time-sensitive logic always uses
 * `first_seen_at` (when we ingested it), never `published_at` (what the source claims).
 *
 * Shape mirrored in cryptomarketbot and stockmarketbot; the category list differs per bot.
 */

/** 1 = primary or official (regulator, venue, issuer, our own market data), 2 = major outlet or wire, 3 = aggregator, social or unknown. */
export type WireTier = 1 | 2 | 3

export const WIRE_KINDS = ["news", "filing", "venue", "macro", "derivatives", "anomaly", "calendar", "sentiment"] as const
export type WireKind = (typeof WIRE_KINDS)[number]

/** Crypto categories, with their starting severity base (tuned from `wire_triggers` after go-live). */
export const CATEGORY_BASE = {
  exploit: 85,
  depeg: 85,
  etf_decision: 75,
  regulatory_action: 70,
  listing_major: 70,
  tvl_drop: 70,
  venue_status: 60,
  venue_outage: 60,
  price_shock: 55,
  macro_release: 50,
  liquidation_cascade: 50,
  unlock_large: 45,
  treasury_buy: 45,
  volume_shock: 40,
  funding_extreme: 40,
  odds_swing: 40,
  upgrade: 35,
  coinbase_premium: 30,
  sentiment_spike: 30,
  partnership: 25,
  general: 10,
} as const satisfies Record<string, number>

export type WireCategory = keyof typeof CATEGORY_BASE
export const WIRE_CATEGORIES = Object.keys(CATEGORY_BASE) as WireCategory[]

export const TIER_FACTOR: Record<WireTier, number> = { 1: 1, 2: 0.85, 3: 0.6 }

export const NOTABLE_REASONS = ["triggered", "held", "focus", "market", "cited"] as const
export type NotableReason = (typeof NOTABLE_REASONS)[number]

export type WireItemDoc = {
  /** Dedupe id: sha256(source + canonical URL or the source's own id). */
  _id: string
  /** `_id` of the first item in its near-duplicate cluster (itself when it is the first). */
  cluster_id: string
  /** Catalog id, e.g. "rss:coindesk", "finnhub_crypto", "anomaly". */
  source: string
  tier: WireTier
  kind: WireKind
  category: WireCategory
  title: string
  summary: string | null
  url: string | null
  domain: string | null
  /** Bot symbols (BTC/USD); [] = market-wide. */
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
  event_queue: string[]
}

/** What an event cycle focuses on: one symbol (or market-wide), the rule and the items behind it. */
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
export type DossierRow = {
  id: string
  at: string
  source: string
  tier: WireTier
  category: WireCategory
  title: string
  url: string | null
  severity: number
  symbols: string[]
}
