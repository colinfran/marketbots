/** Kraken Spot REST response shapes (only the fields the engine uses). */

export type KrakenEnvelope<T> = { error: string[]; result?: T }

export type KrakenAssetPair = {
  altname: string
  wsname?: string
  base: string
  quote: string
  pair_decimals: number
  cost_decimals?: number
  lot_decimals: number
  tick_size?: string
  ordermin?: string
  costmin?: string
  status?: string
  fees?: [number, number][]
  fees_maker?: [number, number][]
}

/** OHLC row: [time, open, high, low, close, vwap, volume, count]; prices are strings. */
export type KrakenOhlcRow = [number, string, string, string, string, string, string, number]

export type KrakenTicker = {
  a: [string, string, string]
  b: [string, string, string]
  c: [string, string]
  v: [string, string]
  p: [string, string]
  t: [number, number]
  l: [string, string]
  h: [string, string]
  o: string
}

export type KrakenSystemStatus = { status: "online" | "maintenance" | "cancel_only" | "post_only" | "limit_only"; timestamp: string }
