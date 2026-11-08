import "server-only"
import { COLLECTIONS } from "@mb/stock-core/db"
import type {
  AiCallDoc,
  AuditDoc,
  CacheDoc,
  CommandDoc,
  DailyStatsDoc,
  DecisionDoc,
  EngineStateDoc,
  EventDoc,
  LoginAttemptDoc,
  NotificationDoc,
  OptionPositionDoc,
  OrderDoc,
  PositionPlanDoc,
  SettingsDoc,
} from "@mb/stock-core/db"
import type { AgentEpisodeDoc, AgentNoteDoc, AgentWatchDoc } from "@mb/stock-core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/stock-core/wire"
import { createDb } from "@mb/web-kit/db"
import { env } from "./env"

/**
 * MongoDB access for the dashboard (@mb/web-kit/db). The dashboard reads everything the engine
 * writes and writes only audit entries, login rate limits and owner sign-in records (via Better
 * Auth). One client per process (reused across hot reloads in dev).
 */
export const { mongoClient, db, collections } = createDb({
  globalKey: "_smbMongo",
  appName: "stockmarketbot-web",
  env,
  collections: (d) => ({
    settings: d.collection<SettingsDoc>(COLLECTIONS.settings),
    engineState: d.collection<EngineStateDoc>(COLLECTIONS.engineState),
    events: d.collection<EventDoc>(COLLECTIONS.events),
    commands: d.collection<CommandDoc>(COLLECTIONS.commands),
    audit: d.collection<AuditDoc>(COLLECTIONS.audit),
    notifications: d.collection<NotificationDoc>(COLLECTIONS.notifications),
    wireItems: d.collection<WireItemDoc>(COLLECTIONS.wireItems),
    wireTriggers: d.collection<WireTriggerDoc>(COLLECTIONS.wireTriggers),
    aiCalls: d.collection<AiCallDoc>(COLLECTIONS.aiCalls),
    decisions: d.collection<DecisionDoc>(COLLECTIONS.decisions),
    orders: d.collection<OrderDoc>(COLLECTIONS.orders),
    plans: d.collection<PositionPlanDoc>(COLLECTIONS.plans),
    optionPositions: d.collection<OptionPositionDoc>(COLLECTIONS.optionPositions),
    dailyStats: d.collection<DailyStatsDoc>(COLLECTIONS.dailyStats),
    cache: d.collection<CacheDoc>(COLLECTIONS.cache),
    loginAttempts: d.collection<LoginAttemptDoc>(COLLECTIONS.loginAttempts),
    agentEpisodes: d.collection<AgentEpisodeDoc>(COLLECTIONS.agentEpisodes),
    agentWatches: d.collection<AgentWatchDoc>(COLLECTIONS.agentWatches),
    agentNotes: d.collection<AgentNoteDoc>(COLLECTIONS.agentNotes),
  }),
})
