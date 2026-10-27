/**
 * CryptoMarketBot trades one venue in one mode: Kraken spot, paper only. Paper orders execute in
 * a Kraken CLI paper workspace (a simulated wallet filled at live Kraken prices). There is no
 * live-trading code path, and the engine holds no exchange credentials.
 *
 * `mode` is still stored on every account, position, order and fill, so records are
 * self-describing and labeled as paper everywhere they're shown.
 */

export const VENUE = "kraken" as const
export type Venue = typeof VENUE

export const MODE = "paper" as const
export type Mode = typeof MODE

export type AccountId = `${Venue}:${Mode}`
export const ACCOUNT_ID: AccountId = "kraken:paper"

/** Spot crypto pairs use Kraken WebSocket v2 naming ("BTC/USD"). */
export const SYMBOL_PATTERN = /^[A-Z0-9]{2,12}\/(USD|USDC|USDT)$/

/** "BTC/USD" → "BTC". */
export const baseAsset = (symbol: string) => symbol.split("/")[0]
