/**
 * The query surface the history store needs. node-postgres's Pool (production) and PGlite (tests,
 * Postgres compiled to WebAssembly) both provide it, so every query runs unchanged on either.
 */
export type Sql = {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>
}

/** True when the TimescaleDB extension is installed in this database (the server's image has it; PGlite doesn't). */
export const hasTimescale = async (sql: Sql) => (await sql.query("select 1 from pg_extension where extname = 'timescaledb'")).rows.length > 0
