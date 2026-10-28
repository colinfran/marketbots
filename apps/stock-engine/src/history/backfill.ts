import { sleep } from "@mb/engine-kit/util/async"
import { upsertBars, upsertDailyBars, type Bar, type DailyBar } from "@mb/history/bars"
import { loadJob, saveJob, type HistoryJob } from "@mb/history/jobs"
import type { Sql } from "@mb/history/sql"
import type { Bar as AlpacaBar } from "@mb/stock-core/alpaca"
import { marketDay } from "@mb/stock-core/time"
import type { Alpaca } from "../alpaca/client"

/**
 * Stock's backfills for the history store (docs/plans/LOCAL-AI.md §6.2): Alpaca's SIP bars
 * (all exchanges; the free plan serves them once they are 15 minutes old), split-adjusted like
 * the engine's own. One request per step, and the two jobs together at most one every 2 s: 30 a
 * minute, a fifth of the client's shared budget, so trading calls never wait long.
 *
 *   alpaca_daily    daily bars since 2016 for the scan universe, the benchmarks and holdings, 50
 *                   symbols a request; then every day the last 10 days again, and the history of
 *                   symbols new to the universe
 *   alpaca_minute   1-minute bars since 2016 for the top 300 of the scan universe by dollar volume,
 *                   the benchmarks and holdings, one symbol at a time (about two days in all);
 *                   then every day the last 3 days again, which replaces the live feed's IEX-only
 *                   minutes with SIP's
 *
 * Each saves its progress in the `jobs` table: a restart picks up where it stopped.
 */

export type StockBackfillDeps = {
  alpaca: Pick<Alpaca, "getBarsPage">
  /** The scan universe, in dollar-volume order (empty until it's built). */
  universe: () => string[]
  /** Benchmarks and holdings: always included. */
  extra: () => string[]
  now?: () => number
}

export const HISTORY_START = new Date("2016-01-01T00:00:00Z")
const REQUEST_MS = 2_000
const DAILY_BATCH = 50
const MINUTE_TOP = 300
const DAY_MS = 86_400_000
/** The free plan serves SIP data once it is 15 minutes old. */
const SIP_DELAY_MS = 20 * 60_000
const SOURCE = "sip"

/** At most one request every REQUEST_MS across both jobs. */
const pacer = (now: () => number) => {
  let last = 0
  return async () => {
    const wait = last + REQUEST_MS - now()
    if (wait > 0) await sleep(wait)
    last = now()
  }
}

type Batch = { symbols: string[]; page: string | null; from: string; refresh: boolean }
type JobState = { done: string[]; batch: Batch | null; refresh: { on: string; next: number } | null; rows: number }

const empty = (): JobState => ({ done: [], batch: null, refresh: null, rows: 0 })

/**
 * The shared shape of both jobs: history first (each symbol from HISTORY_START, in batches of
 * `size`), then once a day the last `refreshDays` again for every symbol, in the same batches.
 */
const barsJob = (
  name: string,
  d: StockBackfillDeps,
  pace: () => Promise<void>,
  o: { symbols: () => string[]; size: number; refreshDays: number; timeframe: "1Day" | "1Min"; write: (sql: Sql, bars: Record<string, AlpacaBar[]>) => Promise<number> },
): HistoryJob => {
  const now = d.now ?? Date.now
  return {
    name,
    repeatMs: 6 * 3_600_000,
    step: async (sql) => {
      const all = o.symbols()
      if (!all.length) return { done: false, progress: "waiting for the scan universe", waitMs: 10 * 60_000 }
      const s = (await loadJob<JobState>(sql, name))?.state ?? empty()
      const done = new Set(s.done)
      const today = marketDay(new Date(now()))
      if (!s.batch) {
        const todo = all.filter((x) => !done.has(x))
        if (todo.length) s.batch = { symbols: todo.slice(0, o.size), page: null, from: HISTORY_START.toISOString(), refresh: false }
        else {
          const r = s.refresh?.on === today ? s.refresh : (s.refresh = { on: today, next: 0 })
          if (r.next >= all.length) return { done: true, progress: `${all.length} symbols since ${HISTORY_START.toISOString().slice(0, 4)}, ${s.rows.toLocaleString("en-US")} bars; refreshed ${today}` }
          s.batch = { symbols: all.slice(r.next, r.next + o.size), page: null, from: new Date(now() - o.refreshDays * DAY_MS).toISOString(), refresh: true }
          r.next += o.size
        }
      }
      const b = s.batch
      await pace()
      const res = await d.alpaca.getBarsPage(b.symbols, o.timeframe, new Date(b.from), new Date(now() - SIP_DELAY_MS), b.page)
      const n = await o.write(sql, res.bars)
      s.rows += n
      const reached = Object.values(res.bars)
        .flatMap((bars) => (bars.length ? [bars.at(-1)!.t.slice(0, 10)] : []))
        .sort()
        .at(-1)
      if (res.next) b.page = res.next
      else {
        if (!b.refresh) s.done = [...done, ...b.symbols]
        s.batch = null
      }
      await saveJob(sql, name, s)
      const label = b.symbols.length === 1 ? b.symbols[0] : `${b.symbols[0]}…${b.symbols.at(-1)} (${b.symbols.length})`
      return { done: false, progress: `${b.refresh ? "refreshing" : "history"} ${label}: ${reached ?? "…"}; ${s.done.length}/${all.length} symbols, ${s.rows.toLocaleString("en-US")} bars` }
    },
  }
}

const toDaily = (bars: Record<string, AlpacaBar[]>): DailyBar[] =>
  Object.entries(bars).flatMap(([symbol, list]) => list.map((b) => ({ symbol, day: marketDay(new Date(b.t)), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, source: SOURCE })))

const toMinute = (bars: Record<string, AlpacaBar[]>): Bar[] =>
  Object.entries(bars).flatMap(([symbol, list]) => list.map((b) => ({ symbol, t: Date.parse(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, source: SOURCE })))

/** Both stock backfill jobs, sharing one pacer. */
export const stockBackfillJobs = (d: StockBackfillDeps): HistoryJob[] => {
  const pace = pacer(d.now ?? Date.now)
  const unique = (xs: string[]) => [...new Set(xs)]
  return [
    barsJob("alpaca_daily", d, pace, { symbols: () => unique([...d.extra(), ...d.universe()]), size: DAILY_BATCH, refreshDays: 10, timeframe: "1Day", write: (sql, bars) => upsertDailyBars(sql, toDaily(bars)) }),
    barsJob("alpaca_minute", d, pace, { symbols: () => unique([...d.extra(), ...d.universe().slice(0, MINUTE_TOP)]), size: 1, refreshDays: 3, timeframe: "1Min", write: (sql, bars) => upsertBars(sql, toMinute(bars)) }),
  ]
}
