import type { AgentEpisodeDoc } from "@mb/core/agent"
import type { Sql } from "./sql"

/**
 * What the agent keeps in and reads from the history store (docs/plans/LOCAL-AI.md §8.3, §8.6): the
 * full record of every episode (MongoDB keeps a capped copy for the dashboard), and two lookups its
 * tools make, years deep: daily bars, and past news about a symbol with the moves after each item.
 */

export const saveEpisode = async (sql: Sql, doc: AgentEpisodeDoc) => {
  await sql.query(
    `insert into agent_episodes (id, started_at, priority, subject, status, doc)
     values ($1, $2::timestamptz, $3, $4, $5, $6::jsonb)
     on conflict (id) do update set status = excluded.status, doc = excluded.doc`,
    [doc._id, doc.started_at.toISOString(), doc.priority, doc.subject, doc.status, JSON.stringify(doc)],
  )
}

export type DayBar = { day: string; open: number; high: number; low: number; close: number; volume: number }

/** The symbol's daily bars over the last `days` calendar days, oldest first. */
export const dailyBars = async (sql: Sql, symbol: string, days: number, now = new Date()): Promise<DayBar[]> => {
  const from = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)
  const r = await sql.query<DayBar>(
    "select to_char(day, 'YYYY-MM-DD') as day, open, high, low, close, volume from bars_1d where symbol = $1 and day >= $2::date order by day",
    [symbol, from],
  )
  return r.rows.map((b) => ({ day: b.day, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume) }))
}

export type PastNews = {
  id: string
  first_seen_at: Date
  title: string
  source: string
  category: string
  severity: number
  url: string | null
  /** The symbol's return 1 hour, 1 day and 5 days after we first saw the item (null until known). */
  ret_1h: number | null
  ret_1d: number | null
  ret_5d: number | null
}

/** Archived items naming the symbol, most severe first, with the moves after each. */
export const newsWithMoves = async (sql: Sql, symbol: string, { days, minSeverity, limit, now = new Date() }: { days: number; minSeverity: number; limit: number; now?: Date }): Promise<PastNews[]> => {
  const r = await sql.query<PastNews>(
    `select i.id, i.first_seen_at, i.title, i.source, i.category, i.severity, i.url, m.ret_1h, m.ret_1d, m.ret_5d
     from news_items i
     left join news_moves m on m.item_id = i.id and m.symbol = $1
     where $1 = any (i.symbols) and i.first_seen_at >= $2::timestamptz and i.severity >= $3
     order by i.severity desc, i.first_seen_at desc
     limit $4`,
    [symbol, new Date(now.getTime() - days * 86_400_000).toISOString(), minSeverity, limit],
  )
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return r.rows.map((row) => ({ ...row, first_seen_at: new Date(row.first_seen_at), severity: Number(row.severity), ret_1h: n(row.ret_1h), ret_1d: n(row.ret_1d), ret_5d: n(row.ret_5d) }))
}
