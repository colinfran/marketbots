import { oddsSources, polymarketMarkets as polymarketMarketsOf, type PmEvent } from "@mb/wire/sources/odds"

export { kalshiMarkets, swingItems } from "@mb/wire/sources/odds"

/**
 * Prediction-market odds on the macro calendar (MASTER_PLAN §4.2 wave 2), on the shared source
 * (@mb/wire/sources/odds): a market's probability moving at least `odds_swing_pts` points within
 * an hour → `odds_swing`, market-wide.
 *
 *   odds:polymarket  Gamma API events tagged `fed-rates` and `economy`: Fed, CPI and inflation,
 *                    recession, jobs, tariffs and shutdown markets. Price and market-cap bets
 *                    ("largest company", "close above") and Treasury-yield ladders are left out.
 *   odds:kalshi      KXFED (the fed funds target after the next two FOMC meetings), KXCPI (monthly
 *                    CPI strikes) and KXRECSSNBER (recession this year and next).
 */

const MACRO = /\b(fed|fomc|federal reserve|interest rates?|rate (cut|hike)s?|bps|cpi|inflation|recession|gdp|unemployment|jobs report|payrolls|tariffs?|trade (deal|war)|government shutdown|shutdown|debt ceiling)\b/i
const NOT_MACRO = /\b(treasury|yields?|largest company|market cap|stock|shares|close (above|below)|price of)\b/i

const selects = (question: string) => MACRO.test(question) && !NOT_MACRO.test(question)

/** Liquid, open macro markets from Gamma events (an event listed under both tags counts once). */
export const polymarketMarkets = (events: PmEvent[], now: Date) => polymarketMarketsOf(events, now, selects)

/** Series read, and the open interest (contracts) a strike needs: CPI strikes are thinner than Fed and recession markets. */
export const KALSHI_SERIES = [
  { series: "KXFED", minOpenInterest: 10_000 },
  { series: "KXCPI", minOpenInterest: 3_000 },
  { series: "KXRECSSNBER", minOpenInterest: 10_000 },
] as const

export const ODDS_SOURCES = oddsSources({
  polymarket: {
    tags: [
      { slug: "fed-rates", limit: 10 },
      { slug: "economy", limit: 20 },
    ],
    selects,
    note: "Polymarket Gamma: Fed, inflation, recession, tariff and shutdown markets (no price bets), liquidity ≥ $25K and ≥ $5K traded in 24 h",
  },
  kalshi: { series: KALSHI_SERIES, note: "Kalshi KXFED (next two FOMC meetings), KXCPI and KXRECSSNBER; spread ≤ 10¢ and enough open interest" },
})
