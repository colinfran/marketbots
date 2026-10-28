import type { Sql } from "./sql"

/** A job's saved progress and when it was last saved, or null if it never ran. */
export const loadJob = async <T>(sql: Sql, name: string): Promise<{ state: T; updated_at: Date } | null> =>
  (await sql.query<{ state: T; updated_at: Date }>("select state, updated_at from jobs where name = $1", [name])).rows[0] ?? null

export const saveJob = async (sql: Sql, name: string, state: unknown, now = new Date()) => {
  await sql.query("insert into jobs (name, state, updated_at) values ($1, $2::jsonb, $3) on conflict (name) do update set state = excluded.state, updated_at = excluded.updated_at", [name, JSON.stringify(state), now])
}
