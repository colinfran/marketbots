import "server-only"
import { DB_STORAGE_LIMIT_BYTES, type DatabaseStorageView } from "@mb/core/db"
import type { MongoClient } from "mongodb"

const SYSTEM_DATABASES = new Set(["admin", "local", "config"])

/**
 * Admin → System's database card: the cluster's size on disk (`listDatabases`) and each database's
 * (`dbStats`: documents and indexes, with their free space), against DB_STORAGE_LIMIT_BYTES. Both
 * dashboards show the whole cluster: the bots share it. A failure is shown on the card, never
 * thrown, so the Admin page still renders.
 */
export const databaseStorage = async (client: MongoClient): Promise<DatabaseStorageView> => {
  try {
    const { databases, totalSize } = await client.db("admin").admin().listDatabases()
    const sizes = await Promise.all(
      databases
        .map((d) => d.name)
        .filter((name) => !SYSTEM_DATABASES.has(name))
        .map(async (name) => {
          const s = await client.db(name).stats()
          return { name, bytes: Number(s.totalSize ?? (s.storageSize ?? 0) + (s.indexSize ?? 0)) }
        }),
    )
    // Atlas sums its databases into totalSize; DocumentDB reports the cluster, which also counts what
    // isn't one of them. Either way, never less than the databases themselves.
    const sum = sizes.reduce((total, d) => total + d.bytes, 0)
    return { used_bytes: Math.max(Number(totalSize ?? 0), sum), limit_bytes: DB_STORAGE_LIMIT_BYTES, databases: sizes.sort((a, b) => b.bytes - a.bytes), error: null }
  } catch (error) {
    return { used_bytes: null, limit_bytes: DB_STORAGE_LIMIT_BYTES, databases: [], error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  }
}
