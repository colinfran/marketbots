import { sma } from "@mb/core/indicators"
import { stdev } from "@mb/core/math"
import type { AlpacaAsset, Bar } from "@mb/stock-core/alpaca"
import type { CoreCandidateSource, CoreMetrics, CoreRankRow } from "@mb/stock-core/core-book"
import { parseTheme } from "@mb/stock-core/settings"
import { marketDay } from "@mb/stock-core/time"
import { round } from "../market/indicators"

/**
 * The core book's candidates and their long-term numbers, all in code (docs/plans/CORE-BOOK.md §5):
 *
 *   candidates  the scan universe's top names by dollar volume, the benchmark ETFs, every ticker in
 *               an owner theme, and what's held; leveraged, inverse, volatility and option-income
 *               products are never candidates
 *   metrics     50/200-day averages, 3/6/12-month and 12-1 month returns, returns against SPY,
 *               distance from the 52-week high, 60-day volatility, the year's worst drawdown,
 *               20-day dollar volume
 *   ranking     a trend filter (price above the 200-day average, the 50-day above the 200-day), then
 *               a score: the mean percentile of the 12-1 month and 6-month returns, each divided by
 *               the volatility (at least VOLATILITY_FLOOR_PCT), among the names that pass the filter
 */

/** Sessions in one, three, six and twelve months. */
export const SESSIONS = { m1: 21, m3: 63, m6: 126, m12: 252 } as const

const VOLATILITY_SESSIONS = 60

/**
 * The score divides returns by at least this volatility (about the market's), so a fund calmer than
 * the market (a dollar or bond fund up 3% on 5% volatility) can't outrank stocks on calm alone.
 */
export const VOLATILITY_FLOOR_PCT = 15

/** A fund's name (ETF, ETN, trust, the big leveraged-fund families). */
const FUND_NAME = /\b(?:ETF|ETN|Fund|Trust|Shares|ProShares|Direxion)\b/i
/** Leveraged, inverse, volatility and option-income products. Only funds are checked, so a company called "Ultra…" stays. */
const PRODUCT_NAME = /(?:\b|-)(?:[1-5](?:\.\d+)?x|ultra(?:pro|short)?|leveraged|inverse|short|bear|daily|vix|volatility|option income|covered call|buywrite)\b/i

/** Why an asset can't be a core holding, or null when it can. */
export const productExclusion = (asset: Pick<AlpacaAsset, "name" | "tradable" | "status" | "class"> | undefined): string | null => {
  if (!asset || !asset.tradable || asset.status !== "active" || asset.class !== "us_equity") return "not an active, tradable US equity on Alpaca"
  if (FUND_NAME.test(asset.name) && PRODUCT_NAME.test(asset.name)) return "leveraged, inverse, volatility or option-income product"
  return null
}

export type CoreCandidate = { symbol: string; name: string | null; sources: CoreCandidateSource[]; themes: string[] }

/**
 * Who gets ranked. `universe` is the scan universe in dollar-volume order; its top `universeSize`
 * eligible names are taken. Benchmarks, theme tickers and holdings always come along (a holding
 * even when its product is excluded, so the review still sees it).
 */
export const coreCandidates = ({
  universe,
  universeSize,
  benchmarks,
  themes,
  held,
  assets,
}: {
  universe: string[]
  universeSize: number
  benchmarks: string[]
  themes: string[]
  held: string[]
  assets: Map<string, AlpacaAsset>
}): { candidates: CoreCandidate[]; excluded: { symbol: string; reason: string }[] } => {
  const bySymbol = new Map<string, CoreCandidate>()
  const excluded = new Map<string, string>()
  const add = (symbol: string, source: CoreCandidateSource, theme?: string) => {
    const reason = source === "held" ? null : productExclusion(assets.get(symbol))
    if (reason) {
      excluded.set(symbol, reason)
      return false
    }
    const c = bySymbol.get(symbol) ?? { symbol, name: assets.get(symbol)?.name ?? null, sources: [], themes: [] }
    if (!c.sources.includes(source)) c.sources.push(source)
    if (theme && !c.themes.includes(theme)) c.themes.push(theme)
    bySymbol.set(symbol, c)
    return true
  }
  let taken = 0
  for (const symbol of universe) {
    if (taken >= universeSize) break
    if (add(symbol, "universe")) taken += 1
  }
  for (const symbol of benchmarks) add(symbol, "benchmark")
  for (const line of themes) {
    const theme = parseTheme(line)
    for (const symbol of theme?.tickers ?? []) add(symbol, "theme", theme!.name)
  }
  for (const symbol of held) add(symbol, "held")
  for (const symbol of bySymbol.keys()) excluded.delete(symbol)
  return { candidates: [...bySymbol.values()], excluded: [...excluded].map(([symbol, reason]) => ({ symbol, reason })) }
}

const pct = (from: number | undefined, to: number | undefined) => (from && to ? ((to - from) / from) * 100 : null)

/**
 * The long-term numbers for completed daily bars (oldest first). `spy` is SPY's bars, for the
 * relative returns: SPY is measured between the same two days. null without bars.
 */
