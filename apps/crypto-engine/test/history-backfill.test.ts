import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadJob, type HistoryJob } from "@mb/history/jobs"
import { migrate } from "@mb/history/migrations"
import { pglite } from "@mb/history/testing"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { krakenDailyJob, krakenFilesJob, krakenGapJob, parseOhlcvtLine, readLines, toMinuteBars, type BackfillDeps } from "../src/history/backfill"
import type { PairInfo } from "../src/venues/kraken/pairs"

const T0 = Date.UTC(2026, 8, 30, 23, 57) // 2026-09-30 23:57 UTC
const s = (ms: number) => Math.floor(ms / 1000)
const pair = (symbol: string, altname: string, restPair: string) => ({ symbol, altname, restPair }) as PairInfo
const PAIRS = new Map([
  ["BTC/USD", pair("BTC/USD", "XBTUSD", "XXBTZUSD")],
  ["ETH/USD", pair("ETH/USD", "ETHUSD", "XETHZUSD")],
])

describe("OHLCVT files", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ohlcvt-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("parses a line, and skips headers and unusable rows", () => {
    expect(parseOhlcvtLine("1782864000,58531.9,58617.8,58531.8,58617.8,2.54,131")).toEqual({ t: 1782864000000, open: 58531.9, high: 58617.8, low: 58531.8, close: 58617.8, volume: 2.54 })
    expect(parseOhlcvtLine("timestamp,open,high,low,close,volume,trades")).toBeNull()
    expect(parseOhlcvtLine("1782864000,1,1,1,0,1,1")).toBeNull()
    expect(parseOhlcvtLine("")).toBeNull()
  })

  it("reads whole lines from a byte offset and resumes where it stopped", async () => {
    const file = join(dir, "a.csv")
    writeFileSync(file, "1,a\r\n2,bé\n3,c\n4,d")
    const first = await readLines(file, 0, 2)
    expect(first).toMatchObject({ lines: ["1,a", "2,bé"], eof: false })
    const rest = await readLines(file, first.next, 10)
    expect(rest).toMatchObject({ lines: ["3,c", "4,d"], eof: true })
    expect(await readLines(file, rest.next, 10)).toMatchObject({ lines: [], eof: true })
  })
})

