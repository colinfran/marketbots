import { randomUUID } from "node:crypto"
import type { IndexSpec } from "@mb/core/db"
import { MongoClient, type Db } from "mongodb"
import { afterAll, beforeEach, inject } from "vitest"
import { ensureIndexes } from "../db"

/**
 * A fresh database per test file on the global in-memory mongod (./global), indexes included,
 * emptied before every test. Each engine binds it to its own collections and indexes; usage:
 * `const db = useTestDb()` at the top of a describe block, then `db.col` inside tests.
 */
export const useMongoTestDb = <Col>({ prefix, indexes, collections }: { prefix: string; indexes: Readonly<Record<string, readonly IndexSpec[] | undefined>>; collections: (db: Db) => Col }) => {
  const state = { client: null as MongoClient | null, col: null as unknown as Col }
  const name = `${prefix}_${randomUUID().slice(0, 8)}`
  beforeEach(async () => {
    if (!state.client) {
      state.client = await new MongoClient(inject("mongoUri")).connect()
      await ensureIndexes(state.client.db(name), indexes)
      state.col = collections(state.client.db(name))
    }
    const db = state.client.db(name)
    for (const c of await db.collections()) await c.deleteMany({})
  })
  afterAll(async () => {
    await state.client?.db(name).dropDatabase()
    await state.client?.close()
  })
  return state
}
