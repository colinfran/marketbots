/**
 * Fee model. Costs are part of every edge calculation: a trade that only works before fees is
 * rejected. The Kraken CLI paper wallet charges `cost × fee_rate` on every fill (taker-style),
 * where `fee_rate` is fixed per workspace.
 */

/** Fee on a notional, from a basis-point rate (e.g. 40 bps = 0.40%). */
export const krakenFee = (notionalUsd: number, feeBps: number) => (notionalUsd * feeBps) / 10_000
