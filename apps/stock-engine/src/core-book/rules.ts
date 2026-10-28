import type { AlpacaAsset } from "@mb/stock-core/alpaca"
import type { CoreAction, CoreHoldingDecision } from "@mb/stock-core/core-book"
import type { PositionPlanDoc } from "@mb/stock-core/db"
import type { RiskCheck } from "@mb/stock-core/events"
import { CORE_INDEX_ETFS, type CoreTheme, type Settings } from "@mb/stock-core/settings"

/**
 * The core book's rules, in code (docs/plans/CORE-BOOK.md §6). The AI proposes; this decides what
 * actually happens, and records every rule it evaluated:
 *
 * - every core holding gets exactly one decision: keep, trim or sell (left out = kept);
 * - sells and trims first, then buys by conviction, within `max_trades_per_review`;
 * - a buy needs: trading not blocked, no circuit breaker, a symbol not held in either book (v1
 *   never adds to a holding), `min_conviction`, a book below its target by more than `band_pct`,
 *   room under `max_holdings`, a tradable asset over `risk.min_price`, and whole shares;
 * - a buy's size is the AI's target weight clamped to the per-holding cap (`max_holding_pct`, or
 *   `max_index_etf_pct` for a broad-index ETF), the book's room to its target, the theme's room
 *   under `max_theme_pct` of the book, and the cash above the reserve; under CORE_MIN_WEIGHT_PCT
 *   it's rejected;
 * - a buy's stop is `stop_pct` below the price unless the AI gives a tighter level at least
 *   CORE_MIN_STOP_PCT below it; a keep may raise a stop, never lower it.
 */

/** A buy smaller than this (% of equity) isn't worth a core slot. */
export const CORE_MIN_WEIGHT_PCT = 2
/** A stop closer than this (% below the price) is a trading stop, not a long-term one. */
export const CORE_MIN_STOP_PCT = 3

export type CoreHolding = {
  symbol: string
  /** Whole shares held. */
  qty: number
  avg_entry: number
  price: number
  market_value: number
  plan: PositionPlanDoc
}

export type CoreRulesInput = {
  settings: Pick<Settings, "core" | "risk">
  equity: number
  cash: number
  holdings: CoreHolding[]
  /** Stocks held in the trading book: never bought by the core book. */
  tradingSymbols: ReadonlySet<string>
  /** Current prices for the symbols the AI named. */
  prices: ReadonlyMap<string, number>
  /** Alpaca's assets for the buys (null: Alpaca doesn't know the symbol). */
  assets: ReadonlyMap<string, AlpacaAsset | null>
  themes: CoreTheme[]
  circuitBreaker: boolean
  /** Why new entries are blocked (kill switch, pause), or null. */
  entriesBlocked: string | null
  decisions: CoreHoldingDecision[]
}

export type PlannedDecision = {
  symbol: string
  action: CoreAction
  request: CoreHoldingDecision | null
  /** Passed every rule; for a keep, always. */
  approved: boolean
  /** The first failed rule, or what's worth knowing about an approved one. */
  reason: string | null
  checks: RiskCheck[]
  weight_before_pct: number | null
  weight_after_pct: number | null
  price: number | null
  /** Shares to buy or sell. */
  qty: number | null
  notional: number | null
  /** The stop after the review. */
  stop: number | null
  /** A keep that raises the resting stop. */
  stop_changed: boolean
  /** The owner theme (its exact name), or null. */
  theme: string | null
}

const round2 = (n: number) => Math.round(n * 100) / 100
/** Cents, rounded down; the epsilon keeps 77.6 (7759.999… cents in binary) from becoming 77.59. */
const floor2 = (n: number) => Math.floor(n * 100 + 1e-9) / 100

/** The stop a new or adopted holding starts with: `stop_pct` below its entry, and at least CORE_MIN_STOP_PCT below the price. */
export const initialCoreStop = (entry: number, price: number, stopPct: number) => floor2(Math.min(entry * (1 - stopPct / 100), price * (1 - CORE_MIN_STOP_PCT / 100)))

export const isIndexEtf = (symbol: string) => (CORE_INDEX_ETFS as readonly string[]).includes(symbol)

/** The theme as the owner wrote it, matched without regard to case; null when it isn't one of theirs. */
export const resolveTheme = (themes: CoreTheme[], name: string | null | undefined) => (name ? (themes.find((t) => t.name.toLowerCase() === name.trim().toLowerCase())?.name ?? null) : null)

const ORDER: Record<CoreAction, number> = { sell: 0, trim: 1, buy: 2, keep: 3 }

