import { randomUUID } from "node:crypto"
import type { EngineStateDoc } from "@mb/crypto-core/db"
import { applySettingsPatch, DEFAULT_SETTINGS, diffSettings, settingsSchema, type Settings, type SettingsPatch } from "@mb/crypto-core/settings"
import type { Collections } from "../db/mongo"
import type { Env } from "../env"
import type { Logger } from "../log"

/**
 * Settings and desired engine state, both persisted in MongoDB so they survive restarts and can
 * only change through audited commands (or the engine's own safety actions, which are audited too).
 */

export class SettingsStore {
  private listeners: ((s: Settings) => void)[] = []

  private constructor(
    private readonly col: Pick<Collections, "settings" | "audit">,
    public current: Settings,
    public version: number,
  ) {}

  static async load(col: Pick<Collections, "settings" | "audit">, env: Pick<Env, "GROK_RESEARCH_MODEL" | "GROK_DECISION_MODEL">, log: Logger) {
    const doc = await col.settings.findOne({ _id: "current" })
    if (doc) {
      const parsed = settingsSchema.safeParse(doc.settings)
      if (parsed.success) return new SettingsStore(col, parsed.data, doc.version)
      // Stored settings from an older schema: fill in new fields from defaults, keep the rest.
      const migrated = applySettingsPatch(DEFAULT_SETTINGS, doc.settings as SettingsPatch)
      if (migrated.ok) {
        log.warn("stored settings migrated to the current schema")
        await col.settings.updateOne({ _id: "current" }, { $set: { settings: migrated.settings, version: doc.version + 1, updated_at: new Date(), updated_by: "engine:migration" } })
        return new SettingsStore(col, migrated.settings, doc.version + 1)
      }
      log.error("stored settings are invalid; using defaults until fixed from the dashboard", { errors: migrated.errors })
      return new SettingsStore(col, DEFAULT_SETTINGS, doc.version)
    }
    const seed: Settings = {
      ...DEFAULT_SETTINGS,
      ai: {
        ...DEFAULT_SETTINGS.ai,
        models: {
          ...DEFAULT_SETTINGS.ai.models,
          research: env.GROK_RESEARCH_MODEL ?? DEFAULT_SETTINGS.ai.models.research,
          decision: env.GROK_DECISION_MODEL ?? DEFAULT_SETTINGS.ai.models.decision,
        },
      },
    }
    const valid = settingsSchema.parse(seed)
    await col.settings.updateOne(
      { _id: "current" },
      { $setOnInsert: { settings: valid, version: 1, updated_at: new Date(), updated_by: "engine:seed" } },
      { upsert: true },
    )
    return new SettingsStore(col, valid, 1)
  }

  onChange(fn: (s: Settings) => void) {
    this.listeners.push(fn)
  }

  /** Validates and applies a patch. Optimistic concurrency guards against stale dashboard forms. */
  async apply(patch: SettingsPatch, by: string, expectedVersion: number | null): Promise<{ ok: true; changes: number } | { ok: false; error: string }> {
    if (expectedVersion !== null && expectedVersion !== this.version) {
      return { ok: false, error: `settings changed since the form was loaded (v${expectedVersion} → v${this.version}); reload and retry` }
    }
    const result = applySettingsPatch(this.current, patch)
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
    private readonly col: Pick<Collections, "engineState" | "audit">,
    public state: EngineStateDoc,
  ) {}

  static async load(col: Pick<Collections, "engineState" | "audit">) {
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
