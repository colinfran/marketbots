import type { OptionContract, OptionSnapshot } from "@mb/stock-core/alpaca"
import type { ChainContract, OptionChainContext } from "@mb/stock-core/context"
import type { OptionLeg } from "@mb/stock-core/db"
import { roundTo } from "@mb/stock-core/math"
import { daysToExpiry } from "@mb/stock-core/options"
import type { OptionsSettings } from "@mb/stock-core/settings"
import { addDays } from "@mb/stock-core/time"
import type { Alpaca } from "../alpaca/client"

/**
 * Option chains for the AI. A full chain is thousands of contracts, so code narrows it to a short
 * menu of liquid ones per underlying: inside the allowed days-to-expiration window, strikes within
 * ±25% of the price, a two-sided quote no wider than the spread limit, enough open interest, and a
 * spread of deltas (so both the contract to buy and a spread's short leg are on the menu). The AI
 * can only pick from this menu; anything else is rejected.
 */

const STRIKE_WINDOW = 0.25
/** Wider than the buy band so spreads' short legs (lower delta) are available. */
const MENU_DELTA = [0.12, 0.85] as const

export const toChainContract = (contract: OptionContract, snap: OptionSnapshot | undefined, today: string): ChainContract | null => {
  const q = snap?.latestQuote
  if (!q || !(q.bp > 0) || !(q.ap >= q.bp)) return null
  const mid = (q.bp + q.ap) / 2
  const oi = contract.open_interest != null ? Number(contract.open_interest) : null
  return {
    symbol: contract.symbol,
    type: contract.type,
    expiration: contract.expiration_date,
    dte: daysToExpiry(contract.expiration_date, today),
    strike: Number(contract.strike_price),
    bid: q.bp,
    ask: q.ap,
    mid: roundTo(mid, 3),
    spread_pct: roundTo(((q.ap - q.bp) / mid) * 100, 1),
    delta: snap?.greeks ? roundTo(snap.greeks.delta, 3) : null,
    iv: snap?.impliedVolatility != null ? roundTo(snap.impliedVolatility, 3) : null,
    open_interest: oi !== null && Number.isFinite(oi) ? oi : null,
  }
}

/** Picks `n` items spread evenly across a sorted list (always keeping both ends). */
const spreadEvenly = <T>(items: T[], n: number): T[] => {
  if (items.length <= n) return items
  if (n <= 1) return [items[Math.floor(items.length / 2)]]
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))])
}

/**
 * The menu for one underlying: for calls and puts separately, the (up to) two expirations closest
 * to the middle of the DTE window, then strikes spread across the usable delta range.
 */
export const buildMenu = (contracts: ChainContract[], s: Pick<OptionsSettings, "min_dte" | "max_dte" | "max_spread_pct" | "min_open_interest" | "contracts_per_underlying">): ChainContract[] => {
  const liquid = contracts.filter(
    (c) =>
      c.dte >= s.min_dte &&
      c.dte <= s.max_dte &&
      c.spread_pct <= s.max_spread_pct &&
      (s.min_open_interest === 0 || (c.open_interest ?? 0) >= s.min_open_interest) &&
      c.delta !== null &&
      Math.abs(c.delta) >= MENU_DELTA[0] &&
      Math.abs(c.delta) <= MENU_DELTA[1],
  )
  const target = (s.min_dte + s.max_dte) / 2
  const perType = Math.max(1, Math.floor(s.contracts_per_underlying / 2))
  return (["call", "put"] as const).flatMap((type) => {
    const ofType = liquid.filter((c) => c.type === type)
    const expirations = [...new Set(ofType.map((c) => c.expiration))].sort((a, b) => Math.abs(daysOf(ofType, a) - target) - Math.abs(daysOf(ofType, b) - target)).slice(0, 2).sort()
    const perExpiration = Math.max(1, Math.floor(perType / Math.max(1, expirations.length)))
    return expirations.flatMap((exp) => spreadEvenly(ofType.filter((c) => c.expiration === exp).sort((a, b) => a.strike - b.strike), perExpiration))
  })
}

const daysOf = (list: ChainContract[], expiration: string) => list.find((c) => c.expiration === expiration)?.dte ?? 0

/** Loads the menu for one underlying (two requests: listed contracts for open interest, snapshots for quotes and greeks). */
export const loadChain = async (
  alpaca: Pick<Alpaca, "getOptionContracts" | "getOptionChain">,
  underlying: string,
  price: number,
  today: string,
  s: OptionsSettings,
): Promise<OptionChainContext> => {
  const window = {
    expiration_date_gte: addDays(today, s.min_dte),
    expiration_date_lte: addDays(today, s.max_dte),
    strike_price_gte: roundTo(price * (1 - STRIKE_WINDOW), 2),
    strike_price_lte: roundTo(price * (1 + STRIKE_WINDOW), 2),
  }
  const [contracts, snapshots] = await Promise.all([alpaca.getOptionContracts({ underlying_symbols: underlying, ...window }), alpaca.getOptionChain(underlying, window)])
  const rows = contracts
    .filter((c) => c.tradable && c.status === "active" && c.underlying_symbol === underlying && (c.style ?? "american") === "american")
    .map((c) => toChainContract(c, snapshots[c.symbol], today))
    .filter((c): c is ChainContract => c !== null)
  return { underlying, price, contracts: buildMenu(rows, s) }
}

export type StructureQuote = {
  /** Net midpoint per share (long legs minus short legs). */
  mid: number
  /** Net value selling long legs at the bid and buying back short legs at the ask. */
  exitValue: number
  /** Net cost buying long legs at the ask and selling short legs at the bid. */
  entryValue: number
  delta: number | null
}

/** Prices a structure from its legs' quotes. null if any leg lacks a two-sided quote. */
export const structureQuote = (legs: Pick<OptionLeg, "symbol" | "side">[], snapshots: Record<string, OptionSnapshot | undefined>): StructureQuote | null => {
  let mid = 0
  let exitValue = 0
  let entryValue = 0
  let delta: number | null = 0
  for (const leg of legs) {
    const s = snapshots[leg.symbol]
    const q = s?.latestQuote
    if (!q || !(q.ap > 0) || q.bp < 0 || q.ap < q.bp) return null
    const sign = leg.side === "long" ? 1 : -1
    mid += sign * ((q.bp + q.ap) / 2)
    exitValue += leg.side === "long" ? q.bp : -q.ap
    entryValue += leg.side === "long" ? q.ap : -q.bp
    delta = delta !== null && s?.greeks ? delta + sign * s.greeks.delta : null
  }
  return { mid: roundTo(mid, 4), exitValue: roundTo(exitValue, 4), entryValue: roundTo(entryValue, 4), delta: delta === null ? null : roundTo(delta, 3) }
}
