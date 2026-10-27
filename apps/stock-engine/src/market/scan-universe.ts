import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { sleep } from "@mb/engine-kit/util/async"
import type { Bar } from "@mb/stock-core/alpaca"
import type { Settings } from "@mb/stock-core/settings"
import { marketDay } from "@mb/stock-core/time"
import type { Alpaca } from "../alpaca/client"
import type { Collections } from "../db/mongo"

/**
 * The scan universe (MASTER_PLAN §3.13): the liquid US stocks and ETFs the news engine watches for
 * unusual moves. Built once a day before premarket:
 *   active, tradable symbols on the main exchanges (Alpaca /v2/assets, ~12.7k)
 *   → the last 20 sessions of consolidated (SIP) daily bars, which the free plan allows for data
 *     more than 15 minutes old (IEX volume is only a small slice of the real thing)
 *   → last close ≥ risk.min_price and average dollar volume ≥ wire.scan_min_dollar_volume
 *   → the top wire.scan_max_symbols by dollar volume.
 * About 40 requests, paced so trading calls never wait behind them. Cached in `cache`, so a
 * restart reuses the day's list.
 */

const EXCHANGES = new Set(["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"])
/** Plain tickers and class shares (BRK.B); no warrants, units or test symbols. */
const TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/
const BATCH = 1_000
const SESSIONS = 20
const CACHE_ID = "wire:scan_universe"
/** After a failed build, wait this long before trying again. */
const RETRY_MS = 30 * 60_000

export type ScanUniverse = { day: string; built_at: Date; symbols: string[]; dollar_volume: Record<string, number> }

/** Liquid enough and priced high enough, ranked by average dollar volume. */
export const rankUniverse = (bars: Record<string, Bar[]>, { minPrice, minDollarVolume, max }: { minPrice: number; minDollarVolume: number; max: number }) => {
  const rows: { symbol: string; dollarVolume: number }[] = []
  for (const [symbol, list] of Object.entries(bars)) {
    const recent = list.slice(-SESSIONS)
    if (recent.length < 5) continue
    if (!(recent.at(-1)!.c >= minPrice)) continue
    const dollarVolume = recent.reduce((sum, b) => sum + b.c * b.v, 0) / recent.length
    if (dollarVolume >= minDollarVolume) rows.push({ symbol, dollarVolume })
  }
  return rows.sort((a, b) => b.dollarVolume - a.dollarVolume).slice(0, max)
}

export const buildScanUniverse = async (alpaca: Pick<Alpaca, "listAssets" | "getBars">, settings: Settings, { now = new Date(), pauseMs = 1_500, signal }: { now?: Date; pauseMs?: number; signal?: AbortSignal } = {}): Promise<ScanUniverse> => {
  const assets = await alpaca.listAssets()
  const symbols = assets.filter((a) => a.tradable && a.status === "active" && TICKER.test(a.symbol) && EXCHANGES.has(a.exchange)).map((a) => a.symbol)
  // 35 calendar days cover 20 sessions; the end stays clear of the free plan's 15-minute SIP delay.
  const start = new Date(now.getTime() - 35 * 86_400_000)
  const end = new Date(now.getTime() - 20 * 60_000)
  const bars: Record<string, Bar[]> = {}
  for (let i = 0; i < symbols.length; i += BATCH) {
    if (signal?.aborted) throw new Error("aborted")
    Object.assign(bars, await alpaca.getBars(symbols.slice(i, i + BATCH), "1Day", start, end, { feed: "sip" }))
    if (i + BATCH < symbols.length) await sleep(pauseMs, signal)
  }
  const ranked = rankUniverse(bars, { minPrice: settings.risk.min_price, minDollarVolume: settings.wire.scan_min_dollar_volume, max: settings.wire.scan_max_symbols })
  return { day: marketDay(now), built_at: now, symbols: ranked.map((r) => r.symbol), dollar_volume: Object.fromEntries(ranked.map((r) => [r.symbol, Math.round(r.dollarVolume)])) }
}

/** Today's universe (New York day): from the cache, else built. While a build fails, the last one serves. */
export class ScanUniverseStore {
  private current: ScanUniverse | null = null
  private building = false
  private retryAt = 0
  lastError: string | null = null

  constructor(
    private readonly col: Pick<Collections, "cache">,
    private readonly alpaca: Pick<Alpaca, "listAssets" | "getBars">,
    private readonly settings: () => Settings,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get symbols(): string[] {
    return this.current?.symbols ?? []
  }

  get day(): string | null {
    return this.current?.day ?? null
  }

  /** Brings the universe up to date. Returns whether the symbol list changed. Never throws. */
  async refresh(signal?: AbortSignal): Promise<boolean> {
    if (this.building) return false
    const now = this.now()
    const today = marketDay(now)
    if (this.current?.day === today) return false
    this.building = true
    try {
      const cached = await this.col.cache.findOne({ _id: CACHE_ID })
      const stored = (cached?.data ?? null) as ScanUniverse | null
      const changed = !!stored && stored.day !== this.current?.day
      if (stored && (stored.day === today || now.getTime() < this.retryAt)) {
        this.current = stored
        return changed
      }
      if (now.getTime() < this.retryAt) return false
      const started = Date.now()
      const built = await buildScanUniverse(this.alpaca, this.settings(), { now, signal })
      if (!built.symbols.length) throw new Error("no symbols passed the filters")
      this.current = built
      this.lastError = null
      await this.col.cache.updateOne({ _id: CACHE_ID }, { $set: { data: built, fetched_at: now, expires_at: new Date(now.getTime() + 7 * 86_400_000) } }, { upsert: true })
      this.log.info("scan universe built", { day: built.day, symbols: built.symbols.length, ms: Date.now() - started })
      return true
    } catch (error) {
      this.retryAt = now.getTime() + RETRY_MS
      this.lastError = `scan universe: ${errorMessage(error)}`.slice(0, 200)
      this.log.warn("scan universe build failed", { error: errorMessage(error) })
      // The last good list keeps serving until a build succeeds.
      const cached = await this.col.cache.findOne({ _id: CACHE_ID }).catch(() => null)
      const stored = (cached?.data ?? null) as ScanUniverse | null
      if (stored && !this.current) {
        this.current = stored
        return true
      }
      return false
    } finally {
      this.building = false
    }
  }
}
