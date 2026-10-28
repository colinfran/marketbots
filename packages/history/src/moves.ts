import type { HistoryJob } from "./jobs"
import type { Sql } from "./sql"

/**
 * The moves after each news item (docs/plans/LOCAL-AI.md §6.2): for every archived item and every
 * symbol it names (the bot's benchmark when it names none), the last 1-minute close at or before
 * the moment we first saw it, and the return to the last close at or before 1 hour, 1 day and 5
 * days later. Calendar time: for a stock, "1 hour later" overnight is the last close before it.
 *
 * A row is computed when its item is archived and again every half hour until its 5-day horizon
 * has passed, then left alone; a symbol without bars keeps nulls. Bars a backfill brings in before
 * that are picked up by the next recompute.
 */

/** Items and symbols to (re)compute per step. */
const BATCH = 2_000

export const updateMoves = async (sql: Sql, benchmark: string, limit = BATCH): Promise<number> => {
  const r = await sql.query<{ n: number }>(
    `with todo as (
       select i.id, i.first_seen_at, s.symbol
       from news_items i
       cross join lateral unnest(case when cardinality(i.symbols) = 0 then array[$1::text] else i.symbols end) as s (symbol)
       left join news_moves m on m.item_id = i.id and m.symbol = s.symbol
       where m.item_id is null
          or (m.computed_at < i.first_seen_at + interval '5 days 1 hour' and m.computed_at < now() - interval '30 minutes')
       order by i.first_seen_at
       limit $2
     ),
     computed as (
       select t.id, t.symbol, t.first_seen_at, p0.close as price,
         case when now() >= t.first_seen_at + interval '1 hour' then p1.close / p0.close - 1 end as ret_1h,
         case when now() >= t.first_seen_at + interval '1 day' then p24.close / p0.close - 1 end as ret_1d,
         case when now() >= t.first_seen_at + interval '5 days' then p120.close / p0.close - 1 end as ret_5d
       from todo t
       left join lateral (select close from bars_1m b where b.symbol = t.symbol and b.t <= t.first_seen_at and b.t > t.first_seen_at - interval '4 days' order by b.t desc limit 1) p0 on true
       left join lateral (select close from bars_1m b where b.symbol = t.symbol and b.t <= t.first_seen_at + interval '1 hour' and b.t > t.first_seen_at order by b.t desc limit 1) p1 on true
       left join lateral (select close from bars_1m b where b.symbol = t.symbol and b.t <= t.first_seen_at + interval '1 day' and b.t > t.first_seen_at order by b.t desc limit 1) p24 on true
       left join lateral (select close from bars_1m b where b.symbol = t.symbol and b.t <= t.first_seen_at + interval '5 days' and b.t > t.first_seen_at order by b.t desc limit 1) p120 on true
     ),
     upserted as (
       insert into news_moves (item_id, symbol, first_seen_at, price, ret_1h, ret_1d, ret_5d, computed_at)
       select id, symbol, first_seen_at, price, ret_1h, ret_1d, ret_5d, now() from computed
       on conflict (item_id, symbol) do update set price = excluded.price, ret_1h = excluded.ret_1h, ret_1d = excluded.ret_1d, ret_5d = excluded.ret_5d, computed_at = excluded.computed_at
       returning 1
     )
     select count(*)::int as n from upserted`,
    [benchmark, limit],
  )
  return r.rows[0]?.n ?? 0
}

/** The moves job: every half hour, every item that needs it, `BATCH` rows a step. */
export const newsMovesJob = (benchmark: string): HistoryJob => ({
  name: "news_moves",
  repeatMs: 30 * 60_000,
  step: async (sql) => {
    const n = await updateMoves(sql, benchmark)
    const total = (await sql.query<{ n: number; priced: number }>("select count(*)::int as n, count(price)::int as priced from news_moves")).rows[0]
    return { done: n < BATCH, progress: `${total?.n.toLocaleString("en-US") ?? 0} item moves, ${total?.priced.toLocaleString("en-US") ?? 0} priced` }
  },
})