export const planCoreReview = (i: CoreRulesInput): PlannedDecision[] => {
  const c = i.settings.core
  const weight = (value: number) => (i.equity > 0 ? (value / i.equity) * 100 : 0)
  const held = new Map(i.holdings.map((h) => [h.symbol, h]))
  const bySymbol = new Map<string, CoreHoldingDecision>()
  for (const d of i.decisions) if (!bySymbol.has(d.symbol)) bySymbol.set(d.symbol, d)
  let tradesLeft = c.max_trades_per_review
  let cash = i.cash
  const out: PlannedDecision[] = []

  const base = (symbol: string, action: CoreAction, request: CoreHoldingDecision | null, h?: CoreHolding): PlannedDecision => ({
    symbol,
    action,
    request,
    approved: false,
    reason: null,
    checks: [],
    weight_before_pct: h ? round2(weight(h.market_value)) : null,
    weight_after_pct: h ? round2(weight(h.market_value)) : null,
    price: h?.price ?? i.prices.get(symbol) ?? null,
    qty: null,
    notional: null,
    stop: h?.plan.stop_loss ?? null,
    stop_changed: false,
    theme: resolveTheme(i.themes, request?.theme) ?? (h ? (h.plan.theme ?? null) : null),
  })
  /** Records a rule; returns whether it passed. A failure rejects the decision with its detail. */
  const check = (p: PlannedDecision, name: string, ok: boolean, detail: string, failDetail = detail) => {
    p.checks.push({ name, ok, detail: ok ? detail : failDetail })
    if (!ok) {
      p.approved = false
      p.reason ??= failDetail
    }
    return ok
  }

  // ─── Holdings: sells, trims, keeps ───────────────────────────────────────
  const keeps: PlannedDecision[] = []
  for (const h of i.holdings) {
    const request = bySymbol.get(h.symbol) ?? null
    const action: CoreAction = request?.action === "sell" || request?.action === "trim" ? request.action : "keep"
    const p = base(h.symbol, action, request, h)
    if (action === "keep") {
      p.approved = true
      p.reason = !request ? "no decision returned; kept" : request.action === "buy" ? "already a core holding (v1 never adds to one); kept" : null
      // A keep may raise the stop, never lower it.
      const current = h.plan.stop_loss
      const wanted = request?.stop ?? null
      if (wanted !== null && wanted >= h.price * (1 - CORE_MIN_STOP_PCT / 100)) p.reason = [p.reason, `stop ${wanted} is within ${CORE_MIN_STOP_PCT}% of the price ${h.price}; kept ${current ?? "none"}`].filter(Boolean).join("; ")
      else if (wanted !== null && current !== null && wanted < current) p.reason = [p.reason, `stop ${wanted} is below the current ${current}; stops only move up`].filter(Boolean).join("; ")
      else if (wanted !== null && (current === null || wanted > current)) {
        p.stop = floor2(wanted)
        p.stop_changed = true
      }
      if (p.stop === null) {
        p.stop = initialCoreStop(h.avg_entry, h.price, c.stop_pct)
        p.stop_changed = true
      }
      keeps.push(p)
      continue
    }
    p.approved = true
    if (!check(p, "trade limit", tradesLeft > 0, `${tradesLeft} of ${c.max_trades_per_review} trades left`, `max ${c.max_trades_per_review} trades per review`)) {
      out.push(p)
      continue
    }
    if (action === "sell") {
      p.qty = h.qty
    } else {
      const target = request?.target_weight_pct ?? null
      if (!check(p, "target weight", target !== null, `trim to ${target}% of equity`, "no target_weight_pct for the trim")) {
        out.push(p)
        continue
      }
      const qty = Math.floor((h.market_value - (target! / 100) * i.equity) / h.price)
      if (!check(p, "below the current weight", qty >= 1, `${qty} shares above ${target}%`, `already at or within a share of ${target}% (now ${p.weight_before_pct}%)`)) {
        out.push(p)
        continue
      }
      p.qty = Math.min(qty, h.qty)
      if (p.qty === h.qty) p.reason = "the trim sells the whole holding"
    }
    p.notional = round2(p.qty * h.price)
    p.weight_after_pct = round2(weight((h.qty - p.qty) * h.price))
    if (p.weight_after_pct === 0) p.stop = null
    tradesLeft -= 1
    cash += p.notional
    out.push(p)
  }

  // ─── Decisions on symbols that aren't core holdings ──────────────────────
  const buys: PlannedDecision[] = []
  for (const d of bySymbol.values()) {
    if (held.has(d.symbol)) continue
    const p = base(d.symbol, d.action, d)
    if (d.action !== "buy") {
      check(p, "core holding", false, "", `${d.symbol} is not a core holding`)
      out.push(p)
    } else buys.push(p)
  }

  // ─── Buys, by conviction ─────────────────────────────────────────────────
  const remaining = (p: PlannedDecision) => p.weight_after_pct ?? 0
  const kept = [...out.filter((p) => held.has(p.symbol) && remaining(p) > 0), ...keeps]
  let book = kept.reduce((sum, p) => sum + remaining(p), 0)
  let count = kept.length
  const themeWeight = new Map<string, number>()
  for (const p of kept) if (p.theme) themeWeight.set(p.theme, (themeWeight.get(p.theme) ?? 0) + remaining(p))
  const bookBeforeBuys = book
  const reserve = (i.equity * i.settings.risk.cash_reserve_pct) / 100

  for (const p of buys.sort((a, b) => b.request!.conviction - a.request!.conviction || (b.request!.target_weight_pct ?? 0) - (a.request!.target_weight_pct ?? 0))) {
    const d = p.request!
    const price = p.price
    const asset = i.assets.get(d.symbol)
    const cap = isIndexEtf(d.symbol) ? c.max_index_etf_pct : c.max_holding_pct
    p.approved = true
    p.weight_before_pct = 0
    const ok =
      check(p, "engine", !i.entriesBlocked, "trading is running", i.entriesBlocked ?? "") &&
      check(p, "loss limits", !i.circuitBreaker, "no circuit breaker", "no core buys on a circuit-breaker day") &&
      check(p, "not held", !i.tradingSymbols.has(d.symbol), "a new holding", `${d.symbol} is held in the trading book`) &&
      check(p, "conviction", d.conviction >= c.min_conviction, `${d.conviction} ≥ ${c.min_conviction}`, `conviction ${d.conviction} < ${c.min_conviction}`) &&
      check(
        p,
        "book below target",
        bookBeforeBuys < c.target_pct - c.band_pct,
        `book ${round2(book)}% vs target ${c.target_pct}%`,
        `the book is ${round2(bookBeforeBuys)}% of equity, within ${c.band_pct} points of its ${c.target_pct}% target: no buys`,
      ) &&
      check(p, "holdings", count < c.max_holdings, `${count} of ${c.max_holdings}`, `max ${c.max_holdings} holdings`) &&
      check(p, "trade limit", tradesLeft > 0, `${tradesLeft} of ${c.max_trades_per_review} trades left`, `max ${c.max_trades_per_review} trades per review`) &&
      check(p, "tradable", !!asset && asset.tradable && asset.status === "active" && asset.class === "us_equity", "active US equity", "not tradable on Alpaca") &&
      check(p, "price", price !== null && price >= i.settings.risk.min_price, `$${price}`, price === null ? "no current price" : `price $${price} below $${i.settings.risk.min_price}`) &&
      check(p, "weight", d.target_weight_pct !== null, `${d.target_weight_pct}% asked`, "no target_weight_pct for the buy")
    if (!ok) {
      out.push(p)
      continue
    }
    const themeRoom = p.theme ? (c.max_theme_pct / 100) * c.target_pct - (themeWeight.get(p.theme) ?? 0) : Infinity
    const limits: [string, number][] = [
      [`${cap}% cap per ${isIndexEtf(d.symbol) ? "index ETF" : "holding"}`, cap],
      [`the book's room to its ${c.target_pct}% target`, c.target_pct - book],
      [`theme "${p.theme}" room under ${c.max_theme_pct}% of the book`, themeRoom],
      ["cash above the reserve", weight(Math.max(0, cash - reserve))],
    ]
    const [binding, room] = limits.reduce((min, l) => (l[1] < min[1] ? l : min))
    const size = Math.max(0, Math.min(d.target_weight_pct!, room))
    const qty = Math.floor(((size / 100) * i.equity) / price!)
    const sized = round2(weight(qty * price!))
    if (
      !check(
        p,
        "size",
        sized >= CORE_MIN_WEIGHT_PCT,
        `${qty} shares, ${sized}% of equity${size < d.target_weight_pct! ? ` (asked ${d.target_weight_pct}%, limited by ${binding})` : ""}`,
        `${sized}% of equity after ${binding} (minimum ${CORE_MIN_WEIGHT_PCT}%)`,
      )
    ) {
      out.push(p)
      continue
    }
    const floorStop = price! * (1 - c.stop_pct / 100)
    const tighter = d.stop !== null && d.stop >= floorStop && d.stop <= price! * (1 - CORE_MIN_STOP_PCT / 100)
    p.stop = tighter ? floor2(d.stop!) : floor2(floorStop)
    check(p, "stop", true, tighter ? `stop ${p.stop} (a daily level)` : `stop ${p.stop}, ${c.stop_pct}% below${d.stop !== null ? ` (asked ${d.stop}: not between ${floor2(floorStop)} and ${floor2(price! * (1 - CORE_MIN_STOP_PCT / 100))})` : ""}`)
    p.qty = qty
    p.notional = round2(qty * price!)
    p.weight_after_pct = sized
    book += sized
    count += 1
    tradesLeft -= 1
    cash -= p.notional
    if (p.theme) themeWeight.set(p.theme, (themeWeight.get(p.theme) ?? 0) + sized)
    out.push(p)
  }

  return [...out, ...keeps].sort((a, b) => ORDER[a.action] - ORDER[b.action] || (b.request?.conviction ?? 0) - (a.request?.conviction ?? 0))
}
