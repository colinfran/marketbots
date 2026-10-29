import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { migrate, MIGRATIONS } from "../src/migrations"
import { pglite } from "./helpers"

describe("migrate", () => {
  let sql: ReturnType<typeof pglite>
  beforeEach(() => {
    sql = pglite()
  })
  afterEach(async () => {
    await sql.close()
  })

  it("creates every table once and records each migration", async () => {
    expect(await migrate(sql)).toEqual(MIGRATIONS.map((m) => m.id))
    const tables = (await sql.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by tablename")).rows.map((r) => r.tablename)
    expect(tables).toEqual(["agent_episodes", "bars_1d", "bars_1m", "jobs", "news_items", "news_moves", "news_triggers", "schema_migrations"])
    expect(await migrate(sql)).toEqual([])
  })

  it("rolls a failing migration back and leaves it unrecorded", async () => {
    await migrate(sql)
    const broken = [...MIGRATIONS, { id: 999, name: "broken", sql: "create table half_done (x int); select no_such_function();" }]
    await expect(migrate(sql, broken)).rejects.toThrow()
    expect((await sql.query("select 1 from pg_tables where tablename = 'half_done'")).rows).toHaveLength(0)
    expect((await sql.query("select 1 from schema_migrations where id = 999")).rows).toHaveLength(0)
  })

  it("skips the TimescaleDB part where the extension isn't installed", async () => {
    await migrate(sql, [{ id: 1, name: "t", sql: "create table t (x int)", timescale: "select create_hypertable('t', 'x')" }])
    expect((await sql.query("select 1 from schema_migrations where id = 1")).rows).toHaveLength(1)
  })
})
