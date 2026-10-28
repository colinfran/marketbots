import { silentLogger } from "@mb/engine-kit/log"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadJob } from "../src/jobs"
import type { Sql } from "../src/sql"
import { HistoryStore, syncDueSince } from "../src/store"
import { item, pglite, useWireDb } from "./helpers"

/** PGlite boots and migrates in a few seconds on a busy machine. */
const WAIT = { timeout: 20_000 }

describe("syncDueSince", () => {
  it("is today's 09:00 UTC after it, yesterday's before it", () => {
    expect(syncDueSince(new Date("2026-10-27T15:00:00Z"))).toEqual(new Date("2026-10-27T09:00:00Z"))
    expect(syncDueSince(new Date("2026-10-27T09:00:00Z"))).toEqual(new Date("2026-10-27T09:00:00Z"))
    expect(syncDueSince(new Date("2026-10-27T08:59:00Z"))).toEqual(new Date("2026-10-26T09:00:00Z"))
  })
})

describe("HistoryStore", () => {
  const db = useWireDb()
  let sql: ReturnType<typeof pglite>
  beforeEach(() => {
    sql = pglite()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await sql.close()
  })

  const store = () => new HistoryStore({ url: "unused", log: silentLogger, col: db.col, sql })

  it("migrates, copies the whole archive once, then flushes bars and appends news on its timers", async () => {
    await db.col.wireItems.insertMany([item("a", new Date(Date.now() - 20 * 86_400_000)), item("b", new Date(Date.now() - 60_000))])
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] })
    const s = store()
    expect(s.status()).toMatchObject({ ok: false, ready: false })
    s.start()
    await vi.waitFor(() => expect(s.status().news.items).toBe(2), WAIT)
    expect((await sql.query("select 1 from news_items")).rows).toHaveLength(2)
    expect(s.status()).toMatchObject({ ok: true, ready: true, last_error: null, news: { items: 2 } })
    await vi.waitFor(async () => expect(await loadJob(sql, "news_sync")).not.toBeNull(), WAIT)

    s.bars.add({ symbol: "BTC/USD", t: Date.now() - 120_000, open: 1, high: 2, low: 1, close: 2, volume: 3, source: "kraken" })
    await db.col.wireItems.insertOne(item("c", new Date()))
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(s.status().news.items).toBe(3), WAIT)
    expect((await sql.query("select 1 from bars_1m")).rows).toHaveLength(1)
    expect(s.status().bars).toMatchObject({ written: 1, buffered: 0 })
    await s.stop()
  })

  it("keeps retrying while the database is unreachable, without throwing", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] })
    let fail = true
    const flaky: Sql = { query: <R>(text: string, params?: unknown[]) => (fail ? Promise.reject(new Error("ECONNREFUSED")) : sql.query<R>(text, params)) }
    const s = new HistoryStore({ url: "unused", log: silentLogger, col: db.col, sql: flaky })
    s.start()
    await vi.waitFor(() => expect(s.status().last_error).toBe("ECONNREFUSED"), WAIT)
    expect(s.status()).toMatchObject({ ok: false, ready: false })
    fail = false
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(s.status()).toMatchObject({ ok: true, ready: true }), WAIT)
    await s.stop()
  })
})
