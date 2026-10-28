import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { upsertBars } from "../src/bars"
import { migrate } from "../src/migrations"
import { newsMovesJob, updateMoves } from "../src/moves"
import { pglite } from "./helpers"

const HOUR = 3_600_000
const MIN = 60_000

describe("news moves", () => {
  let sql: ReturnType<typeof pglite>
  let now: number
  beforeEach(async () => {
    sql = pglite()
    await migrate(sql)
    // Whole minutes, relative to the database's clock (the query uses now()).
    now = Math.floor(Date.now() / MIN) * MIN
  })
  afterEach(async () => {
    await sql.close()
  })

  const item = (id: string, firstSeen: number, symbols: string[]) =>
    sql.query(
      `insert into news_items (id, first_seen_at, source, tier, kind, category, title, url, domain, symbols, severity, cluster_id, doc)
       values ($1, to_timestamp($2 / 1000.0), 'test', 2, 'news', 'listing', $1, null, null, $3::text[], 50, $1, '{}'::jsonb)`,
      [id, firstSeen, symbols],
    )
  const bar = (symbol: string, t: number, close: number) => ({ symbol, t, open: close, high: close, low: close, close, volume: 1, source: "test" })
  const moves = async () =>
    (await sql.query<{ item_id: string; symbol: string; price: number | null; ret_1h: number | null; ret_1d: number | null; ret_5d: number | null }>("select item_id, symbol, price, ret_1h, ret_1d, ret_5d from news_moves order by item_id, symbol")).rows

  it("prices each symbol when first seen and fills each horizon once it has passed", async () => {
    const seen = now - 2 * 24 * HOUR
    await item("a", seen, ["AAA"])
    await upsertBars(sql, [bar("AAA", seen - 2 * MIN, 100), bar("AAA", seen + 30 * MIN, 105), bar("AAA", seen + 59 * MIN, 110), bar("AAA", seen + 23 * HOUR, 120), bar("AAA", seen + 25 * HOUR, 999)])
    expect(await updateMoves(sql, "SPY")).toBe(1)
    const [m] = await moves()
    expect(m).toMatchObject({ item_id: "a", symbol: "AAA", price: 100, ret_5d: null })
    expect(m!.ret_1h).toBeCloseTo(0.1)
    expect(m!.ret_1d).toBeCloseTo(0.2)
  })

  it("uses the benchmark for a market-wide item, and keeps nulls when there are no bars", async () => {
    await item("m", now - 6 * 24 * HOUR, [])
    await item("x", now - 3 * HOUR, ["NOBARS"])
    await upsertBars(sql, [bar("SPY", now - 6 * 24 * HOUR - MIN, 500), bar("SPY", now - 24 * HOUR - 6 * HOUR, 550)])
    expect(await updateMoves(sql, "SPY")).toBe(2)
    const rows = await moves()
    expect(rows[0]).toMatchObject({ item_id: "m", symbol: "SPY", price: 500 })
    expect(rows[0]!.ret_5d).toBeCloseTo(0.1)
    expect(rows[1]).toMatchObject({ item_id: "x", symbol: "NOBARS", price: null, ret_1h: null })
  })

  it("leaves rows alone between recomputes and after their last horizon", async () => {
    await item("old", now - 10 * 24 * HOUR, ["AAA"])
    await item("new", now - 2 * HOUR, ["AAA"])
    expect(await updateMoves(sql, "SPY")).toBe(2)
    // Recomputed at most every half hour, and never once the 5-day horizon has passed.
    expect(await updateMoves(sql, "SPY")).toBe(0)
    await sql.query("update news_moves set computed_at = computed_at - interval '1 hour'")
    expect(await updateMoves(sql, "SPY")).toBe(1)
  })

  it("is a job that reports its totals", async () => {
    await item("a", now - HOUR, ["AAA", "BBB"])
    expect(await newsMovesJob("SPY").step(sql)).toEqual({ done: true, progress: "2 item moves, 0 priced" })
  })
})
