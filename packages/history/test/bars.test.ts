import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BarWriter, type Bar } from "../src/bars"
import { migrate } from "../src/migrations"
import type { Sql } from "../src/sql"
import { pglite } from "./helpers"

const T0 = Date.UTC(2026, 9, 27, 14, 30)
const bar = (symbol: string, minute: number, close: number, over: Partial<Bar> = {}): Bar => ({ symbol, t: T0 + minute * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 10, source: "kraken", ...over })

describe("BarWriter", () => {
  let sql: ReturnType<typeof pglite>
  beforeEach(async () => {
    sql = pglite()
    await migrate(sql)
  })
  afterEach(async () => {
    await sql.close()
  })

  const rows = async () => (await sql.query<{ symbol: string; t: Date; close: number; source: string }>("select symbol, t, close, source from bars_1m order by symbol, t")).rows

  it("writes buffered bars in batches, and a repeated minute replaces the first", async () => {
    const w = new BarWriter(() => sql, { batch: 2 })
    w.add(bar("BTC/USD", 0, 100))
    w.add(bar("BTC/USD", 1, 101))
    w.add(bar("ETH/USD", 0, 10))
    w.add(bar("BTC/USD", 1, 102))
    await w.flush()
    expect(await rows()).toEqual([
      { symbol: "BTC/USD", t: new Date(T0), close: 100, source: "kraken" },
      { symbol: "BTC/USD", t: new Date(T0 + 60_000), close: 102, source: "kraken" },
      { symbol: "ETH/USD", t: new Date(T0), close: 10, source: "kraken" },
    ])
    expect(w.status()).toMatchObject({ written: 4, dropped: 0, buffered: 0, last_error: null })
    w.add(bar("ETH/USD", 0, 11, { source: "iex" }))
    await w.flush()
    expect((await rows()).find((r) => r.symbol === "ETH/USD")).toMatchObject({ close: 11, source: "iex" })
  })

  it("ignores bars without a usable price", async () => {
    const w = new BarWriter(() => sql)
    w.add(bar("BTC/USD", 0, 0))
    w.add(bar("BTC/USD", 1, Number.NaN))
    expect(w.status().buffered).toBe(0)
  })

  it("keeps the bars while the store is down, drops the oldest past the cap, and writes the rest later", async () => {
    let up = false
    const failing: Sql = { query: () => Promise.reject(new Error("connection refused")) }
    const w = new BarWriter(() => (up ? sql : failing), { maxBuffer: 3 })
    w.add(bar("BTC/USD", 0, 100))
    w.add(bar("BTC/USD", 1, 101))
    await w.flush()
    expect(w.status()).toMatchObject({ written: 0, buffered: 2, last_error: "connection refused" })
    w.add(bar("BTC/USD", 2, 102))
    w.add(bar("BTC/USD", 3, 103))
    expect(w.status()).toMatchObject({ dropped: 1, buffered: 3 })
    up = true
    await w.flush()
    expect((await rows()).map((r) => r.close)).toEqual([101, 102, 103])
    expect(w.status()).toMatchObject({ written: 3, buffered: 0, last_error: null })
  })

  it("writes nothing until the store is ready", async () => {
    const w = new BarWriter(() => null)
    w.add(bar("BTC/USD", 0, 100))
    await w.flush()
    expect(w.status().buffered).toBe(1)
  })
})
