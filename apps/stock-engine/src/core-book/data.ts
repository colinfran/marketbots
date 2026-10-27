import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { CORE_RANKING_KEY, type CoreRanking } from "@mb/stock-core/core-book"
import type { Settings } from "@mb/stock-core/settings"
import { addDays, marketDay, marketTime } from "@mb/stock-core/time"
import type { Alpaca } from "../alpaca/client"
import type { Session } from "../bot/session"
import type { Collections } from "../db/mongo"
import { SCAN_UNIVERSE_KEY, type ScanUniverse } from "../market/scan-universe"
import { coreCandidates, coreMetrics, rankCandidates } from "./ranking"

/**
 * The core book's long-term data: a year of consolidated (SIP) daily bars for the candidates, which
 * the free plan allows once they're over 15 minutes old, turned into the day's ranking (./ranking).
 * About four paged requests for ~150 symbols, built once per trading day from the premarket window
 * on, and kept in `cache` for the dashboard's Core page and the weekly review. Nothing trades on it.
 */

/** Calendar days of bars: 253 closes for the 12-month returns, plus holidays. */
const LOOKBACK_DAYS = 380
/** After a failed build, wait this long before trying again. */
const RETRY_MS = 30 * 60_000
const KEEP_MS = 30 * 86_400_000

export type RankingInputs = { held: string[]; universe: Pick<ScanUniverse, "day" | "symbols"> | null }

/** Builds the ranking for New York day `day` from completed sessions only (bars end at that day's midnight). */
export const buildCoreRanking = async (alpaca: Pick<Alpaca, "listAssets" | "getBars">, settings: Settings, day: string, { held, universe }: RankingInputs, now = new Date()): Promise<CoreRanking> => {
  const assets = new Map((await alpaca.listAssets()).map((a) => [a.symbol, a]))
  const { candidates, excluded } = coreCandidates({
    universe: universe?.symbols ?? [],
    universeSize: settings.core.universe_size,
    benchmarks: settings.universe.benchmarks,
    themes: settings.core.themes,
    held,
    assets,
  })
  const symbols = [...new Set(["SPY", ...candidates.map((c) => c.symbol)])]
  const bars = await alpaca.getBars(symbols, "1Day", marketTime(addDays(day, -LOOKBACK_DAYS), "00:00"), marketTime(day, "00:00"), { feed: "sip" })
  const rows = candidates.flatMap((c) => {
    const metrics = coreMetrics(c.symbol, bars[c.symbol] ?? [], bars.SPY, c.name)
    if (!metrics) excluded.push({ symbol: c.symbol, reason: "no daily bars" })
    return metrics ? [{ ...metrics, sources: c.sources, themes: c.themes }] : []
  })
  if (!rows.length) throw new Error("no daily bars for any candidate")
  const last = bars.SPY?.at(-1)
  return { day, built_at: now, as_of: last ? marketDay(new Date(last.t)) : null, universe_day: universe?.day ?? null, rows: rankCandidates(rows), excluded }
}

/** What a ranking depends on besides the market: when it changes in settings, today's ranking is rebuilt. */
const inputsKey = (s: Settings) => JSON.stringify([s.core.universe_size, s.core.themes, s.universe.benchmarks])

export class CoreRankingStore {
  private building = false
  /** The day and inputs of the ranking in the cache, once known. */
  private built: { day: string; key: string } | null = null
  private retryAt = 0
  lastError: string | null = null

  constructor(
    private readonly d: {
      col: Pick<Collections, "cache">
      alpaca: Pick<Alpaca, "listAssets" | "getBars">
      settings: () => Settings
      log: Logger
      /** Stock symbols held right now. */
      held: () => string[]
    },
  ) {}

  /** The ranking in the cache (the latest built), or null. */
  async latest(): Promise<CoreRanking | null> {
    const doc = await this.d.col.cache.findOne({ _id: CORE_RANKING_KEY })
    return (doc?.data as CoreRanking | undefined) ?? null
  }

  /**
   * Builds the day's ranking once, from the premarket window of a trading day on, and again the
   * same day if the owner changes the themes, universe size or benchmarks. Never throws: a failed
   * build is retried after 30 minutes, and the last ranking keeps serving. Returns it when it built one.
   */
  async refresh(session: Session, now = new Date()): Promise<CoreRanking | null> {
    const settings = this.d.settings()
    const key = inputsKey(settings)
    if (this.building || !session.is_trading_day || !session.open) return null
    if (this.built?.day === session.day && this.built.key === key) return null
    if (now.getTime() < session.open.getTime() - settings.schedule.premarket_lead_minutes * 60_000 || now.getTime() < this.retryAt) return null
    this.building = true
    try {
      // After a restart, today's cached ranking stands (its inputs are taken to be the current ones).
      if (!this.built && (await this.latest().catch(() => null))?.day === session.day) {
        this.built = { day: session.day, key }
        return null
      }
      return await this.build(session.day, now)
    } finally {
      this.building = false
    }
  }

  /** Builds and stores a ranking now. Never throws; null when the build failed. */
  async build(day: string, now = new Date()): Promise<CoreRanking | null> {
    const settings = this.d.settings()
    const started = Date.now()
    try {
      const universe = ((await this.d.col.cache.findOne({ _id: SCAN_UNIVERSE_KEY }))?.data ?? null) as ScanUniverse | null
      const ranking = await buildCoreRanking(this.d.alpaca, settings, day, { held: this.d.held(), universe }, now)
      await this.d.col.cache.updateOne({ _id: CORE_RANKING_KEY }, { $set: { data: ranking, fetched_at: now, expires_at: new Date(now.getTime() + KEEP_MS) } }, { upsert: true })
      this.built = { day, key: inputsKey(settings) }
      this.lastError = null
      this.d.log.info("core ranking built", { day, candidates: ranking.rows.length, ranked: ranking.rows.filter((r) => r.rank !== null).length, excluded: ranking.excluded.length, ms: Date.now() - started })
      return ranking
    } catch (error) {
      this.retryAt = now.getTime() + RETRY_MS
      this.lastError = `core ranking: ${errorMessage(error)}`.slice(0, 200)
      this.d.log.warn("core ranking build failed", { error: errorMessage(error) })
      return null
    }
  }
}