export const coreMetrics = (symbol: string, bars: Bar[], spy: Bar[] | undefined, name: string | null = null): CoreMetrics | null => {
  if (!bars.length) return null
  const closes = bars.map((b) => b.c)
  const n = closes.length
  const last = closes[n - 1]
  const day = (b: Bar) => marketDay(new Date(b.t))
  const spyClose = new Map((spy ?? []).map((b) => [day(b), b.c]))
  /** % return over `sessions`, ending `skip` sessions before the last. */
  const ret = (sessions: number, skip = 0) => (n - 1 - sessions >= 0 ? pct(closes[n - 1 - sessions], closes[n - 1 - skip]) : null)
  const rel = (sessions: number) => {
    if (n - 1 - sessions < 0) return null
    const own = ret(sessions)
    const bench = pct(spyClose.get(day(bars[n - 1 - sessions])), spyClose.get(day(bars[n - 1])))
    return own === null || bench === null ? null : own - bench
  }
  const sma50 = sma(closes, 50)
  const sma200 = sma(closes, 200)
  // A year of returns is 253 closes; the 52-week high (as in the cycles' daily technicals) wants nearly all 252 sessions.
  const year = bars.slice(-(SESSIONS.m12 + 1))
  const high = n >= SESSIONS.m12 - 2 ? Math.max(...bars.slice(-SESSIONS.m12).map((b) => b.h)) : null
  const recentReturns = closes.slice(-(VOLATILITY_SESSIONS + 1)).flatMap((c, i, all) => (i === 0 ? [] : [Math.log(c / all[i - 1])]))
  let peak = 0
  let drawdown = 0
  for (const b of year) {
    peak = Math.max(peak, b.c)
    drawdown = Math.min(drawdown, b.c / peak - 1)
  }
  const recent = bars.slice(-20)
  return {
    symbol,
    name,
    price: last,
    sessions: n,
    sma50: round(sma50),
    sma200: round(sma200),
    pct_from_sma50: round(pct(sma50 ?? undefined, last)),
    pct_from_sma200: round(pct(sma200 ?? undefined, last)),
    return_3m_pct: round(ret(SESSIONS.m3)),
    return_6m_pct: round(ret(SESSIONS.m6)),
    return_12m_pct: round(ret(SESSIONS.m12)),
    return_12_1_pct: round(ret(SESSIONS.m12, SESSIONS.m1)),
    rel_spy_3m_pct: round(rel(SESSIONS.m3)),
    rel_spy_6m_pct: round(rel(SESSIONS.m6)),
    rel_spy_12m_pct: round(rel(SESSIONS.m12)),
    from_52w_high_pct: high ? round(pct(high, last)) : null,
    volatility_60d_pct: recentReturns.length >= VOLATILITY_SESSIONS ? round(stdev(recentReturns) * Math.sqrt(SESSIONS.m12) * 100) : null,
    max_drawdown_1y_pct: n >= SESSIONS.m12 ? round(drawdown * 100) : null,
    dollar_volume_20d: Math.round(recent.reduce((s, b) => s + b.c * b.v, 0) / recent.length),
  }
}

/** Price above the 200-day average and the 50-day above the 200-day. */
export const passesTrend = (m: Pick<CoreMetrics, "price" | "sma50" | "sma200">) => m.sma200 !== null && m.sma50 !== null && m.price > m.sma200 && m.sma50 > m.sma200

/** Percentile (0-1) of each value among the values; ties share the average rank. */
const percentiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return values.map((v) => {
    if (values.length === 1) return 1
    const first = sorted.indexOf(v)
    const lastIdx = sorted.lastIndexOf(v)
    return (first + lastIdx) / 2 / (values.length - 1)
  })
}

/**
 * Scores and orders the candidates (see the file header). Ranked rows come first, best first;
 * the rest follow by symbol.
 */
export const rankCandidates = (rows: (CoreMetrics & Pick<CoreRankRow, "sources" | "themes">)[]): CoreRankRow[] => {
  const scored = rows.map((m) => ({ ...m, trend_ok: passesTrend(m), score: null as number | null, rank: null as number | null }))
  const eligible = scored.filter((r) => r.trend_ok && r.return_12_1_pct !== null && r.return_6m_pct !== null && r.volatility_60d_pct !== null)
  const risk = (r: (typeof eligible)[number]) => Math.max(r.volatility_60d_pct!, VOLATILITY_FLOOR_PCT)
  const long = percentiles(eligible.map((r) => r.return_12_1_pct! / risk(r)))
  const mid = percentiles(eligible.map((r) => r.return_6m_pct! / risk(r)))
  eligible.forEach((r, i) => (r.score = round(((long[i] + mid[i]) / 2) * 100, 1)))
  const ranked = [...eligible].sort((a, b) => b.score! - a.score! || a.symbol.localeCompare(b.symbol))
  ranked.forEach((r, i) => (r.rank = i + 1))
  const rest = scored.filter((r) => r.rank === null).sort((a, b) => a.symbol.localeCompare(b.symbol))
  return [...ranked, ...rest]
}
