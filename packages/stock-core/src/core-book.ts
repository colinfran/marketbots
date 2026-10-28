import { z } from "zod"
import { cleanTicker } from "./report"

/**
 * The long-term core book (docs/plans/CORE-BOOK.md): a share of equity in a handful of holdings,
 * each with a written thesis, reviewed weekly. These are the shapes the engine writes and the
 * dashboard reads.
 *
 * The ranking is built once per trading day from a year of consolidated daily bars, in code: the
 * numbers each candidate is judged on, a trend filter and a momentum score. The weekly review
 * hands the top of it to the AI; the dashboard's Core page shows all of it.
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

// ─── The review's AI output ──────────────────────────────────────────────────
//
// Like the cycle report, the schema sent to the model avoids numeric and array bound keywords
// (providers differ in which they accept). Bounds are in the descriptions and applied afterwards by
// `normalizeCoreReview`; the book's rules (caps, cash, trade limit, stops) are enforced in code.

export const CORE_ACTIONS = ["keep", "buy", "trim", "sell"] as const
export type CoreAction = (typeof CORE_ACTIONS)[number]

const ticker = z.string().describe("US-listed ticker in uppercase, e.g. NVDA. No exchange prefix, no $.")

export const coreHoldingSchema = z.object({
  symbol: ticker,
  action: z
    .enum(CORE_ACTIONS)
    .describe("keep = hold it as it is (you may raise its stop). buy = open a NEW core holding (never add to one). trim = sell part of a holding down to target_weight_pct. sell = sell the whole holding."),
  target_weight_pct: z.number().nullable().describe("% of total account equity. buy: the size to buy. trim: the weight to trim down to. keep: the weight you'd want it at (no trade). sell: null."),
  conviction: z.number().describe("1-10. Buys below the minimum in CONTEXT are rejected."),
  thesis: z.string().describe("2-4 sentences: why own this for months, with evidence from RESEARCH (earnings, guidance, capex, demand) and numbers from CONTEXT. For a holding: the case as it stands today."),
  invalidation: z.string().describe("The specific, checkable development that would prove the thesis wrong, e.g. 'hyperscaler capex guidance cut'. Not a price: the stop covers price."),
  verdict: z.string().describe("One sentence for the holding's history: what this review found and why this action."),
  theme: z.string().nullable().describe("The owner theme this holding serves, copied exactly from THEMES, or null."),
  stop: z.number().nullable().describe("Stop price in dollars. buy: a daily support level below the price, or null for the default. keep: a higher stop to lock in gains, or null to leave it. Never below the current stop."),
  evidence: z.array(z.string()).describe("2-5 concrete facts with numbers and dates."),
})

export const coreWatchSchema = z.object({
  symbol: ticker,
  reason: z.string().describe("One sentence: why it's interesting."),
  trigger: z.string().describe("What would make it a buy at a later review."),
})

export const coreReviewSchema = z.object({
  summary: z.string().describe("3-6 sentences in plain English: the plan for the core book and why."),
  holdings: z.array(coreHoldingSchema).describe("Exactly one entry for every current core holding (keep, trim or sell), plus any new buys."),
  watch: z.array(coreWatchSchema).describe("0-8 names you like but are not buying now; the next review sees them."),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).describe("URLs actually used, max 10."),
})

export type CoreReviewOutput = z.infer<typeof coreReviewSchema>
export type CoreHoldingDecision = z.infer<typeof coreHoldingSchema>
export type CoreWatchItem = z.infer<typeof coreWatchSchema>

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const round2 = (value: number) => Math.round(value * 100) / 100
const positive = (value: number | null) => (value !== null && Number.isFinite(value) && value > 0 ? value : null)
const truncate = (value: string, max: number) => {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
const isUrl = (value: string) => /^https?:\/\//i.test(value)

/** Applies the bounds the schema describes but does not enforce: one entry per symbol (the first wins), weights 0-100, conviction 1-10. */
export const normalizeCoreReview = (o: CoreReviewOutput): CoreReviewOutput => {
  const seen = new Set<string>()
  const once = (symbol: string) => (seen.has(symbol) ? false : (seen.add(symbol), true))
  const holdings = o.holdings
    .map((h) => {
      const weight = positive(h.target_weight_pct)
      const stop = positive(h.stop)
      return {
        ...h,
        symbol: cleanTicker(h.symbol),
        target_weight_pct: h.action === "sell" || weight === null ? null : round2(clamp(weight, 0, 100)),
        conviction: clamp(Math.round(h.conviction), 1, 10),
        thesis: truncate(h.thesis, 1_200),
        invalidation: truncate(h.invalidation, 400),
        verdict: truncate(h.verdict, 300),
        theme: h.theme?.trim() || null,
        stop: stop === null ? null : round2(stop),
        evidence: h.evidence.slice(0, 5),
      }
    })
    .filter((h) => once(h.symbol))
  seen.clear()
  return {
    summary: truncate(o.summary, 2_000),
    holdings,
    watch: o.watch
      .map((w) => ({ symbol: cleanTicker(w.symbol), reason: truncate(w.reason, 300), trigger: truncate(w.trigger, 300) }))
      .filter((w) => once(w.symbol))
      .slice(0, 8),
    sources: o.sources.filter((s) => isUrl(s.url)).slice(0, 10),
  }
}

