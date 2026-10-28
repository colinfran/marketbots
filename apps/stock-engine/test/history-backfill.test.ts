import type { HistoryJob } from "@mb/history/jobs"
import { loadJob } from "@mb/history/jobs"
import { migrate } from "@mb/history/migrations"
import { pglite } from "@mb/history/testing"
import type { Bar } from "@mb/stock-core/alpaca"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HISTORY_START, stockBackfillJobs, type StockBackfillDeps } from "../src/history/backfill"

const NOW = Date.parse("2026-10-28T15:00:00Z")
const bar = (t: string, c: number): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 1_000, vw: c, n: 10 })

describe("stock backfills", () => {
  let sql: ReturnType<typeof pglite>
  beforeEach(async () => {
    sql = pglite()
    await migrate(sql)
    vi.useFakeTimers({ toFake: ["setTimeout"] })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await sql.close()
  })

  let clock = NOW
  const deps = (getBarsPage: StockBackfillDeps["alpaca"]["getBarsPage"], over: Partial<StockBackfillDeps> = {}): StockBackfillDeps => ({
    alpaca: { getBarsPage },
    universe: () => ["AAPL", "MSFT"],
    extra: () => ["SPY"],
    now: () => clock,
    ...over,
  })
  /** One step, with the 2 s pacing played out on the fake clock. */
  const step = async (job: HistoryJob) => {
    const p = job.step(sql)
    await vi.advanceTimersByTimeAsync(2_000)
    clock += 2_000
    return p
  }

  it("fetches daily history from 2016 in batches, following pages, then refreshes the last 10 days once a day", async () => {
    clock = NOW
    const getBarsPage = vi
      .fn()
      .mockResolvedValueOnce({ bars: { SPY: [bar("2016-01-04T05:00:00Z", 200)], AAPL: [bar("2016-01-04T05:00:00Z", 100)] }, next: "p2" })
      .mockResolvedValueOnce({ bars: { MSFT: [bar("2026-10-27T04:00:00Z", 500)] }, next: null })
      .mockResolvedValue({ bars: { SPY: [bar("2026-10-27T04:00:00Z", 690)] }, next: null })
    const [daily] = stockBackfillJobs(deps(getBarsPage))
    expect((await step(daily!)).progress).toBe("history SPY…MSFT (3): 2016-01-04; 0/3 symbols, 2 bars")
    expect((await step(daily!)).progress).toBe("history SPY…MSFT (3): 2026-10-27; 3/3 symbols, 3 bars")
    expect(getBarsPage.mock.calls[0]).toEqual([["SPY", "AAPL", "MSFT"], "1Day", HISTORY_START, new Date(NOW - 20 * 60_000), null])
    expect(getBarsPage.mock.calls[1]![4]).toBe("p2")
    // History done: the refresh pass covers the last 10 days of every symbol, then the job is done for the day.
    const refresh = await step(daily!)
    expect(refresh.progress).toMatch(/^refreshing SPY…MSFT \(3\)/)
    expect(getBarsPage.mock.calls[2]![2]).toEqual(new Date(NOW + 4_000 - 10 * 86_400_000))
    expect((await step(daily!)).done).toBe(true)
    expect((await step(daily!)).done).toBe(true)
    expect(getBarsPage).toHaveBeenCalledTimes(3)
    const rows = (await sql.query<{ symbol: string; day: Date; close: number; source: string }>("select symbol, day, close, source from bars_1d order by symbol, day")).rows
    expect(rows.map((r) => [r.symbol, r.day.toISOString().slice(0, 10), r.close, r.source])).toEqual([
      ["AAPL", "2016-01-04", 100, "sip"],
      ["MSFT", "2026-10-27", 500, "sip"],
      ["SPY", "2016-01-04", 200, "sip"],
      ["SPY", "2026-10-27", 690, "sip"],
    ])
  })

  it("backfills minutes one symbol at a time, the benchmarks first, and picks up new universe symbols later", async () => {
    clock = NOW
    let universe = ["AAPL"]
    const getBarsPage = vi.fn<StockBackfillDeps["alpaca"]["getBarsPage"]>(async (symbols) => ({ bars: { [symbols[0]!]: [bar("2026-10-27T13:30:00Z", 10), bar("2026-10-27T13:31:00Z", 11)] }, next: null }))
    const [, minute] = stockBackfillJobs(deps(getBarsPage, { universe: () => universe }))
    await step(minute!)
    await step(minute!)
    expect(getBarsPage.mock.calls.map((c) => c[0])).toEqual([["SPY"], ["AAPL"]])
    expect(getBarsPage.mock.calls[0]![1]).toBe("1Min")
    universe = ["AAPL", "NVDA"]
    expect((await step(minute!)).progress).toBe("history NVDA: 2026-10-27; 3/3 symbols, 6 bars")
    const rows = (await sql.query<{ symbol: string; t: Date; source: string }>("select symbol, t, source from bars_1m order by symbol, t")).rows
    expect(rows).toHaveLength(6)
    expect(rows[0]).toEqual({ symbol: "AAPL", t: new Date("2026-10-27T13:30:00Z"), source: "sip" })
    expect((await loadJob<{ done: string[] }>(sql, "alpaca_minute"))?.state.done).toEqual(["SPY", "AAPL", "NVDA"])
  })

  it("resumes a symbol's pages after a restart", async () => {
    clock = NOW
    const first = vi.fn().mockResolvedValue({ bars: { SPY: [bar("2016-01-04T14:30:00Z", 200)] }, next: "page-2" })
    await step(stockBackfillJobs(deps(first, { universe: () => [] }))[1]!)
    const second = vi.fn().mockResolvedValue({ bars: { SPY: [bar("2016-01-05T14:30:00Z", 201)] }, next: null })
    await step(stockBackfillJobs(deps(second, { universe: () => [] }))[1]!)
    expect(second.mock.calls[0]!.slice(0, 1)).toEqual([["SPY"]])
    expect(second.mock.calls[0]![4]).toBe("page-2")
  })

  it("spaces requests at least 2 s apart across both jobs", async () => {
    clock = NOW
    const getBarsPage = vi.fn().mockResolvedValue({ bars: {}, next: null })
    const [daily, minute] = stockBackfillJobs(deps(getBarsPage))
    const a = daily!.step(sql)
    await vi.advanceTimersByTimeAsync(0)
    const b = minute!.step(sql)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(getBarsPage).toHaveBeenCalledTimes(1)
    clock += 2_000
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([a, b])
    expect(getBarsPage).toHaveBeenCalledTimes(2)
  })
})
