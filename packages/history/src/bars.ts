import { errorMessage } from "@mb/engine-kit/log"
import type { Sql } from "./sql"

/** A closed 1-minute bar; `t` is the minute's start in ms, `source` the feed it came from (kraken, iex…). */
export type Bar = { symbol: string; t: number; open: number; high: number; low: number; close: number; volume: number; source: string }

export type BarWriterStatus = { written: number; dropped: number; buffered: number; last_at: Date | null; last_error: string | null }

const finite = (b: Bar) => [b.t, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) && b.close > 0

/**
 * Closed 1-minute bars on their way to `bars_1m`: buffered, then written in batches. A bar written
 * twice (a reconnect replays a minute) replaces the first. While the store is unreachable, bars
 * wait in the buffer up to `maxBuffer`; past that the oldest are dropped and counted (the
 * backfills can fetch them again). Writing never throws.
 */
export class BarWriter {
  private buffer: Bar[] = []
  private flushing = false
  private written = 0
  private dropped = 0
  private lastAt: Date | null = null
  private lastError: string | null = null

  constructor(
    private readonly sql: () => Sql | null,
    private readonly opts: { maxBuffer?: number; batch?: number } = {},
  ) {}

  add(bar: Bar) {
    if (!finite(bar)) return
    this.buffer.push(bar)
    this.trim()
  }

  /** Drops the oldest bars beyond the cap. */
  private trim() {
    const over = this.buffer.length - (this.opts.maxBuffer ?? 50_000)
    if (over > 0) {
      this.buffer.splice(0, over)
      this.dropped += over
    }
  }

  /** Writes what is buffered, one batch after another, until the buffer is empty or a write fails. */
  async flush(): Promise<void> {
    const sql = this.sql()
    if (!sql || this.flushing) return
    this.flushing = true
    try {
      while (this.buffer.length) {
        const batch = this.buffer.splice(0, this.opts.batch ?? 1_000)
        // One statement can't update the same row twice: the last copy of a minute wins.
        const rows = [...new Map(batch.map((b) => [`${b.symbol} ${b.t}`, b])).values()]
        await sql
          .query(
          `insert into bars_1m (symbol, t, open, high, low, close, volume, source)
           select symbol, to_timestamp(t / 1000.0), open, high, low, close, volume, source
           from jsonb_to_recordset($1::jsonb) as x(symbol text, t double precision, open double precision, high double precision, low double precision, close double precision, volume double precision, source text)
           on conflict (symbol, t) do update set open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume, source = excluded.source`,
          [JSON.stringify(rows)],
          )
          .catch((error: unknown) => {
            // Back to the front, in order, for the next flush.
            this.buffer.unshift(...batch)
            this.trim()
            throw error
          })
        this.written += rows.length
        this.lastAt = new Date()
        this.lastError = null
      }
    } catch (error) {
      this.lastError = errorMessage(error)
    } finally {
      this.flushing = false
    }
  }

  status(): BarWriterStatus {
    return { written: this.written, dropped: this.dropped, buffered: this.buffer.length, last_at: this.lastAt, last_error: this.lastError }
  }
}