// ─── What the review sees ────────────────────────────────────────────────────

/** A core holding as the review sees it. */
export type CoreHoldingContext = {
  symbol: string
  name: string | null
  theme: string | null
  qty: number
  avg_entry: number
  price: number
  weight_pct: number
  pnl_pct: number
  stop: number | null
  /** How far the stop sits below the price, %. */
  stop_below_pct: number | null
  opened_on: string
  thesis: string
  invalidation: string
  /** The latest review notes, oldest first. */
  notes: { on: string; action: string; text: string }[]
  /** Its long-term numbers, when the ranking has them. */
  metrics: Omit<CoreRankRow, "symbol" | "name" | "sources" | "themes" | "sessions" | "dollar_volume_20d"> | null
}

/** A ranked (or theme, or held) candidate as the review sees it. */
export type CoreCandidateContext = Pick<
  CoreRankRow,
  | "symbol"
  | "name"
  | "rank"
  | "score"
  | "trend_ok"
  | "price"
  | "pct_from_sma200"
  | "return_3m_pct"
  | "return_6m_pct"
  | "return_12_1_pct"
  | "rel_spy_6m_pct"
  | "rel_spy_12m_pct"
  | "from_52w_high_pct"
  | "volatility_60d_pct"
  | "max_drawdown_1y_pct"
  | "themes"
>

/** The factual snapshot the review is given (stored with it). Percentages are of equity unless named otherwise. */
export type CoreReviewContext = {
  now_et: string
  trading_day: string
  kind: "weekly" | "holding"
  /** This is the book's first review (it holds what the one-time seed bought, if anything). */
  first_review: boolean
  book: {
    equity: number
    cash: number
    cash_reserve_pct: number
    /** Cash above the reserve. */
    deployable_cash: number
    target_pct: number
    band_pct: number
    core_value: number
    core_pct: number
    trading_value: number
    trading_pct: number
    holdings: number
    min_holdings: number
    max_holdings: number
    max_holding_pct: number
    max_index_etf_pct: number
    index_etfs: string[]
    /** % of the book. */
    max_theme_pct: number
    stop_pct: number
    min_stop_pct: number
    min_weight_pct: number
    min_conviction: number
    max_trades: number
    buys_allowed: boolean
    notes: string[]
  }
  holdings: CoreHoldingContext[]
  /** Stocks held in the trading book: never bought by the core book. */
  trading_book: string[]
  candidates: CoreCandidateContext[]
  ranking_as_of: string | null
  themes: { name: string; tickers: string[] }[]
  last_review: { on: string; summary: string; watch: CoreWatchItem[] } | null
}
