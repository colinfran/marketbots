import type { AgentEpisodeDoc } from "@mb/core/agent"
import type { HistoryStatus } from "@mb/core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/core/wire"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import type { Collection } from "mongodb"
import pg from "pg"
import { dailyBars, newsWithMoves, saveEpisode, type DayBar, type PastNews } from "./agent"
import { NewsArchive } from "./archive"
import { BarWriter } from "./bars"
import { JobRunner, loadJob, saveJob, type HistoryJob } from "./jobs"
import { migrate } from "./migrations"
import type { Sql } from "./sql"

/**
 * One bot's history store (docs/plans/LOCAL-AI.md §6): its own Postgres database on the `history`
 * service, reached with HISTORY_URL. The engine hands it closed 1-minute bars and its wire
 * collections; the store keeps the bars and archives the news.
 *
 *   every 5 s   bars buffered since the last flush
 *   every 60 s  wire items and triggers first seen since the last append
 *   daily       the last 7 days of items and triggers again (they change after they're first seen)
 *   every 30 s  the bot's jobs (backfills), one step at a time, while any is due
 *
 * The first successful start copies everything MongoDB still has. Nothing here can stop trading:
 * every failure is logged, shown in the heartbeat, and retried on the next tick.
 */

const BAR_FLUSH_MS = 5_000
const APPEND_MS = 60_000
const JOBS_MS = 30_000
const CONNECT_RETRY_MS = 60_000
const SYNC_DAYS = 7
/** The daily sync runs in the first tick after this hour (UTC): late night in the US. */
const SYNC_HOUR_UTC = 9
const SYNC_JOB = "news_sync"

/** The latest SYNC_HOUR_UTC at or before `now`: a sync saved before it is due again. */
export const syncDueSince = (now: Date) => {
  const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SYNC_HOUR_UTC))
  return due > now ? new Date(due.getTime() - 86_400_000) : due
}

export type HistoryStoreOptions<C extends string> = {
  url: string
  log: Logger
  col: { wireItems: Collection<WireItemDoc<C>>; wireTriggers: Collection<WireTriggerDoc> }
  /** Tests pass a PGlite instance instead of a URL's pool. */
  sql?: Sql
}

export class HistoryStore<C extends string> {
  readonly bars: BarWriter
  private readonly archive: NewsArchive<C>
  private readonly jobs = new JobRunner()
  private pool: pg.Pool | null = null
  private sql: Sql | null = null
  private ready = false
  private timers: NodeJS.Timeout[] = []
  private appending = false
  private lastError: string | null = null
  private archiveError: string | null = null
  private checkedAt = new Date()
  /** The last news sync, saved in the database so it survives restarts. */
  private lastSyncAt: Date | null = null

  constructor(private readonly o: HistoryStoreOptions<C>) {
    this.bars = new BarWriter(() => (this.ready ? this.sql : null))
    this.archive = new NewsArchive(o.col)
  }

  /** Connects and migrates in the background, then starts the jobs. Returns at once. */
  start() {
    void this.connect()
    this.timers.push(
      setInterval(() => void this.bars.flush(), BAR_FLUSH_MS),
      setInterval(() => void this.tick(), APPEND_MS),
      setInterval(() => void this.runJobs(), JOBS_MS),
    )
  }

  /** A backfill or another long-running job; it starts once the store is ready. */
  addJob(job: HistoryJob) {
    this.jobs.add(job)
  }

  private async runJobs() {
    if (this.ready && this.sql) await this.jobs.pass(this.sql)
  }

  async stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.jobs.stop()
    await this.bars.flush()
    await this.pool?.end().catch(() => undefined)
  }

  /** The full record of an agent episode; dropped (not retried) while the store isn't ready. */
  async saveEpisode(doc: AgentEpisodeDoc) {
    if (this.ready && this.sql) await saveEpisode(this.sql, doc)
  }

  /** The agent's lookups: null while the store isn't ready. */
  async dailyBars(symbol: string, days: number): Promise<DayBar[] | null> {
    return this.ready && this.sql ? dailyBars(this.sql, symbol, days) : null
  }

  async newsWithMoves(symbol: string, o: { days: number; minSeverity: number; limit: number }): Promise<PastNews[] | null> {
    return this.ready && this.sql ? newsWithMoves(this.sql, symbol, o) : null
  }

  status(): HistoryStatus {
    const bars = this.bars.status()
    const news = this.archive.status(this.archiveError)
    return {
      ok: this.ready && !this.lastError && !bars.last_error && !news.last_error,
      ready: this.ready,
      last_error: this.lastError ?? bars.last_error ?? news.last_error,
      checked_at: this.checkedAt,
      bars: { written: bars.written, dropped: bars.dropped, buffered: bars.buffered, last_at: bars.last_at },
      news: { items: news.items, triggers: news.triggers, last_append_at: news.last_append_at, last_sync_at: news.last_sync_at ?? this.lastSyncAt },
      ...(this.jobs.status().length ? { jobs: this.jobs.status() } : {}),
    }
  }

  private async connect() {
    if (this.ready) return
    try {
      if (!this.sql) {
        if (this.o.sql) this.sql = this.o.sql
        else {
          this.pool = new pg.Pool({ connectionString: this.o.url, max: 4, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000, statement_timeout: 120_000 })
          // An idle client losing its connection must not crash the engine.
          this.pool.on("error", (e) => this.o.log.warn("history store connection error", { error: errorMessage(e) }))
          this.sql = this.pool
        }
      }
      const applied = this.pool ? await this.withClient(migrate) : await migrate(this.sql)
      this.ready = true
      this.lastError = null
      this.o.log.info("history store ready", { migrations_applied: applied })
      void this.tick()
    } catch (error) {
      this.lastError = errorMessage(error)
      this.o.log.warn("history store unavailable; retrying in a minute", { error: this.lastError })
      setTimeout(() => void this.connect(), CONNECT_RETRY_MS).unref()
    } finally {
      this.checkedAt = new Date()
    }
  }

  private async withClient<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    const client = await this.pool!.connect()
    try {
      return await fn(client)
    } finally {
      client.release()
    }
  }

  /** The archive's minute: the first full copy, the daily sync when it's due, else the append. */
  private async tick(now = new Date()) {
    if (!this.ready || !this.sql || this.appending) return
    this.appending = true
    try {
      const last = await loadJob(this.sql, SYNC_JOB)
      this.lastSyncAt = last ? new Date(last.updated_at) : null
      if (!last || (await this.archive.empty(this.sql))) {
        const n = await this.archive.sync(this.sql, 3_650, now)
        await saveJob(this.sql, SYNC_JOB, { copied: n }, now)
        this.o.log.info("news archive: first copy done", { copied: n })
      } else if (new Date(last.updated_at) < syncDueSince(now)) {
        const n = await this.archive.sync(this.sql, SYNC_DAYS, now)
        await saveJob(this.sql, SYNC_JOB, { copied: n }, now)
        this.o.log.info("news archive: daily sync done", { copied: n })
      } else {
        await this.archive.append(this.sql, now)
      }
      this.archiveError = null
    } catch (error) {
      this.archiveError = errorMessage(error)
      this.o.log.warn("news archive failed; retrying in a minute", { error: this.archiveError })
    } finally {
      this.appending = false
      this.checkedAt = now
    }
  }
}
