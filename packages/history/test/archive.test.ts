import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NewsArchive } from "../src/archive"
import { migrate } from "../src/migrations"
import { item, pglite, trigger, useWireDb } from "./helpers"

const NOW = new Date("2026-10-27T15:00:00Z")
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

describe("NewsArchive", () => {
  const db = useWireDb()
  let sql: ReturnType<typeof pglite>
  beforeEach(async () => {
    sql = pglite()
    await migrate(sql)
  })
  afterEach(async () => {
    await sql.close()
  })

  const items = async () => (await sql.query<{ id: string; title: string; symbols: string[]; severity: number; doc: Record<string, unknown> }>("select id, title, symbols, severity, doc from news_items order by first_seen_at")).rows

  it("copies every item and trigger on the first sync, with the whole document", async () => {
    await db.col.wireItems.insertMany([item("a", ago(3 * 24 * 60)), item("b", ago(30), { symbols: [], severity: 71.6 })])
    await db.col.wireTriggers.insertOne(trigger("t1", ago(29)))
    const archive = new NewsArchive(db.col)
    expect(await archive.empty(sql)).toBe(true)
    expect(await archive.sync(sql, 3_650, NOW)).toBe(3)
    const rows = await items()
    expect(rows.map((r) => [r.id, r.symbols, r.severity])).toEqual([
      ["a", ["BTC/USD"], 42],
      ["b", [], 72],
    ])
    expect(rows[0]!.doc).toMatchObject({ _id: "a", title: "Headline a", first_seen_at: ago(3 * 24 * 60).toISOString(), price_at_seen: { "BTC/USD": 64000 } })
    const t = (await sql.query<{ id: string; rule: string; item_ids: string[] }>("select id, rule, item_ids from news_triggers")).rows
    expect(t).toEqual([{ id: "t1", rule: "held_negative", item_ids: ["a"] }])
    expect(archive.status(null)).toMatchObject({ items: 2, triggers: 1, last_sync_at: NOW })
  })

  it("appends what is new since the newest archived item, with an overlap", async () => {
    const archive = new NewsArchive(db.col)
    await db.col.wireItems.insertOne(item("a", ago(60)))
    await archive.append(sql, NOW)
    // Inserted late but stamped a few minutes before the newest archived item: the overlap catches it.
    await db.col.wireItems.insertMany([item("b", ago(65)), item("c", ago(1))])
    await db.col.wireTriggers.insertOne(trigger("t1", ago(1)))
    expect(await archive.append(sql, NOW)).toBe(4)
    expect((await items()).map((r) => r.id)).toEqual(["b", "a", "c"])
    expect(archive.status(null)).toMatchObject({ items: 3, triggers: 1, last_append_at: NOW })
  })

  it("replaces an item that changed after it was archived, and leaves unchanged ones alone", async () => {
    const archive = new NewsArchive(db.col)
    await db.col.wireItems.insertMany([item("a", ago(120)), item("b", ago(90))])
    await archive.sync(sql, 7, NOW)
    const before = (await sql.query<{ id: string; updated_at: Date }>("select id, updated_at from news_items order by id")).rows
    await db.col.wireItems.updateOne({ _id: "a" }, { $set: { notable: true, confirmations: [{ domain: "reuters.com", url: null, at: ago(10) }] } })
    await archive.sync(sql, 7, NOW)
    const after = (await sql.query<{ id: string; updated_at: Date; doc: { notable: boolean; confirmations: unknown[] } }>("select id, updated_at, doc from news_items order by id")).rows
    expect(after[0]!.doc.notable).toBe(true)
    expect(after[0]!.doc.confirmations).toHaveLength(1)
    expect(after[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(before[0]!.updated_at.getTime())
    expect(after[1]!.updated_at).toEqual(before[1]!.updated_at)
  })

  it("only copies the sync window, and strips characters Postgres refuses", async () => {
    const archive = new NewsArchive(db.col)
    await db.col.wireItems.insertMany([item("old", ago(10 * 24 * 60)), item("new", ago(60), { title: "Bad\u0000byte" })])
    expect(await archive.sync(sql, 7, NOW)).toBe(1)
    expect((await items()).map((r) => [r.id, r.title])).toEqual([["new", "Badbyte"]])
  })

  it("copies in batches larger than one statement", async () => {
    const archive = new NewsArchive(db.col)
    await db.col.wireItems.insertMany(Array.from({ length: 1_203 }, (_, i) => item(`i${i}`, ago(1_300 - i))))
    expect(await archive.sync(sql, 7, NOW)).toBe(1_203)
    expect(archive.status(null).items).toBe(1_203)
  })
})
