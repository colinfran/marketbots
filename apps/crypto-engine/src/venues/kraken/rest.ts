import { sleep, TokenBucket } from "@mb/engine-kit/util/async"
import { requestText } from "../../util/http"
import type { KrakenAssetPair, KrakenEnvelope, KrakenOhlcRow, KrakenSystemStatus, KrakenTicker } from "./types"

/**
 * Kraken Spot public REST client (no API key): pair metadata, tickers, candles, order books and
 * system status. Requests are paced client-side to stay well under Kraken's public rate limits,
 * and Kraken's transient errors (which arrive inside HTTP 200 responses) are retried.
 *
 * The engine never calls private endpoints: orders go to the Kraken CLI paper wallet.
 */

const BASE = "https://api.kraken.com"

export class KrakenApiError extends Error {
  constructor(
    readonly errors: string[],
    readonly path: string,
  ) {
    super(`Kraken ${path}: ${errors.join(", ")}`)
    this.name = "KrakenApiError"
  }

  /** Kraken signals transient conditions in the error array of an HTTP 200 response. */
  get retryable() {
    return this.errors.some((e) => /EAPI:Rate limit|EService:(Unavailable|Busy|Timeout)|EGeneral:Temporary lockout|EOrder:Rate limit/.test(e))
  }
}

export type OhlcInterval = 1 | 5 | 15 | 30 | 60 | 240 | 1440 | 10080 | 21600

export type Candle = { t: number; open: number; high: number; low: number; close: number; vwap: number; volume: number; trades: number }

export class KrakenRest {
  private readonly bucket = new TokenBucket(4, 1)

  constructor(private readonly base = BASE) {}

  private unwrap<T>(path: string, text: string): T {
    const body = JSON.parse(text) as KrakenEnvelope<T>
    if (body.error?.length) throw new KrakenApiError(body.error, path)
    if (body.result === undefined) throw new KrakenApiError(["EGeneral:Empty result"], path)
    return body.result
  }

  async public<T>(endpoint: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const path = `/0/public/${endpoint}`
    const url = new URL(path, this.base)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
    for (let attempt = 1; ; attempt++) {
      await this.bucket.take()
      const { text } = await requestText(url.toString(), { timeoutMs: 15_000, attempts: 3 })
      try {
        return this.unwrap<T>(path, text)
      } catch (error) {
        if (error instanceof KrakenApiError && error.retryable && attempt < 3) {
          await sleep(2_000 * attempt)
          continue
        }
        throw error
      }
    }
  }

  // ── public ────────────────────────────────────────────────────────────────

  systemStatus = () => this.public<KrakenSystemStatus>("SystemStatus")

  assetPairs = () => this.public<Record<string, KrakenAssetPair>>("AssetPairs")

  ticker = (pairs: string[]) => this.public<Record<string, KrakenTicker>>("Ticker", { pair: pairs.join(",") })

  /** Up to 720 most recent candles. The last one is still forming and is dropped. */
  async ohlc(pair: string, interval: OhlcInterval, since?: number): Promise<Candle[]> {
    const result = await this.public<Record<string, KrakenOhlcRow[] | number>>("OHLC", { pair, interval, since })
    const rows = Object.entries(result).find(([k]) => k !== "last")?.[1]
    if (!Array.isArray(rows)) return []
    return rows.slice(0, -1).map((r) => ({
      t: r[0] * 1000,
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      vwap: Number(r[5]),
      volume: Number(r[6]),
      trades: r[7],
    }))
  }

  depth = (pair: string, count = 25) =>
    this.public<Record<string, { asks: [string, string, number][]; bids: [string, string, number][] }>>("Depth", { pair, count })
}
