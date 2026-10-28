import { hasTimescale, type Sql } from "./sql"

/**
 * The history store's schema (docs/plans/LOCAL-AI.md §6), the same in each bot's database.
 * Migrations run in order, each once, in its own transaction. The TimescaleDB part of a migration
 * (hypertables, compression) runs only where the extension is installed: on the server, not in
 * PGlite.
 *
 * Append a migration; never edit one that has shipped.
 */
export type Migration = { id: number; name: string; sql: string; timescale?: string }

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "bars and the news archive",
    sql: `
      create table bars_1m (
        symbol text not null,
        t timestamptz not null,
        open double precision not null,
        high double precision not null,
        low double precision not null,
        close double precision not null,
        volume double precision not null,
        source text not null,
        primary key (symbol, t)
      );

      create table news_items (
        id text primary key,
        first_seen_at timestamptz not null,
        source text not null,
        tier smallint not null,
        kind text not null,
        category text not null,
        title text not null,
        url text,
        domain text,
        symbols text[] not null,
        severity integer not null,
        cluster_id text not null,
        doc jsonb not null,
        archived_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index news_items_first_seen on news_items (first_seen_at desc);
      create index news_items_symbols on news_items using gin (symbols);

      create table news_triggers (
        id text primary key,
        at timestamptz not null,
        rule text not null,
        action text not null,
        status text not null,
        symbols text[] not null,
        severity integer not null,
        item_ids text[] not null,
        cycle_id text,
        doc jsonb not null,
        archived_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index news_triggers_at on news_triggers (at desc);

      -- Long-running jobs' progress (the news sync, later the backfills), so a restart resumes them.
      create table jobs (
        name text primary key,
        state jsonb not null default '{}',
        updated_at timestamptz not null default now()
      );
    `,
    timescale: `
      select create_hypertable('bars_1m', by_range('t', interval '7 days'));
      alter table bars_1m set (timescaledb.compress, timescaledb.compress_segmentby = 'symbol', timescaledb.compress_orderby = 't');
      select add_compression_policy('bars_1m', interval '7 days');
    `,
  },
  {
    id: 2,
    name: "daily bars",
    sql: `
      create table bars_1d (
        symbol text not null,
        day date not null,
        open double precision not null,
        high double precision not null,
        low double precision not null,
        close double precision not null,
        volume double precision not null,
        source text not null,
        primary key (symbol, day)
      );
    `,
  },
]

/** Any fixed number: the advisory lock that keeps two engines (an old and a new container during a deploy) from migrating at once. */
const MIGRATION_LOCK = 7_041_998

/**
 * Applies every migration not applied yet and returns the ids it applied. `sql` must be one
 * connection (a pool would spread a transaction over several).
 */
export const migrate = async (sql: Sql, migrations: Migration[] = MIGRATIONS): Promise<number[]> => {
  await sql.query("create table if not exists schema_migrations (id integer primary key, name text not null, applied_at timestamptz not null default now())")
  const timescale = await hasTimescale(sql)
  const applied: number[] = []
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    await sql.query("begin")
    try {
      await sql.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK])
      if ((await sql.query("select 1 from schema_migrations where id = $1", [m.id])).rows.length) {
        await sql.query("commit")
        continue
      }
      await sql.query(m.sql)
      if (timescale && m.timescale) await sql.query(m.timescale)
      await sql.query("insert into schema_migrations (id, name) values ($1, $2)", [m.id, m.name])
      await sql.query("commit")
      applied.push(m.id)
    } catch (error) {
      await sql.query("rollback")
      throw error
    }
  }
  return applied
}
