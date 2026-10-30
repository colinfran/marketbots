import "server-only"
import { DB_STORAGE_LIMIT_BYTES, type DatabaseStorageView } from "@mb/core/db"
import type { MongoClient } from "mongodb"
import { azureStorage, type AzureMonitorConfig } from "./azure"

const SYSTEM_DATABASES = new Set(["admin", "local", "config"])

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/** The databases as MongoDB reports them: the cluster's total (`listDatabases`) and each one (`dbStats`). */
const mongoStorage = async (client: MongoClient) => {
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
  return { used_bytes: Math.max(Number(totalSize ?? 0), sum), databases: sizes.sort((a, b) => b.bytes - a.bytes) }
}

/**
 * Admin → System's database card: the databases as MongoDB reports them and, with `azure`, the disk
 * as Azure Monitor counts it (logs and system files included), read in parallel. Both dashboards
 * show the whole cluster: the bots share it. Failures are shown on the card, never thrown, so the
 * Admin page still renders.
 */
export const databaseStorage = async (client: MongoClient, azure: AzureMonitorConfig | null): Promise<DatabaseStorageView> => {
  const [mongo, az] = await Promise.allSettled([mongoStorage(client), azure ? azureStorage(azure) : Promise.resolve(null)])
  return {
    used_bytes: mongo.status === "fulfilled" ? mongo.value.used_bytes : null,
    limit_bytes: DB_STORAGE_LIMIT_BYTES,
    databases: mongo.status === "fulfilled" ? mongo.value.databases : [],
    error: mongo.status === "rejected" ? message(mongo.reason) : null,
    azure: az.status === "fulfilled" ? az.value : null,
    azure_error: az.status === "rejected" ? message(az.reason) : null,
  }
}
