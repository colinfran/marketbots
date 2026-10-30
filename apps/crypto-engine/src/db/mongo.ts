import { COLLECTIONS, INDEXES } from "@mb/crypto-core/db"
import type {
  AccountDoc,
  AiCallDoc,
  AuditDoc,
  CommandDoc,
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
  SettingsDoc,
  SnapshotDoc,
} from "@mb/crypto-core/db"
import type { AgentEpisodeDoc, AgentNoteDoc, AgentWatchDoc } from "@mb/core/agent"
import type { SearchUsageDoc } from "@mb/core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/crypto-core/wire"
import { connectMongo, type Database as DatabaseOf } from "@mb/engine-kit/db"
import type { Logger } from "@mb/engine-kit/log"
import type { Collection, Db } from "mongodb"

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
  decisions: Collection<DecisionDoc>
  snapshots: Collection<SnapshotDoc>
  dailyStats: Collection<DailyStatsDoc>
  aiCalls: Collection<AiCallDoc>
  searchUsage: Collection<SearchUsageDoc>
  notifications: Collection<NotificationDoc>
  wireItems: Collection<WireItemDoc>
  wireTriggers: Collection<WireTriggerDoc>
  agentEpisodes: Collection<AgentEpisodeDoc>
  agentWatches: Collection<AgentWatchDoc>
  agentNotes: Collection<AgentNoteDoc>
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
  accounts: db.collection<AccountDoc>(COLLECTIONS.accounts),
  positions: db.collection<PositionDoc>(COLLECTIONS.positions),
  orders: db.collection<OrderDoc>(COLLECTIONS.orders),
  fills: db.collection<FillDoc>(COLLECTIONS.fills),
  decisions: db.collection<DecisionDoc>(COLLECTIONS.decisions),
  snapshots: db.collection<SnapshotDoc>(COLLECTIONS.snapshots),
  dailyStats: db.collection<DailyStatsDoc>(COLLECTIONS.dailyStats),
  aiCalls: db.collection<AiCallDoc>(COLLECTIONS.aiCalls),
  searchUsage: db.collection<SearchUsageDoc>(COLLECTIONS.searchUsage),
  notifications: db.collection<NotificationDoc>(COLLECTIONS.notifications),
  wireItems: db.collection<WireItemDoc>(COLLECTIONS.wireItems),
  wireTriggers: db.collection<WireTriggerDoc>(COLLECTIONS.wireTriggers),
  agentEpisodes: db.collection<AgentEpisodeDoc>(COLLECTIONS.agentEpisodes),
  agentWatches: db.collection<AgentWatchDoc>(COLLECTIONS.agentWatches),
  agentNotes: db.collection<AgentNoteDoc>(COLLECTIONS.agentNotes),
})

/** Connects to crypto's database (@mb/engine-kit/db: indexes ensured, retried until it works). */
export const connectDatabase = (uri: string, dbName: string, log: Logger): Promise<Database> =>
  connectMongo({ uri, dbName, appName: "cryptomarketbot-engine", indexes: INDEXES, collections: collectionsFor, log })
