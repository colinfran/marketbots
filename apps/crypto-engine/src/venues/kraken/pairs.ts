import { floorToStep, roundToStep } from "@mb/crypto-core/math"
import type { KrakenAssetPair } from "./types"

/**
 * Pair metadata from AssetPairs, normalized to WebSocket v2 names ("BTC/USD"). REST still uses
 * legacy codes (XXBTZUSD / XBTUSD), so every pair keeps both.
 */

export type PairInfo = {
  /** WebSocket v2 / display symbol, e.g. "BTC/USD". */
  symbol: string
  /** REST pair key, e.g. "XXBTZUSD". */
  restPair: string
  altname: string
  base: string
  quote: string
  priceDecimals: number
  lotDecimals: number
  tickSize: number
  lotStep: number
  orderMin: number
  costMin: number
  online: boolean
  /** Base-tier fees in bps (the account's actual tier may be lower). */
  takerFeeBps: number | null
  makerFeeBps: number | null
}

/** Kraken's legacy asset codes in wsname ("XBT/USD", "XDG/USD") vs v2's ("BTC/USD", "DOGE/USD"). */
const V2_NAMES: Record<string, string> = { XBT: "BTC", XDG: "DOGE" }

export const toV2Symbol = (wsname: string) =>
  wsname
    .split("/")
    .map((part) => V2_NAMES[part] ?? part)
    .join("/")

export const parsePairs = (raw: Record<string, KrakenAssetPair>): Map<string, PairInfo> => {
  const pairs = new Map<string, PairInfo>()
  for (const [key, p] of Object.entries(raw)) {
    if (!p.wsname) continue
    const symbol = toV2Symbol(p.wsname)
    const tick = Number(p.tick_size)
    pairs.set(symbol, {
      symbol,
      restPair: key,
      altname: p.altname,
      base: p.base,
      quote: p.quote,
      priceDecimals: p.pair_decimals,
      lotDecimals: p.lot_decimals,
      tickSize: Number.isFinite(tick) && tick > 0 ? tick : 10 ** -p.pair_decimals,
      lotStep: 10 ** -p.lot_decimals,
      orderMin: Number(p.ordermin ?? 0) || 0,
      costMin: Number(p.costmin ?? 0) || 0,
      online: (p.status ?? "online") === "online",
      takerFeeBps: p.fees?.[0] ? p.fees[0][1] * 100 : null,
      makerFeeBps: p.fees_maker?.[0] ? p.fees_maker[0][1] * 100 : null,
    })
  }
  return pairs
}

/** Rounds a quantity down to the pair's lot precision (never round size up). */
export const roundQty = (pair: PairInfo, qty: number) => floorToStep(qty, pair.lotStep)

export const roundPrice = (pair: PairInfo, price: number) => roundToStep(price, pair.tickSize)

export const formatPrice = (pair: PairInfo, price: number) => roundPrice(pair, price).toFixed(pair.priceDecimals)

export const formatQty = (pair: PairInfo, qty: number) => roundQty(pair, qty).toFixed(pair.lotDecimals)

/** Why an order of this size can't be placed on the pair, or null if it can. */
export const minimumViolation = (pair: PairInfo, qty: number, price: number): string | null => {
  if (qty <= 0) return "quantity rounds to zero at the pair's lot precision"
  if (pair.orderMin && qty < pair.orderMin) return `quantity ${qty} below Kraken minimum ${pair.orderMin} ${pair.symbol.split("/")[0]}`
  if (pair.costMin && qty * price < pair.costMin) return `order value $${(qty * price).toFixed(2)} below Kraken minimum $${pair.costMin}`
  return null
}
