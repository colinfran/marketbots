import type { IndexSpec } from "@mb/core/db"
import { MongoClient, type Db } from "mongodb"
import { errorMessage, type Logger } from "./log"
import { backoffMs, sleep } from "./util/async"

/**
 * The engine's long-lived MongoDB connection. The engine is the only writer of its bot's trading
 * state, which together with the single-instance lease means those documents never see concurrent
 * writers. Each bot passes its collection map (`collections`) and its `INDEXES`.
 */

export type Database<Col> = { client: MongoClient; db: Db; col: Col }

/** Creates the bot's indexes (idempotent). */
export const ensureIndexes = async (db: Db, indexes: Readonly<Record<string, readonly IndexSpec[] | undefined>>) => {
  await Promise.all(
    Object.entries(indexes).map(([name, specs]) =>
      specs && specs.length ? db.collection(name).createIndexes(specs.map((s) => ({ ...s }))) : Promise.resolve(),
    ),
  )
}

export type ConnectOptions<Col> = {
  uri: string
  dbName: string
  /** Shown in the database's connection list, e.g. "cryptomarketbot-engine". */
  appName: string
  indexes: Readonly<Record<string, readonly IndexSpec[] | undefined>>
  collections: (db: Db) => Col
  log: Logger
}

const connectOnce = async <Col>({ uri, dbName, appName, indexes, collections }: ConnectOptions<Col>): Promise<Database<Col>> => {
  const client = new MongoClient(uri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 15_000,
    retryWrites: true,
    appName,
  })
  await client.connect()
  const db = client.db(dbName)
  await ensureIndexes(db, indexes)
  return { client, db, col: collections(db) }
}

/** Connects, retrying until it works: the container may start before the network is up. */
export const connectMongo = async <Col>(opts: ConnectOptions<Col>): Promise<Database<Col>> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connectOnce(opts)
    } catch (error) {
      opts.log.warn("MongoDB connection failed; retrying", { attempt, error: errorMessage(error) })
      await sleep(Math.max(2_000, backoffMs(attempt, 2_000, 30_000)))
    }
  }
}
