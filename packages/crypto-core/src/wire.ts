import type { DossierRow as DossierRowOf, WireItemDoc as WireItemDocOf } from "@mb/core/wire"

export { NOTABLE_REASONS, TIER_FACTOR, WIRE_KINDS } from "@mb/core/wire"
export type {
  EventFocus,
  NotableReason,
  TriggerRequest,
  WireKind,
  WireSourceHealth,
  WireSourceState,
  WireStatus,
  WireTier,
  WireTriggerAction,
  WireTriggerDoc,
  WireTriggerStatus,
} from "@mb/core/wire"

/**
 * The news engine ("wire"): the shared document types (@mb/core/wire) bound to crypto's
 * categories. Catalog ids look like "rss:coindesk" or "finnhub_crypto", and an item's symbols are
 * bot symbols (BTC/USD).
 */

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

export type WireItemDoc = WireItemDocOf<WireCategory>

/** A compact item row for prompts, events and the cycle trail. */
export type DossierRow = DossierRowOf<WireCategory>