describe("crypto backfills", () => {
  let sql: ReturnType<typeof pglite>
  let dir: string
  beforeEach(async () => {
    sql = pglite()
    await migrate(sql)
    dir = mkdtempSync(join(tmpdir(), "ohlcvt-"))
  })
  afterEach(async () => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
    await sql.close()
  })

  const deps = (over: Partial<BackfillDeps> = {}): BackfillDeps => ({
    dir,
    rest: { trades: vi.fn(), ohlc: vi.fn() },
    pairs: () => PAIRS,
    universe: () => ["BTC/USD", "ETH/USD"],
    ...over,
  })
  const runUntilDone = async (job: HistoryJob, max = 50) => {
    for (let i = 0; i < max; i++) {
      const r = await job.step(sql)
      if (r.done) return r
    }
    throw new Error("job never finished")
  }
  const bars = async (symbol: string) =>
    (await sql.query<{ t: Date; open: number; high: number; low: number; close: number; volume: number; source: string }>("select t, open, high, low, close, volume, source from bars_1m where symbol = $1 order by t", [symbol])).rows

  it("imports every universe pair's 1-minute and daily files from each folder", async () => {
    mkdirSync(join(dir, "full"))
    mkdirSync(join(dir, "2026Q3"))
    writeFileSync(join(dir, "full", "XBTUSD_1.csv"), `${s(T0 - 120_000)},1,2,0.5,1.5,3,7\n${s(T0 - 60_000)},1.5,2,1,1.8,1,2\n`)
    writeFileSync(join(dir, "full", "XBTUSD_1440.csv"), `${s(Date.UTC(2026, 5, 29))},10,12,9,11,100,50\n`)
    writeFileSync(join(dir, "full", "XBTUSD_60.csv"), `${s(T0)},1,1,1,1,1,1\n`)
    writeFileSync(join(dir, "2026Q3", "XBTUSD_1.csv"), `${s(T0)},1.8,1.9,1.7,1.85,4,9\n`)
    const job = krakenFilesJob(deps())
    expect((await runUntilDone(job)).progress).toBe("3 files, 4 rows")
    expect((await bars("BTC/USD")).map((b) => [b.t.getTime(), b.close, b.source])).toEqual([
      [T0 - 120_000, 1.5, "kraken-file"],
      [T0 - 60_000, 1.8, "kraken-file"],
      [T0, 1.85, "kraken-file"],
    ])
    const daily = (await sql.query<{ symbol: string; day: Date; close: number }>("select symbol, day, close from bars_1d")).rows
    expect(daily).toEqual([{ symbol: "BTC/USD", day: new Date("2026-06-29T00:00:00Z"), close: 11 }])
    expect(await bars("ETH/USD")).toEqual([])
    // A second run (a restart) finds everything done.
    expect((await krakenFilesJob(deps()).step(sql)).done).toBe(true)
  })

  it("does nothing without an OHLCVT folder", async () => {
    expect(await krakenFilesJob(deps({ dir: null })).step(sql)).toMatchObject({ done: true })
    expect(await krakenFilesJob(deps({ dir: join(dir, "missing") })).step(sql)).toMatchObject({ done: true })
  })

  it("builds minute bars from trades, continuing a minute across responses", () => {
    const t = Date.UTC(2026, 9, 1, 0, 0)
    const first = toMinuteBars(
      [
        { t: t + 1_000, price: 10, volume: 1 },
        { t: t + 59_000, price: 12, volume: 2 },
        { t: t + 61_000, price: 11, volume: 1 },
      ],
      null,
    )
    expect(first).toEqual([
      { t, open: 10, high: 12, low: 10, close: 12, volume: 3 },
      { t: t + 60_000, open: 11, high: 11, low: 11, close: 11, volume: 1 },
    ])
    expect(toMinuteBars([{ t: t + 90_000, price: 9, volume: 4 }], first[1]!)).toEqual([{ t: t + 60_000, open: 11, high: 11, low: 9, close: 9, volume: 5 }])
  })

  it("fills the minutes between the last file bar and the first live bar from trades, paced", async () => {
    mkdirSync(join(dir, "full"))
    writeFileSync(join(dir, "full", "XBTUSD_1.csv"), `${s(T0)},100,100,100,100,1,1\n`)
    const files = krakenFilesJob(deps())
    await runUntilDone(files)
    const live = T0 + 4 * 60_000
    await sql.query("insert into bars_1m values ('BTC/USD', to_timestamp($1), 1, 1, 1, 1, 1, 'kraken')", [live / 1000])
    const trades = vi.fn()
    // Two pages that split the minute T0+2m, then a page that crosses into the live feed.
    trades
      .mockResolvedValueOnce({ trades: [{ t: T0 + 60_000 + 5_000, price: 101, volume: 1 }, { t: T0 + 120_000 + 1_000, price: 102, volume: 1 }], last: "p2" })
      .mockResolvedValueOnce({ trades: [{ t: T0 + 120_000 + 30_000, price: 99, volume: 2 }, { t: T0 + 180_000, price: 103, volume: 1 }], last: "p3" })
      .mockResolvedValueOnce({ trades: [{ t: T0 + 180_000 + 10_000, price: 104, volume: 1 }, { t: live + 5_000, price: 200, volume: 9 }], last: "p4" })
    vi.useFakeTimers({ toFake: ["setTimeout"] })
    let now = live + 3_600_000
    const job = krakenGapJob(deps({ rest: { trades, ohlc: vi.fn() }, universe: () => ["BTC/USD"] }), () => now)
    let r: Awaited<ReturnType<HistoryJob["step"]>> | null = null
    for (let i = 0; i < 6 && !r?.done; i++) {
      const p = job.step(sql)
      await vi.advanceTimersByTimeAsync(4_000)
      now += 4_000
      r = await p
    }
    expect(r?.done).toBe(true)
    expect(trades).toHaveBeenCalledTimes(3)
    expect(trades.mock.calls[0]).toEqual(["XXBTZUSD", String((T0 + 60_000) * 1_000_000)])
    expect(trades.mock.calls[1]![1]).toBe("p2")
    expect((await bars("BTC/USD")).map((b) => [b.t.getTime() - T0, b.open, b.high, b.low, b.close, b.volume, b.source])).toEqual([
      [0, 100, 100, 100, 100, 1, "kraken-file"],
      [60_000, 101, 101, 101, 101, 1, "kraken-trades"],
      [120_000, 102, 102, 99, 99, 3, "kraken-trades"],
      [180_000, 103, 104, 103, 104, 2, "kraken-trades"],
      [240_000, 1, 1, 1, 1, 1, "kraken"],
    ])
    expect((await loadJob<Record<string, { done: boolean; bars: number }>>(sql, "kraken_gap"))?.state["BTC/USD"]).toMatchObject({ done: true, bars: 3 })
  })

  it("marks pairs without file history as nothing to fill", async () => {
    const trades = vi.fn()
    const job = krakenGapJob(deps({ dir: null, rest: { trades, ohlc: vi.fn() } }))
    expect(await job.step(sql)).toMatchObject({ done: true })
    expect(trades).not.toHaveBeenCalled()
  })

  it("refreshes daily bars from the OHLC endpoint, one pair per step, and again next time", async () => {
    const day = Date.UTC(2026, 9, 26)
    const ohlc = vi.fn().mockResolvedValue([{ t: day, open: 1, high: 2, low: 0.5, close: 1.5, vwap: 1, volume: 10, trades: 3 }])
    const job = krakenDailyJob(deps({ rest: { trades: vi.fn(), ohlc } }))
    expect((await runUntilDone(job)).progress).toBe("2 daily bars refreshed")
    expect(ohlc.mock.calls).toEqual([
      ["XXBTZUSD", 1440],
      ["XETHZUSD", 1440],
    ])
    expect((await runUntilDone(job)).progress).toBe("2 daily bars refreshed")
    expect(ohlc).toHaveBeenCalledTimes(4)
  })
})
