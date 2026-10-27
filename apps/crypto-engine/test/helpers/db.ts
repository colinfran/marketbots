import { randomUUID } from "node:crypto"
import { MongoClient } from "mongodb"
import { afterAll, beforeEach, inject } from "vitest"
import { collectionsFor, ensureIndexes, type Collections } from "../../src/db/mongo"

/**
 * A fresh database per test file (indexes included), emptied before every test.
 * Usage: `const db = useTestDb()` at the top of a describe block, then `db.col` inside tests.
 */
export const useTestDb = () => {
  const state = { client: null as MongoClient | null, col: null as unknown as Collections }
  const name = `cmb_test_${randomUUID().slice(0, 8)}`
  beforeEach(async () => {
    if (!state.client) {
      state.client = await new MongoClient(inject("mongoUri")).connect()
      await ensureIndexes(state.client.db(name))
      state.col = collectionsFor(state.client.db(name))
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
