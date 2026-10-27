import type { AlpacaPosition } from "@mb/stock-core/alpaca"
import { bookOf, type OptionPositionDoc, type PositionPlanDoc } from "@mb/stock-core/db"
import { OPTION_MULTIPLIER } from "@mb/stock-core/options"
import type { Settings } from "@mb/stock-core/settings"

/**
 * The two books side by side (docs/plans/CORE-BOOK.md §8). While the core book is on, its holdings
 * (plans with `book: "core"`) belong to the weekly core review: the trading cycles see them
 * read-only, never trade them, and leave room for the book's target share of equity. When the
 * owner turns the book off, they're ordinary positions again.
 */

/** Symbols the trading cycles must leave alone: the core book's holdings, while it's on. */
export const coreHeld = (plans: Pick<PositionPlanDoc, "_id" | "book">[], settings: Pick<Settings, "core">): Set<string> =>
  new Set(settings.core.enabled ? plans.filter((p) => bookOf(p) === "core").map((p) => p._id) : [])

/** What the trading book has at risk: its stock positions at market, plus the options it holds (at their mark, else their cost). */
export const tradingExposure = (stocks: Pick<AlpacaPosition, "market_value">[], options: Pick<OptionPositionDoc, "mark" | "qty" | "cost_usd">[]) =>
  stocks.reduce((sum, p) => sum + Number(p.market_value), 0) + options.reduce((sum, o) => sum + (o.mark ? o.mark.value * OPTION_MULTIPLIER * o.qty : (o.cost_usd ?? 0)), 0)

/** The most of equity the trading book may hold while the core book is on, %. */
export const tradingCapPct = (settings: Pick<Settings, "core" | "risk">) => 100 - settings.core.target_pct - settings.risk.cash_reserve_pct
