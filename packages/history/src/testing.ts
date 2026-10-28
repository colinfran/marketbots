import { PGlite } from "@electric-sql/pglite"
import type { Sql } from "./sql"

/**
 * Postgres in-process for tests (PGlite; a dev dependency, never bundled into an engine). Like
 * node-postgres, a query without parameters may hold several statements (PGlite runs those
 * through exec); one with parameters is a single statement.
 */
export const pglite = (): Sql & { close(): Promise<void> } => {
  const db = new PGlite()
  return {
    query: async <R>(text: string, params?: unknown[]) => {
      if (params?.length) return (await db.query<R>(text, params)) as { rows: R[] }
      const results = await db.exec(text)
      return { rows: (results.at(-1)?.rows ?? []) as R[] }
    },
    close: () => db.close(),
  }
}
