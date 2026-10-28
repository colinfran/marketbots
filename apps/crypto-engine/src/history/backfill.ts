import { createReadStream, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { sleep } from "@mb/engine-kit/util/async"
import { upsertBars, upsertDailyBars, type Bar, type DailyBar } from "@mb/history/bars"
import { loadJob, saveJob, type HistoryJob } from "@mb/history/jobs"
import type { Sql } from "@mb/history/sql"
import type { KrakenRest } from "../venues/kraken/rest"
import type { PairInfo } from "../venues/kraken/pairs"

/**
 * Crypto's backfills for the history store (docs/plans/LOCAL-AI.md §6.2), run one step at a time:
 *
 *   kraken_files   Kraken's downloadable OHLCVT history (docs/SERVER.md §6.5): every universe
 *                  pair's 1-minute and daily CSVs, from each folder under KRAKEN_OHLCVT_DIR
 *   kraken_gap     the minutes between a pair's last file bar and its first live bar, rebuilt
 *                  from the public Trades endpoint, one request every 4 s through the engine's
 *                  own paced client, so live calls always have room
 *   kraken_daily   daily bars from the OHLC endpoint (its last 720 days), once a day
 *
 * Each saves its progress in the `jobs` table: a restart picks up where it stopped.
 */

export type BackfillDeps = {
  dir: string | null
  rest: Pick<KrakenRest, "trades" | "ohlc">
  pairs: () => Map<string, PairInfo>
  universe: () => string[]
}

const FILE_SOURCE = "kraken-file"
const LIVE_SOURCE = "kraken"
/** Minutes rebuilt from trades between the files and the live feed. */
const TRADES_SOURCE = "kraken-trades"
/** Lines read per step: enough to make progress, short enough to let other work in. */
const STEP_LINES = 200_000
const BATCH = 5_000
const GAP_REQUEST_MS = 4_000
const DAY_MS = 86_400_000

type FileState = { offset: number; rows: number; done: boolean }
type FilesState = Record<string, FileState>

/** One OHLCVT line: `timestamp,open,high,low,close,volume,trades` (seconds, no header). */
export const parseOhlcvtLine = (line: string) => {
  const p = line.split(",")
  if (p.length < 6) return null
  const [t, open, high, low, close, volume] = p.slice(0, 6).map(Number) as [number, number, number, number, number, number]
  return Number.isFinite(t) && close > 0 ? { t: t * 1000, open, high, low, close, volume } : null
}

/** Reads whole lines from `offset`, at most `max` of them. Returns them and the offset after the last one. */
export const readLines = async (file: string, offset: number, max: number): Promise<{ lines: string[]; next: number; eof: boolean }> => {
  const lines: string[] = []
  let next = offset
  let rest = ""
  const stream = createReadStream(file, { start: offset, encoding: "utf8", highWaterMark: 1 << 20 })
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const parts = (rest + chunk).split("\n")
      rest = parts.pop()!
      for (const line of parts) {
        lines.push(line.replace(/\r$/, ""))
        next += Buffer.byteLength(line, "utf8") + 1
        if (lines.length >= max) return { lines, next, eof: false }
      }
    }
  } finally {
    stream.destroy()
  }
  // A last line without a newline at the end of the file.
  if (rest.trim()) {
    lines.push(rest.replace(/\r$/, ""))
    next += Buffer.byteLength(rest, "utf8")
  }
  return { lines, next, eof: true }
}

/** The CSVs to import: per folder (sorted), each universe pair's 1-minute and daily file, if present. */
const importList = (dir: string, universe: string[], pairs: Map<string, PairInfo>) => {
  const folders = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()).sort()
  return folders.flatMap((folder) =>
    universe.flatMap((symbol) => {
      const alt = pairs.get(symbol)?.altname
      if (!alt) return []
      return (["1", "1440"] as const).flatMap((interval) => {
        const rel = `${folder}/${alt}_${interval}.csv`
        return existsSync(join(dir, rel)) ? [{ rel, symbol, daily: interval === "1440" }] : []
      })
    }),
  )
}

export const krakenFilesJob = (d: BackfillDeps): HistoryJob => ({
  name: "kraken_files",
  repeatMs: null,
  step: async (sql: Sql) => {
    if (!d.dir || !existsSync(d.dir)) return { done: true, progress: "no OHLCVT folder (KRAKEN_OHLCVT_DIR)" }
    const state = (await loadJob<FilesState>(sql, "kraken_files"))?.state ?? {}
    const list = importList(d.dir, d.universe(), d.pairs())
    const todo = list.find((f) => !state[f.rel]?.done)
    const rows = Object.values(state).reduce((s, f) => s + f.rows, 0)
    if (!todo) return { done: true, progress: `${list.length} files, ${rows.toLocaleString("en-US")} rows` }
    const at = state[todo.rel] ?? { offset: 0, rows: 0, done: false }
    const { lines, next, eof } = await readLines(join(d.dir, todo.rel), at.offset, STEP_LINES)
    const parsed = lines.map(parseOhlcvtLine).filter((x) => x !== null)
    for (let i = 0; i < parsed.length; i += BATCH) {
      const batch = parsed.slice(i, i + BATCH)
      if (todo.daily) await upsertDailyBars(sql, batch.map((b): DailyBar => ({ symbol: todo.symbol, day: new Date(b.t).toISOString().slice(0, 10), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, source: FILE_SOURCE })))
      else await upsertBars(sql, batch.map((b): Bar => ({ symbol: todo.symbol, ...b, source: FILE_SOURCE })))
    }
    state[todo.rel] = { offset: next, rows: at.rows + parsed.length, done: eof }
    await saveJob(sql, "kraken_files", state)
    const last = parsed.at(-1)
    return { done: false, progress: `${todo.rel}: ${last ? new Date(last.t).toISOString().slice(0, 10) : "…"} (${state[todo.rel]!.rows.toLocaleString("en-US")} rows; ${list.filter((f) => state[f.rel]?.done).length}/${list.length} files)` }
  },
})

