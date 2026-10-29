import type { AgentEpisodeDoc } from "@mb/core/agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { dailyBars, newsWithMoves, saveEpisode } from "../src/agent"
import { upsertDailyBars } from "../src/bars"
import { migrate } from "../src/migrations"
import { pglite } from "./helpers"

const DAY = 86_400_000
const now = new Date("2026-10-28T14:00:00Z")

describe("the agent's history", () => {
  let sql: ReturnType<typeof pglite>
  beforeEach(async () => {
    sql = pglite()
    await migrate(sql)
  })
  afterEach(async () => {
    await sql.close()
  })

  it("keeps the full episode, replacing it when it is saved again", async () => {
    const doc = { _id: "e1", started_at: now, priority: 1, subject: "SOL/USD", status: "running", steps: [] } as unknown as AgentEpisodeDoc
    await saveEpisode(sql, doc)
    await saveEpisode(sql, { ...doc, status: "answered", reply: "Bought." })
    const rows = (await sql.query<{ status: string; doc: { reply: string; started_at: string } }>("select status, doc from agent_episodes")).rows
    expect(rows).toEqual([{ status: "answered", doc: expect.objectContaining({ reply: "Bought.", started_at: now.toISOString() }) }])
  })

  it("reads a symbol's daily bars for the last N days, oldest first", async () => {
    const bar = (day: string, close: number) => ({ symbol: "BTC/USD", day, open: close, high: close + 1, low: close - 1, close, volume: 10, source: "test" })
    await upsertDailyBars(sql, [bar("2026-10-27", 102), bar("2026-10-20", 101), bar("2026-09-01", 90), { ...bar("2026-10-27", 5), symbol: "ETH/USD" }])
    expect(await dailyBars(sql, "BTC/USD", 30, now)).toEqual([
      { day: "2026-10-20", open: 101, high: 102, low: 100, close: 101, volume: 10 },
      { day: "2026-10-27", open: 102, high: 103, low: 101, close: 102, volume: 10 },
    ])
  })

  it("lists past news about a symbol, most severe first, with the moves after it", async () => {
    const item = (id: string, daysAgo: number, severity: number, symbols: string[]) =>
      sql.query(
        `insert into news_items (id, first_seen_at, source, tier, kind, category, title, url, domain, symbols, severity, cluster_id, doc)
         values ($1, $2::timestamptz, 'rekt', 2, 'news', 'exploit', $1, null, null, $3::text[], $4, $1, '{}'::jsonb)`,
        [id, new Date(now.getTime() - daysAgo * DAY).toISOString(), symbols, severity],
      )
    await item("old-hack", 200, 90, ["SOL/USD"])
    await item("small", 10, 40, ["SOL/USD"])
    await item("listing", 20, 70, ["SOL/USD", "ETH/USD"])
    await item("other", 5, 95, ["ETH/USD"])
    await sql.query("insert into news_moves (item_id, symbol, first_seen_at, price, ret_1h, ret_1d, ret_5d) values ('listing', 'SOL/USD', now(), 100, 0.01, 0.05, -0.02)")
    const rows = await newsWithMoves(sql, "SOL/USD", { days: 365, minSeverity: 50, limit: 10, now })
    expect(rows.map((r) => [r.id, r.severity, r.ret_1d])).toEqual([
      ["old-hack", 90, null],
      ["listing", 70, 0.05],
    ])
    expect((await newsWithMoves(sql, "SOL/USD", { days: 90, minSeverity: 50, limit: 10, now })).map((r) => r.id)).toEqual(["listing"])
  })
})
