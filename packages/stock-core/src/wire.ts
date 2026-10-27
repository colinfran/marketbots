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
 * The news engine ("wire"): the shared document types (@mb/core/wire) bound to stock's
 * categories. Catalog ids look like "alpaca_news" or "edgar", and an item's symbols are tickers
 * (NVDA).
 */

/** Stock categories, with their starting severity base (tuned from `wire_triggers` after go-live). */
export const CATEGORY_BASE = {
  bankruptcy: 95,
  restatement: 90,
  delisting_notice: 80,
  halt: 75,
  m_and_a: 75,
  fda: 75,
  late_filing: 70,
  short_report: 70,
  guidance: 65,
  offering: 65,
  policy_shock: 65,
  earnings: 60,
  antitrust: 60,
  cyber_incident: 60,
  price_shock: 55,
  exec_departure: 50,
  index_change: 50,
  macro_release: 50,
  regulatory_action: 45,
  lawsuit: 40,
  odds_swing: 40,
  venue_outage: 40,
  insider_buy: 35,
  analyst_action: 30,
  sentiment_spike: 30,
  volume_shock: 25,
  venue_status: 20,
  general: 10,
} as const satisfies Record<string, number>

export type WireCategory = keyof typeof CATEGORY_BASE
export const WIRE_CATEGORIES = Object.keys(CATEGORY_BASE) as WireCategory[]

export type WireItemDoc = WireItemDocOf<WireCategory>

/** A compact item row for prompts, events and the cycle trail. */
export type DossierRow = DossierRowOf<WireCategory>