type Pending = { t: number; open: number; high: number; low: number; close: number; volume: number }
type GapSymbol = { since: string; until: number; pending: Pending | null; done: boolean; bars: number }
type GapState = Record<string, GapSymbol>

/** Trades (oldest first) into minute bars, merged onto `pending` when the first trade falls in its minute. */
export const toMinuteBars = (trades: { t: number; price: number; volume: number }[], pending: Pending | null): Pending[] => {
  const bars: Pending[] = pending ? [{ ...pending }] : []
  for (const tr of trades) {
    const t = Math.floor(tr.t / 60_000) * 60_000
    const last = bars.at(-1)
    if (last && last.t === t) {
      last.high = Math.max(last.high, tr.price)
      last.low = Math.min(last.low, tr.price)
      last.close = tr.price
      last.volume += tr.volume
    } else if (!last || t > last.t) {
      bars.push({ t, open: tr.price, high: tr.price, low: tr.price, close: tr.price, volume: tr.volume })
    }
  }
  return bars
}

export const krakenGapJob = (d: BackfillDeps, now: () => number = Date.now): HistoryJob => {
  let lastRequestAt = 0
  return {
    name: "kraken_gap",
    repeatMs: null,
    step: async (sql: Sql) => {
      // The gap is only known once the files are in.
      const files = await loadJob<FilesState>(sql, "kraken_files")
      if (d.dir && existsSync(d.dir) && (!files || importList(d.dir, d.universe(), d.pairs()).some((f) => !files.state[f.rel]?.done))) return { done: false, progress: "waiting for kraken_files", waitMs: 5 * 60_000 }
      const state = (await loadJob<GapState>(sql, "kraken_gap"))?.state ?? {}
      for (const symbol of d.universe()) {
        if (state[symbol]) continue
        const r = (
          await sql.query<{ last_file: Date | null; first_live: Date | null }>(
            "select (select max(t) from bars_1m where symbol = $1 and source = $2) as last_file, (select min(t) from bars_1m where symbol = $1 and source = $3) as first_live",
            [symbol, FILE_SOURCE, LIVE_SOURCE],
          )
        ).rows[0]
        const from = r?.last_file ? new Date(r.last_file).getTime() + 60_000 : null
        const until = r?.first_live ? new Date(r.first_live).getTime() : now()
        // Nothing to fill: no file history for this pair (listed after the files were cut), or no gap.
        state[symbol] = from && until > from ? { since: String(from * 1_000_000), until, pending: null, done: false, bars: 0 } : { since: "0", until, pending: null, done: true, bars: 0 }
      }
      const symbol = Object.keys(state).find((s) => !state[s]!.done && d.pairs().has(s))
      const filled = Object.values(state).reduce((s, x) => s + x.bars, 0)
      if (!symbol) {
        await saveJob(sql, "kraken_gap", state)
        return { done: true, progress: `${Object.keys(state).length} pairs, ${filled.toLocaleString("en-US")} minutes filled` }
      }
      const g = state[symbol]!
      const wait = lastRequestAt + GAP_REQUEST_MS - now()
      if (wait > 0) await sleep(wait)
      lastRequestAt = now()
      const { trades, last } = await d.rest.trades(d.pairs().get(symbol)!.restPair, g.since)
      const inGap = trades.filter((t) => t.t < g.until)
      const bars = toMinuteBars(inGap, g.pending)
      const finished = inGap.length < trades.length || trades.length === 0 || last === g.since
      // The newest minute may continue in the next response, unless this pair is finished.
      const complete = finished ? bars : bars.slice(0, -1)
      await upsertBars(sql, complete.map((b): Bar => ({ symbol, ...b, source: TRADES_SOURCE })))
      state[symbol] = { since: last, until: g.until, pending: finished ? null : (bars.at(-1) ?? g.pending), done: finished, bars: g.bars + complete.length }
      await saveJob(sql, "kraken_gap", state)
      const reached = complete.at(-1)?.t ?? null
      return { done: false, progress: `${symbol}: ${reached ? new Date(reached).toISOString().slice(0, 16).replace("T", " ") : "…"} (${(filled + complete.length).toLocaleString("en-US")} minutes; ${Object.values(state).filter((x) => x.done).length}/${Object.keys(state).length} pairs)` }
    },
  }
}

export const krakenDailyJob = (d: BackfillDeps): HistoryJob => {
  let todo: string[] | null = null
  let written = 0
  return {
    name: "kraken_daily",
    repeatMs: DAY_MS,
    step: async (sql: Sql) => {
      todo ??= [...d.universe()]
      const symbol = todo.shift()
      if (!symbol) {
        todo = null
        const n = written
        written = 0
        return { done: true, progress: `${n.toLocaleString("en-US")} daily bars refreshed` }
      }
      const pair = d.pairs().get(symbol)
      if (pair) {
        const candles = await d.rest.ohlc(pair.restPair, 1440)
        written += await upsertDailyBars(sql, candles.map((c): DailyBar => ({ symbol, day: new Date(c.t).toISOString().slice(0, 10), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, source: LIVE_SOURCE })))
      }
      return { done: false, progress: `${symbol} (${todo.length} left)` }
    },
  }
}
