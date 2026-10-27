import { COLLECTIONS, INDEXES } from "@mb/stock-core/db"
import type {
  AiCallDoc,
  AuditDoc,
  CacheDoc,
  CommandDoc,
  CycleDoc,
  DailyStatsDoc,
  DecisionDoc,
  EngineStateDoc,
  EngineStatusDoc,
  EventDoc,
  LeaseDoc,
  NotificationDoc,
  SeedRunDoc,
  OptionPositionDoc,
  OrderDoc,
  PositionPlanDoc,
  ReportDoc,
  SettingsDoc,
} from "@mb/stock-core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/stock-core/wire"
import { MongoClient, type Collection, type Db } from "mongodb"

/**
 * The engine's long-lived MongoDB connection. The engine is the only writer of trading state
 * (cycles, reports, decisions, orders, plans, options positions), which together with the
 * single-instance lease means those documents never see concurrent writers.
 */

export type Collections = {
  settings: Collection<SettingsDoc>
  engineState: Collection<EngineStateDoc>
  engineStatus: Collection<EngineStatusDoc>
  lease: Collection<LeaseDoc>
  events: Collection<EventDoc>
  commands: Collection<CommandDoc>
  audit: Collection<AuditDoc>
  notifications: Collection<NotificationDoc>
  seedRuns: Collection<SeedRunDoc>
  wireItems: Collection<WireItemDoc>
  wireTriggers: Collection<WireTriggerDoc>
  aiCalls: Collection<AiCallDoc>
  cycles: Collection<CycleDoc>
  reports: Collection<ReportDoc>
  decisions: Collection<DecisionDoc>
  orders: Collection<OrderDoc>
  plans: Collection<PositionPlanDoc>
  optionPositions: Collection<OptionPositionDoc>
  dailyStats: Collection<DailyStatsDoc>
  cache: Collection<CacheDoc>
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
  notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
  seedRuns: db.collection<SeedRunDoc>(COLLECTIONS.seedRuns),
  wireItems: db.collection<WireItemDoc>(COLLECTIONS.wireItems),
  wireTriggers: db.collection<WireTriggerDoc>(COLLECTIONS.wireTriggers),
  aiCalls: db.collection<AiCallDoc>(COLLECTIONS.aiCalls),
  cycles: db.collection<CycleDoc>(COLLECTIONS.cycles),
  reports: db.collection<ReportDoc>(COLLECTIONS.reports),
  decisions: db.collection<DecisionDoc>(COLLECTIONS.decisions),
  orders: db.collection<OrderDoc>(COLLECTIONS.orders),
  plans: db.collection<PositionPlanDoc>(COLLECTIONS.plans),
  optionPositions: db.collection<OptionPositionDoc>(COLLECTIONS.optionPositions),
  dailyStats: db.collection<DailyStatsDoc>(COLLECTIONS.dailyStats),
  cache: db.collection<CacheDoc>(COLLECTIONS.cache),
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
    appName: "stockmarketbot-engine",
  })
  await client.connect()
  const db = client.db(dbName)
  await ensureIndexes(db)
  return { client, db, col: collectionsFor(db) }
}
