import { pauseCommand, resumeCommand, settingsUpdateCommand } from "@mb/core/commands"
import {
  BASE_COLLECTIONS,
  BASE_INDEXES,
  type AiCallDoc,
  type AuditDoc,
  type CommandDoc,
  type EngineStateDoc,
  type EngineStatusBase,
  type EventDoc,
  type LeaseDoc,
  type NotificationDoc,
} from "@mb/core/db"
import type { BaseEventDataMap, EngineEvent } from "@mb/core/events"
import type { WireTriggerDoc } from "@mb/core/wire"
import type { Db } from "mongodb"
import { z } from "zod"
import { useMongoTestDb } from "../../src/testing/db"

/**
 * A small bot for the kit's own tests: the events every bot has plus a ticker, three of the shared
 * commands, the shared collections, and a status document with a section of its own.
 */

export type TestRunStatus = "starting" | "running" | "paused" | "halted" | "stopping"
export type TestCycleState = "idle" | "deciding"

export type TestEvents = BaseEventDataMap<"macro", TestRunStatus, TestCycleState> & {
  "market.ticker": { symbol: string; bid: number; ask: number; last: number; change_pct: number | null }
}

export const EPHEMERAL = new Set<keyof TestEvents>(["market.ticker", "engine.heartbeat"])

export const OWNER_ONLY = new Set<keyof TestEvents & string>(["command.received", "command.completed", "command.failed", "error"])

export const testCommandSchema = z.discriminatedUnion("type", [pauseCommand, resumeCommand, settingsUpdateCommand])
export type TestCommand = z.infer<typeof testCommandSchema>

/** The test bot's heartbeat document: the shared fields with its own section among them. */
export type TestStatusDoc = EngineStatusBase<TestRunStatus, TestCycleState> & { venue: { ok: boolean }; last_cycle: string | null }

const collectionsFor = (db: Db) => ({
  lease: db.collection<LeaseDoc>(BASE_COLLECTIONS.lease),
  events: db.collection<EventDoc<EngineEvent<TestEvents>>>(BASE_COLLECTIONS.events),
  commands: db.collection<CommandDoc<TestCommand>>(BASE_COLLECTIONS.commands),
  audit: db.collection<AuditDoc>(BASE_COLLECTIONS.audit),
  notifications: db.collection<NotificationDoc>(BASE_COLLECTIONS.notifications),
  engineState: db.collection<EngineStateDoc>(BASE_COLLECTIONS.engineState),
  aiCalls: db.collection<AiCallDoc>(BASE_COLLECTIONS.aiCalls),
  wireTriggers: db.collection<WireTriggerDoc>(BASE_COLLECTIONS.wireTriggers),
})

export const useTestDb = () => useMongoTestDb({ prefix: "kit_test", indexes: BASE_INDEXES, collections: collectionsFor })
