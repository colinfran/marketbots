import { randomUUID } from "node:crypto"
import type { AuditDoc, EngineStateDoc, SettingsDoc } from "@mb/core/db"
import { diffSettings, type SettingsValidation } from "@mb/core/settings"
import type { Collection } from "mongodb"
import type { z } from "zod"
import type { Logger } from "../log"

/**
 * Settings and desired engine state, both persisted in MongoDB so they survive restarts and can
 * only change through audited commands (or the engine's own safety actions, which are audited too).
 */

/** What trading code needs from settings: the current values and their version. */
export type SettingsView<S> = { readonly current: S; readonly version: number }

/** The bot's settings: its schema, defaults, patch function and first-boot seed. */
export type SettingsBinding<S, P> = {
  schema: z.ZodType<S>
  defaults: S
  /** The bot's `applySettingsPatch`: merges a patch and validates the result. */
  applyPatch: (base: S, patch: P) => SettingsValidation<S>
  /** The settings written on first boot, from the defaults and the env's seed values (models, starting capital…). */
  seed: (defaults: S) => S
  /** Rewrites stored settings from an older schema whose values changed meaning (renamed enum values), before they are read. */
  upgrade?: (stored: unknown) => unknown
}

type SettingsCol<S> = { settings: Collection<SettingsDoc<S>>; audit: Collection<AuditDoc> }

export class SettingsStore<S, P> implements SettingsView<S> {
  private listeners: ((s: S) => void)[] = []

  private constructor(
    private readonly col: SettingsCol<S>,
    private readonly applyPatch: (base: S, patch: P) => SettingsValidation<S>,
    public current: S,
    public version: number,
  ) {}

  static async load<S, P>(col: SettingsCol<S>, bot: SettingsBinding<S, P>, log: Logger): Promise<SettingsStore<S, P>> {
    const doc = await col.settings.findOne({ _id: "current" })
    if (doc) {
      const stored = bot.upgrade ? bot.upgrade(doc.settings) : doc.settings
      const parsed = bot.schema.safeParse(stored)
      if (parsed.success && stored !== doc.settings) {
        // An upgraded value is written back once, and audited like any settings change.
        const changes = diffSettings(doc.settings, stored)
        log.warn("stored settings upgraded", { changes })
        await col.settings.updateOne({ _id: "current" }, { $set: { settings: parsed.data, version: doc.version + 1, updated_at: new Date(), updated_by: "engine:migration" } })
        await col.audit.insertOne({ _id: randomUUID(), at: new Date(), actor: "engine:migration", action: "settings.update", target: "settings", details: { version: doc.version + 1, changes } })
        return new SettingsStore(col, bot.applyPatch, parsed.data, doc.version + 1)
      }
      if (parsed.success) return new SettingsStore(col, bot.applyPatch, parsed.data, doc.version)
      // Stored settings from an older schema: fill in new fields from defaults, keep the rest.
      const migrated = bot.applyPatch(bot.defaults, stored as P)
      if (migrated.ok) {
        log.warn("stored settings migrated to the current schema")
        await col.settings.updateOne({ _id: "current" }, { $set: { settings: migrated.settings, version: doc.version + 1, updated_at: new Date(), updated_by: "engine:migration" } })
        return new SettingsStore(col, bot.applyPatch, migrated.settings, doc.version + 1)
      }
      log.error("stored settings are invalid; using defaults until fixed from the dashboard", { errors: migrated.errors })
      return new SettingsStore(col, bot.applyPatch, bot.defaults, doc.version)
    }
    const valid = bot.schema.parse(bot.seed(bot.defaults))
    await col.settings.updateOne(
      { _id: "current" },
      { $setOnInsert: { settings: valid, version: 1, updated_at: new Date(), updated_by: "engine:seed" } },
      { upsert: true },
    )
    return new SettingsStore(col, bot.applyPatch, valid, 1)
  }

  onChange(fn: (s: S) => void) {
    this.listeners.push(fn)
  }

  /** Validates and applies a patch. Optimistic concurrency guards against stale dashboard forms. */
  async apply(patch: P, by: string, expectedVersion: number | null): Promise<{ ok: true; changes: number } | { ok: false; error: string }> {
    if (expectedVersion !== null && expectedVersion !== this.version) {
      return { ok: false, error: `settings changed since the form was loaded (v${expectedVersion} → v${this.version}); reload and retry` }
    }
    const result = this.applyPatch(this.current, patch)
    if (!result.ok) return { ok: false, error: result.errors.join("; ") }
    const changes = diffSettings(this.current, result.settings)
    if (!changes.length) return { ok: true, changes: 0 }
    const next = this.version + 1
    const res = await this.col.settings.updateOne(
      { _id: "current", version: this.version },
      { $set: { settings: result.settings, version: next, updated_at: new Date(), updated_by: by } },
    )
    if (res.matchedCount === 0) return { ok: false, error: "settings were changed concurrently; retry" }
    await this.col.audit.insertOne({ _id: randomUUID(), at: new Date(), actor: by, action: "settings.update", target: "settings", details: { version: next, changes } })
    this.current = result.settings
    this.version = next
    for (const fn of this.listeners) fn(this.current)
    return { ok: true, changes: changes.length }
  }
}

export class EngineStateStore {
  private constructor(
    private readonly col: { engineState: Collection<EngineStateDoc>; audit: Collection<AuditDoc> },
    public state: EngineStateDoc,
  ) {}

  static async load(col: { engineState: Collection<EngineStateDoc>; audit: Collection<AuditDoc> }) {
    const initial: EngineStateDoc = {
      _id: "engine",
      status: "running",
      pause_reason: null,
      kill_switch: { engaged: false, reason: null, at: null, by: null, liquidate: false },
      updated_at: new Date(),
    }
    await col.engineState.updateOne({ _id: "engine" }, { $setOnInsert: initial }, { upsert: true })
    return new EngineStateStore(col, (await col.engineState.findOne({ _id: "engine" }))!)
  }

  async update(fields: Partial<Omit<EngineStateDoc, "_id">>, by: string, action: string, details: Record<string, unknown> = {}) {
    const next = { ...this.state, ...fields, updated_at: new Date() }
    await this.col.engineState.replaceOne({ _id: "engine" }, next)
    await this.col.audit.insertOne({ _id: randomUUID(), at: new Date(), actor: by, action, target: "engine", details: { ...details, ...fields } })
    this.state = next
  }
}
