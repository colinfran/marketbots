import "server-only"
import { MongoClient, type Db } from "mongodb"
import type { DashboardEnv } from "./env"

/**
 * MongoDB (Atlas) access for a dashboard. The dashboard reads everything the engine writes and
 * writes only three things: commands, audit entries and owner sign-in records (via Better Auth).
 * One client is reused per serverless instance (and across hot reloads in dev, under
 * `globalThis[globalKey]`). It connects on first use and reconnects on its own after a failure.
 * `collections` names the bot's collections with their document types.
 */
export const createDb = <C>({ globalKey, appName, env, collections }: { globalKey: string; appName: string; env: Pick<DashboardEnv, "mongoUri" | "mongoDb">; collections: (db: Db) => C }) => {
  const store = globalThis as unknown as Record<string, MongoClient | undefined>

  const mongoClient = (): MongoClient => {
    const uri = env.mongoUri()
    if (!uri) throw new Error("MONGODB_URI is not set")
    return (store[globalKey] ??= new MongoClient(uri, { maxPoolSize: 10, appName }))
  }

  const db = async (): Promise<Db> => mongoClient().db(env.mongoDb())

  return { mongoClient, db, collections: async () => collections(await db()) }
}
