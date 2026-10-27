/**
 * The long-term core book (docs/plans/CORE-BOOK.md): a share of equity in a handful of holdings,
 * each with a written thesis, reviewed weekly. These are the shapes the engine writes and the
 * dashboard reads.
 *
 * The ranking is built once per trading day from a year of consolidated daily bars, in code: the
 * numbers each candidate is judged on, a trend filter and a momentum score. The weekly review
 * hands the top of it to Grok; the dashboard's Core page shows all of it.
 */

/** Where the ranking keeps today's list in the `cache` collection. */
export const CORE_RANKING_KEY = "core:ranking"

/** Ranked candidates the review sees, on top of every theme ticker and holding. */
export const CORE_TOP_CANDIDATES = 25

/** Long-term numbers for one symbol, from completed sessions only. Percentages are in percent. */
export type CoreMetrics = {
  symbol: string
  name: string | null
  /** The last completed session's close. */
  price: number
  /** Daily bars available (a year is about 252). */
  sessions: number
  sma50: number | null
  sma200: number | null
  /** Positive = above the average. */
  pct_from_sma50: number | null
  pct_from_sma200: number | null
  return_3m_pct: number | null
  return_6m_pct: number | null
  return_12m_pct: number | null
  /** The 12-month return without the last month: the standard momentum measure. */
  return_12_1_pct: number | null
  /** The return minus SPY's over the same sessions, in points. */
  rel_spy_3m_pct: number | null
  rel_spy_6m_pct: number | null
  rel_spy_12m_pct: number | null
  /** Distance below the 52-week high (0 = at the high). */
  from_52w_high_pct: number | null
  /** Annualized volatility of the last 60 daily returns. */
  volatility_60d_pct: number | null
  /** Worst fall from a closing peak over the last year (negative). */
  max_drawdown_1y_pct: number | null
  /** Mean close × volume over the last 20 sessions, in dollars. */
  dollar_volume_20d: number | null
}

/** Why a symbol is a candidate: the scan universe's top names, a benchmark ETF, an owner theme, or a holding. */
export type CoreCandidateSource = "universe" | "benchmark" | "theme" | "held"

export type CoreRankRow = CoreMetrics & {
  sources: CoreCandidateSource[]
  /** The owner's themes that name this symbol. */
  themes: string[]
  /** Price above the 200-day average and the 50-day above the 200-day. */
  trend_ok: boolean
  /**
   * 0-100, among the names that pass the trend filter: the mean percentile of the risk-adjusted
   * 12-1 month return and the risk-adjusted 6-month return (each divided by the 60-day
   * volatility). null for names that fail the filter or lack a year of data.
   */
  score: number | null
  /** 1 = the best score; null when unscored. */
  rank: number | null
}

export type CoreRanking = {
  /** The New York trading day it was built for. */
  day: string
  built_at: Date
  /** The last completed session in the bars. */
  as_of: string | null
  /** The scan universe's day the candidates came from (null when there was none). */
  universe_day: string | null
  /** Ranked names first (best first), then the rest by symbol. */
  rows: CoreRankRow[]
  /** Candidates left out, and why. */
  excluded: { symbol: string; reason: string }[]
}
