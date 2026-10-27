import { COLLECTIONS, INDEXES } from "@mb/crypto-core/db"
import type {
  AccountDoc,
  AiCallDoc,
  AuditDoc,
  BacktestDoc,
  CommandDoc,
  CycleDoc,
  DailyStatsDoc,
  DecisionDoc,
  EngineStateDoc,
  EngineStatusDoc,
  EventDoc,
  FillDoc,
  LeaseDoc,
  NotificationDoc,
  OrderDoc,
  PositionDoc,
  ResearchDoc,
  SeedRunDoc,
  SettingsDoc,
  SnapshotDoc,
} from "@mb/crypto-core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/crypto-core/wire"
import { MongoClient, type Collection, type Db } from "mongodb"

/**
 * The engine's long-lived MongoDB connection. The engine is the only writer of trading state
 * (positions, orders, fills, accounts), which together with the single-instance lease means those
 * documents never see concurrent writers.
 */

export type Collections = {
  settings: Collection<SettingsDoc>
  engineState: Collection<EngineStateDoc>
  engineStatus: Collection<EngineStatusDoc>
  lease: Collection<LeaseDoc>
  events: Collection<EventDoc>
  commands: Collection<CommandDoc>
  audit: Collection<AuditDoc>
  accounts: Collection<AccountDoc>
  positions: Collection<PositionDoc>
  orders: Collection<OrderDoc>
  fills: Collection<FillDoc>
  cycles: Collection<CycleDoc>
  research: Collection<ResearchDoc>
  decisions: Collection<DecisionDoc>
  snapshots: Collection<SnapshotDoc>
  dailyStats: Collection<DailyStatsDoc>
  aiCalls: Collection<AiCallDoc>
  backtests: Collection<BacktestDoc>
  notifications: Collection<NotificationDoc>
  seedRuns: Collection<SeedRunDoc>
  wireItems: Collection<WireItemDoc>
  wireTriggers: Collection<WireTriggerDoc>
}

export type Database = { client: MongoClient; db: Db; col: Collections }

export const collectionsFor = (db: Db): Collections => ({
  settings: db.collection<SettingsDoc>(COLLECTIONS.settings),
  engineState: db.collection<EngineStateDoc>(COLLECTIONS.engineState),
  engineStatus: db.collection<EngineStatusDoc>(COLLECTIONS.engineStatus),
  lease: db.collection<LeaseDoc>(COLLECTIONS.lease),
  events: db.collection<EventDoc>(COLLECTIONS.events),
  commands: db.collection<CommandDoc>(COLLECTIONS.commands),
  audit: db.collection<AuditDoc>(COLLECTIONS.audit),
  accounts: db.collection<AccountDoc>(COLLECTIONS.accounts),
  positions: db.collection<PositionDoc>(COLLECTIONS.positions),
  orders: db.collection<OrderDoc>(COLLECTIONS.orders),
  fills: db.collection<FillDoc>(COLLECTIONS.fills),
  cycles: db.collection<CycleDoc>(COLLECTIONS.cycles),
  research: db.collection<ResearchDoc>(COLLECTIONS.research),
  decisions: db.collection<DecisionDoc>(COLLECTIONS.decisions),
  snapshots: db.collection<SnapshotDoc>(COLLECTIONS.snapshots),
  dailyStats: db.collection<DailyStatsDoc>(COLLECTIONS.dailyStats),
  aiCalls: db.collection<AiCallDoc>(COLLECTIONS.aiCalls),
  backtests: db.collection<BacktestDoc>(COLLECTIONS.backtests),
  notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
  seedRuns: db.collection<SeedRunDoc>(COLLECTIONS.seedRuns),
  wireItems: db.collection<WireItemDoc>(COLLECTIONS.wireItems),
  wireTriggers: db.collection<WireTriggerDoc>(COLLECTIONS.wireTriggers),
})

export const ensureIndexes = async (db: Db) => {
  await Promise.all(
    Object.entries(INDEXES).map(([name, specs]) =>
      specs && specs.length ? db.collection(name).createIndexes(specs.map((s) => ({ ...s }))) : Promise.resolve(),
    ),
  )
}

export const connectDatabase = async (uri: string, dbName: string): Promise<Database> => {
  const client = new MongoClient(uri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 15_000,
    retryWrites: true,
    appName: "cryptomarketbot-engine",
  })
  await client.connect()
  const db = client.db(dbName)
  await ensureIndexes(db)
  return { client, db, col: collectionsFor(db) }
}
