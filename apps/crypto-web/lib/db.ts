import "server-only"
import { COLLECTIONS } from "@mb/crypto-core/db"
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
  LoginAttemptDoc,
  NotificationDoc,
  OrderDoc,
  PositionDoc,
  SettingsDoc,
  SnapshotDoc,
} from "@mb/crypto-core/db"
import type { AgentEpisodeDoc, AgentNoteDoc, AgentWatchDoc } from "@mb/crypto-core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/crypto-core/wire"
import { createDb } from "@mb/web-kit/db"
import { hostCollections } from "@mb/web-kit/host"
import { env } from "./env"

/**
 * MongoDB (Azure DocumentDB) access for the dashboard (@mb/web-kit/db). The dashboard reads everything the
 * engine writes and writes only three things: commands, audit entries and owner sign-in records
 * (via Better Auth). One client is reused per serverless instance (and across hot reloads in dev).
 */
export const { mongoClient, db, collections } = createDb({
  globalKey: "_cmbMongo",
  appName: "cryptomarketbot-web",
  env,
  collections: (d) => ({
    settings: d.collection<SettingsDoc>(COLLECTIONS.settings),
    engineState: d.collection<EngineStateDoc>(COLLECTIONS.engineState),
    engineStatus: d.collection<EngineStatusDoc>(COLLECTIONS.engineStatus),
    events: d.collection<EventDoc>(COLLECTIONS.events),
    commands: d.collection<CommandDoc>(COLLECTIONS.commands),
    audit: d.collection<AuditDoc>(COLLECTIONS.audit),
    accounts: d.collection<AccountDoc>(COLLECTIONS.accounts),
    positions: d.collection<PositionDoc>(COLLECTIONS.positions),
    orders: d.collection<OrderDoc>(COLLECTIONS.orders),
    fills: d.collection<FillDoc>(COLLECTIONS.fills),
    decisions: d.collection<DecisionDoc>(COLLECTIONS.decisions),
    snapshots: d.collection<SnapshotDoc>(COLLECTIONS.snapshots),
    dailyStats: d.collection<DailyStatsDoc>(COLLECTIONS.dailyStats),
    aiCalls: d.collection<AiCallDoc>(COLLECTIONS.aiCalls),
    notifications: d.collection<NotificationDoc>(COLLECTIONS.notifications),
    wireItems: d.collection<WireItemDoc>(COLLECTIONS.wireItems),
    wireTriggers: d.collection<WireTriggerDoc>(COLLECTIONS.wireTriggers),
    loginAttempts: d.collection<LoginAttemptDoc>(COLLECTIONS.loginAttempts),
    agentEpisodes: d.collection<AgentEpisodeDoc>(COLLECTIONS.agentEpisodes),
    agentWatches: d.collection<AgentWatchDoc>(COLLECTIONS.agentWatches),
    agentNotes: d.collection<AgentNoteDoc>(COLLECTIONS.agentNotes),
    ...hostCollections(d, env.hostDb()),
  }),
})
