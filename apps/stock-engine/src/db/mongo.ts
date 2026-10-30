import { connectMongo, type Database as DatabaseOf } from "@mb/engine-kit/db"
import type { Logger } from "@mb/engine-kit/log"
import { COLLECTIONS, INDEXES } from "@mb/stock-core/db"
import type {
  AiCallDoc,
  AuditDoc,
  CacheDoc,
  CommandDoc,
  DailyStatsDoc,
  DecisionDoc,
  EngineStateDoc,
  EngineStatusDoc,
  EventDoc,
  LeaseDoc,
  NotificationDoc,
  OptionPositionDoc,
  OrderDoc,
  PositionPlanDoc,
  SettingsDoc,
} from "@mb/stock-core/db"
import type { AgentEpisodeDoc, AgentNoteDoc, AgentWatchDoc } from "@mb/core/agent"
import type { SearchUsageDoc } from "@mb/core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/stock-core/wire"
import type { Collection, Db } from "mongodb"

/**
 * The engine's long-lived MongoDB connection. The engine is the only writer of trading state
 * (decisions, orders, plans, options positions), which together with the
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
  wireItems: Collection<WireItemDoc>
  wireTriggers: Collection<WireTriggerDoc>
  agentEpisodes: Collection<AgentEpisodeDoc>
  agentWatches: Collection<AgentWatchDoc>
  agentNotes: Collection<AgentNoteDoc>
  aiCalls: Collection<AiCallDoc>
  searchUsage: Collection<SearchUsageDoc>
  decisions: Collection<DecisionDoc>
  orders: Collection<OrderDoc>
  plans: Collection<PositionPlanDoc>
  optionPositions: Collection<OptionPositionDoc>
  dailyStats: Collection<DailyStatsDoc>
  cache: Collection<CacheDoc>
}

export type Database = DatabaseOf<Collections>

export const collectionsFor = (db: Db): Collections => ({
  settings: db.collection<SettingsDoc>(COLLECTIONS.settings),
  engineState: db.collection<EngineStateDoc>(COLLECTIONS.engineState),
  engineStatus: db.collection<EngineStatusDoc>(COLLECTIONS.engineStatus),
  lease: db.collection<LeaseDoc>(COLLECTIONS.lease),
  events: db.collection<EventDoc>(COLLECTIONS.events),
  commands: db.collection<CommandDoc>(COLLECTIONS.commands),
  audit: db.collection<AuditDoc>(COLLECTIONS.audit),
  notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
  wireItems: db.collection<WireItemDoc>(COLLECTIONS.wireItems),
  wireTriggers: db.collection<WireTriggerDoc>(COLLECTIONS.wireTriggers),
  agentEpisodes: db.collection<AgentEpisodeDoc>(COLLECTIONS.agentEpisodes),
  agentWatches: db.collection<AgentWatchDoc>(COLLECTIONS.agentWatches),
  agentNotes: db.collection<AgentNoteDoc>(COLLECTIONS.agentNotes),
  aiCalls: db.collection<AiCallDoc>(COLLECTIONS.aiCalls),
  searchUsage: db.collection<SearchUsageDoc>(COLLECTIONS.searchUsage),
  decisions: db.collection<DecisionDoc>(COLLECTIONS.decisions),
  orders: db.collection<OrderDoc>(COLLECTIONS.orders),
  plans: db.collection<PositionPlanDoc>(COLLECTIONS.plans),
  optionPositions: db.collection<OptionPositionDoc>(COLLECTIONS.optionPositions),
  dailyStats: db.collection<DailyStatsDoc>(COLLECTIONS.dailyStats),
  cache: db.collection<CacheDoc>(COLLECTIONS.cache),
})

/** Connects to stock's database (@mb/engine-kit/db: indexes ensured, retried until it works). */
export const connectDatabase = (uri: string, dbName: string, log: Logger): Promise<Database> =>
  connectMongo({ uri, dbName, appName: "stockmarketbot-engine", indexes: INDEXES, collections: collectionsFor, log })
