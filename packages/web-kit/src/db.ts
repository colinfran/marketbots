import "server-only"
import { MongoClient, type Db } from "mongodb"
import type { DashboardEnv } from "./env"

/**
 * MongoDB access for a dashboard (the stack's own `mongo`, as the bot's dashboard user). The dashboard
 * reads everything the engine writes and writes only audit entries, login rate limits, rate-limit bans and owner
 * sign-in records (via Better Auth). One client per process (reused across hot reloads in dev, under
 * `globalThis[globalKey]`). It connects on first use and reconnects on its own after a failure.
 * `collections` names the bot's collections with their document types.
 * At most 4 connections: set for the Azure free tier (which refused queries that arrived all at once,
 * code 261) and kept, so a page's other queries wait their turn here.
 */
export const createDb = <C>({ globalKey, appName, env, collections }: { globalKey: string; appName: string; env: Pick<DashboardEnv, "mongoUri" | "mongoDb">; collections: (db: Db) => C }) => {
  const store = globalThis as unknown as Record<string, MongoClient | undefined>

  const mongoClient = (): MongoClient => {
    const uri = env.mongoUri()
    if (!uri) throw new Error("MONGODB_URI is not set")
    return (store[globalKey] ??= new MongoClient(uri, { maxPoolSize: 4, appName }))
  }

  const db = async (): Promise<Db> => mongoClient().db(env.mongoDb())

  return { mongoClient, db, collections: async () => collections(await db()) }
}
