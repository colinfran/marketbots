import type { Candle, KrakenRest, OhlcInterval } from "../venues/kraken/rest"
import type { PairInfo } from "../venues/kraken/pairs"

/**
 * Closed candles from Kraken's REST OHLC endpoint, cached per (symbol, interval). Candles aren't
 * stored in MongoDB: Kraken keeps 720 of each interval (30 days of 1h, 120 days of 4h, ~2 years
 * of daily), which is enough history for every indicator the strategies use.
 */

const TTL_MS: Partial<Record<OhlcInterval, number>> = {
  15: 4 * 60_000,
  60: 10 * 60_000,
  240: 30 * 60_000,
  1440: 2 * 3_600_000,
}

export class CandleCache {
  private readonly cache = new Map<string, { at: number; candles: Candle[] }>()
  private readonly inflight = new Map<string, Promise<Candle[]>>()

  constructor(
    private readonly rest: Pick<KrakenRest, "ohlc">,
    private readonly pairs: () => Map<string, PairInfo>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(symbol: string, interval: OhlcInterval): Promise<Candle[]> {
    const key = `${symbol}|${interval}`
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < (TTL_MS[interval] ?? 5 * 60_000)) return hit.candles
    const pending = this.inflight.get(key)
    if (pending) return pending
    const pair = this.pairs().get(symbol)
    if (!pair) throw new Error(`Unknown Kraken pair ${symbol}`)
    const load = this.rest
      .ohlc(pair.restPair, interval)
      .then((candles) => {
        this.cache.set(key, { at: this.now(), candles })
        return candles
      })
      .catch((error) => {
        // Serve stale candles rather than nothing; indicators on 10-minute-old 4h candles are fine.
        if (hit) return hit.candles
        throw error
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, load)
    return load
  }

  /** Makes every cached candle of `interval` stale, so the next read fetches the one that just closed (stale candles still serve if the fetch fails). */
  expire(interval: OhlcInterval) {
    for (const [key, hit] of this.cache) if (key.endsWith(`|${interval}`)) hit.at = 0
  }

  /** Age of the newest closed candle, for data-freshness checks. */
  lastCandleAt(symbol: string, interval: OhlcInterval): number | null {
    return this.cache.get(`${symbol}|${interval}`)?.candles.at(-1)?.t ?? null
  }
}
