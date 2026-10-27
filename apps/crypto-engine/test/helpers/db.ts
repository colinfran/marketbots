import { INDEXES } from "@mb/crypto-core/db"
import { useMongoTestDb } from "@mb/engine-kit/testing/db"
import { collectionsFor } from "../../src/db/mongo"

/**
 * A fresh database per test file (indexes included), emptied before every test.
 * Usage: `const db = useTestDb()` at the top of a describe block, then `db.col` inside tests.
 */
export const useTestDb = () => useMongoTestDb({ prefix: "cmb_test", indexes: INDEXES, collections: collectionsFor })
