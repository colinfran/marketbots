import "server-only"
import { COLLECTIONS } from "@mb/stock-core/db"
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
  LoginAttemptDoc,
  NotificationDoc,
  SeedRunDoc,
  OptionPositionDoc,
  OrderDoc,
  PositionPlanDoc,
  ReportDoc,
  SettingsDoc,
} from "@mb/stock-core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/stock-core/wire"
import { MongoClient, type Db } from "mongodb"
import { env } from "./env"

/**
 * MongoDB (Atlas) access for the dashboard. The dashboard reads everything the engine writes and
 * writes only three things: commands, audit entries and owner sign-in records (via Better Auth).
 * One client is reused per serverless instance (and across hot reloads in dev). It connects on
 * first use and reconnects on its own after a failure.
 */

declare global {
  var _smbMongo: MongoClient | undefined
}

export const mongoClient = (): MongoClient => {
  const uri = env.mongoUri()
  if (!uri) throw new Error("MONGODB_URI is not set")
  return (globalThis._smbMongo ??= new MongoClient(uri, { maxPoolSize: 10, appName: "stockmarketbot-web" }))
}

export const db = async (): Promise<Db> => mongoClient().db(env.mongoDb())

export const collections = async () => {
  const d = await db()
  return {
    settings: d.collection<SettingsDoc>(COLLECTIONS.settings),
    engineState: d.collection<EngineStateDoc>(COLLECTIONS.engineState),
    engineStatus: d.collection<EngineStatusDoc>(COLLECTIONS.engineStatus),
    events: d.collection<EventDoc>(COLLECTIONS.events),
    commands: d.collection<CommandDoc>(COLLECTIONS.commands),
    audit: d.collection<AuditDoc>(COLLECTIONS.audit),
    notifications: d.collection<NotificationDoc>(COLLECTIONS.notifications),
    seedRuns: d.collection<SeedRunDoc>(COLLECTIONS.seedRuns),
    wireItems: d.collection<WireItemDoc>(COLLECTIONS.wireItems),
    wireTriggers: d.collection<WireTriggerDoc>(COLLECTIONS.wireTriggers),
    aiCalls: d.collection<AiCallDoc>(COLLECTIONS.aiCalls),
    cycles: d.collection<CycleDoc>(COLLECTIONS.cycles),
    reports: d.collection<ReportDoc>(COLLECTIONS.reports),
    decisions: d.collection<DecisionDoc>(COLLECTIONS.decisions),
    orders: d.collection<OrderDoc>(COLLECTIONS.orders),
    plans: d.collection<PositionPlanDoc>(COLLECTIONS.plans),
    optionPositions: d.collection<OptionPositionDoc>(COLLECTIONS.optionPositions),
    dailyStats: d.collection<DailyStatsDoc>(COLLECTIONS.dailyStats),
    cache: d.collection<CacheDoc>(COLLECTIONS.cache),
    loginAttempts: d.collection<LoginAttemptDoc>(COLLECTIONS.loginAttempts),
  }
}
