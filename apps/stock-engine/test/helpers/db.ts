import { useMongoTestDb } from "@mb/engine-kit/testing/db"
import { INDEXES } from "@mb/stock-core/db"
import { collectionsFor } from "../../src/db/mongo"

/**
 * A fresh database per test file (indexes included), emptied before every test.
 * Usage: `const db = useTestDb()` at the top of a describe block, then `db.col` inside tests.
 */
export const useTestDb = () => useMongoTestDb({ prefix: "smb_test", indexes: INDEXES, collections: collectionsFor })
