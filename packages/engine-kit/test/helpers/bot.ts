import { pauseCommand, resumeCommand, settingsUpdateCommand } from "@mb/core/commands"
import { BASE_COLLECTIONS, BASE_INDEXES, type AuditDoc, type CommandDoc, type EventDoc, type LeaseDoc, type NotificationDoc, type SeedRunDoc } from "@mb/core/db"
import type { BaseEventDataMap, EngineEvent } from "@mb/core/events"
import type { Db } from "mongodb"
import { z } from "zod"
import { useMongoTestDb } from "../../src/testing/db"

/**
 * A small bot for the kit's own tests: the events every bot has plus a ticker, three of the shared
 * commands, and the shared collections.
 */

export type TestEvents = BaseEventDataMap<"macro", "running" | "paused", "idle"> & {
  "market.ticker": { symbol: string; bid: number; ask: number; last: number; change_pct: number | null }
}

export const EPHEMERAL = new Set<keyof TestEvents>(["market.ticker", "engine.heartbeat"])

export const OWNER_ONLY = new Set<keyof TestEvents & string>(["command.received", "command.completed", "command.failed", "error"])

export const testCommandSchema = z.discriminatedUnion("type", [pauseCommand, resumeCommand, settingsUpdateCommand])
export type TestCommand = z.infer<typeof testCommandSchema>

const collectionsFor = (db: Db) => ({
  lease: db.collection<LeaseDoc>(BASE_COLLECTIONS.lease),
  events: db.collection<EventDoc<EngineEvent<TestEvents>>>(BASE_COLLECTIONS.events),
  commands: db.collection<CommandDoc<TestCommand>>(BASE_COLLECTIONS.commands),
  audit: db.collection<AuditDoc>(BASE_COLLECTIONS.audit),
  notifications: db.collection<NotificationDoc>(BASE_COLLECTIONS.notifications),
  seedRuns: db.collection<SeedRunDoc>(BASE_COLLECTIONS.seedRuns),
})

export const useTestDb = () => useMongoTestDb({ prefix: "kit_test", indexes: BASE_INDEXES, collections: collectionsFor })
