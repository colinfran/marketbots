import { roundTo } from "@mb/stock-core/math"

/**
 * Intraday setups for the stock agent (docs/plans/LOCAL-AI.md §8.1), from the price board's closed
 * 1-minute bars: the ~1,500-symbol scan universe and everything the engine tracks. Checked as each
 * minute closes:
 *
 *   opening_range_breakout  the first close above the opening range (the session's first
 *                           OPENING_RANGE_MINUTES), on a bar with at least VOLUME_MULTIPLE times
 *                           the symbol's median minute volume today
 *   new_high                a close above the session's high so far, at least NEW_HIGH_AFTER_MINUTES
 *                           into the session, on the same volume; again only after NEW_HIGH_REARM_MS
 *
 * Volume is IEX's slice (the board never mixes it with consolidated volume), so a bar is compared
 * only with the same symbol's own bars today; a bar without volume never makes a setup. Pure: the
 * agent decides what to do with a setup, after looking it up.
 */

export const OPENING_RANGE_MINUTES = 15
export const VOLUME_MULTIPLE = 2
export const NEW_HIGH_AFTER_MINUTES = 60
export const NEW_HIGH_REARM_MS = 60 * 60_000
/** A breakout must clear the level by this much (%), so a tick above it isn't one. */
const CLEAR_PCT = 0.1
/** Volume baselines need this many of the symbol's bars today. */
const MIN_BARS = 10
const MIN = 60_000

export type StockSetupKind = "opening_range_breakout" | "new_high"

export type StockSetup = {
  symbol: string
  kind: StockSetupKind
  /** The bar's start. */
  t: number
  close: number
  /** The level it broke (the opening range's high, or the session's high before this bar). */
  level: number
  /** The opening range, for the stop. */
  range: { low: number; high: number }
  volume_multiple: number
  /** 0-100, for the queue: stronger volume and a cleaner break score higher. */
  score: number
  summary: string
}

type Track = { day: string; rangeHigh: number; rangeLow: number; high: number; volumes: number[]; brokeOut: boolean; newHighAt: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export class StockScreen {
  private readonly tracks = new Map<string, Track>()

  /**
   * One closed minute's bars. `open` is the session's open (null outside a session day), `day` the
   * trading day; bars before the open are ignored. Returns the setups this minute made.
   */
  onBars(bars: readonly { symbol: string; t: number; close: number; volume: number }[], { open, day, minPrice }: { open: Date | null; day: string; minPrice: number }): StockSetup[] {
    if (!open) return []
    const out: StockSetup[] = []
    const rangeEnd = open.getTime() + OPENING_RANGE_MINUTES * MIN
    for (const bar of bars) {
      if (bar.t < open.getTime() || !(bar.close > 0)) continue
      let k = this.tracks.get(bar.symbol)
      if (!k || k.day !== day) {
        k = { day, rangeHigh: bar.close, rangeLow: bar.close, high: bar.close, volumes: [], brokeOut: false, newHighAt: 0 }
        this.tracks.set(bar.symbol, k)
      }
      // The levels and volumes before this bar: a break is judged against them.
      const high = k.high
      const prior = k.volumes.length
      if (Number.isFinite(bar.volume)) k.volumes.push(bar.volume)
      k.high = Math.max(k.high, bar.close)
      if (bar.t < rangeEnd) {
        k.rangeHigh = Math.max(k.rangeHigh, bar.close)
        k.rangeLow = Math.min(k.rangeLow, bar.close)
        continue
      }
      const clears = (level: number) => bar.close >= level * (1 + CLEAR_PCT / 100)
      const kind: StockSetupKind | null =
        !k.brokeOut && clears(k.rangeHigh) ? "opening_range_breakout" : bar.t - open.getTime() >= NEW_HIGH_AFTER_MINUTES * MIN && clears(high) && bar.t - k.newHighAt >= NEW_HIGH_REARM_MS ? "new_high" : null
      if (!kind || bar.close < minPrice || !Number.isFinite(bar.volume) || prior < MIN_BARS) continue
      const base = median(k.volumes.slice(0, prior))
      const multiple = base > 0 ? bar.volume / base : 0
      if (multiple < VOLUME_MULTIPLE) continue
      const level = kind === "opening_range_breakout" ? k.rangeHigh : high
      if (kind === "opening_range_breakout") k.brokeOut = true
      else k.newHighAt = bar.t
      const what = kind === "opening_range_breakout" ? `opening-range breakout (first ${OPENING_RANGE_MINUTES} min)` : "new session high"
      const breakPct = (bar.close / level - 1) * 100
      out.push({
        symbol: bar.symbol,
        kind,
        t: bar.t,
        close: bar.close,
        level,
        range: { low: k.rangeLow, high: k.rangeHigh },
        volume_multiple: roundTo(multiple, 1),
        score: Math.round(Math.min(95, 45 + 8 * Math.min(multiple, 5) + 5 * Math.min(breakPct, 2))),
        summary: `${bar.symbol} ${what}: closed ${bar.close} above ${roundTo(level, 2)} on ${roundTo(multiple, 1)}× its median minute volume today; opening range ${roundTo(k.rangeLow, 2)}-${roundTo(k.rangeHigh, 2)}.`,
      })
    }
    return out.sort((a, b) => b.score - a.score)
  }
}
