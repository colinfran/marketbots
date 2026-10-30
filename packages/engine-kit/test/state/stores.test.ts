import type { AuditDoc, SettingsDoc } from "@mb/core/db"
import { applySettingsPatch, upgradeStoredSettings } from "@mb/core/settings"
import type { Db } from "mongodb"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { silentLogger } from "../../src/log"
import { SettingsStore } from "../../src/state/stores"
import { useMongoTestDb } from "../../src/testing/db"

const schema = z.object({ agent: z.object({ level: z.enum(["off", "on"]), model: z.string() }), limit: z.number() })
type S = z.infer<typeof schema>
const defaults: S = { agent: { level: "on", model: "local/m" }, limit: 5 }
const binding = { schema, defaults, applyPatch: (base: S, patch: Partial<S>) => applySettingsPatch(schema, base, patch), seed: (d: S) => d, upgrade: upgradeStoredSettings }

const db = useMongoTestDb({
  prefix: "kit_stores",
  indexes: {},
  collections: (d: Db) => ({ settings: d.collection<SettingsDoc<S>>("settings"), audit: d.collection<AuditDoc>("audit_log") }),
})

describe("settings store", () => {
  it("upgrades stored settings whose values changed meaning, once, and audits it", async () => {
    await db.col.settings.insertOne({ _id: "current", settings: { agent: { level: "auto", model: "local/x" }, limit: 7 } as unknown as S, version: 4, updated_at: new Date(), updated_by: "owner" })
    const store = await SettingsStore.load(db.col, binding, silentLogger)
    expect(store.current).toEqual({ agent: { level: "on", model: "local/x" }, limit: 7 })
    expect(store.version).toBe(5)
    expect(await db.col.settings.findOne({ _id: "current" })).toMatchObject({ settings: { agent: { level: "on" } }, version: 5, updated_by: "engine:migration" })
    expect(await db.col.audit.find().toArray()).toEqual([
      expect.objectContaining({ actor: "engine:migration", action: "settings.update", details: { version: 5, changes: [{ path: "agent.level", before: "auto", after: "on" }] } }),
    ])
    // Read again, nothing changes.
    const again = await SettingsStore.load(db.col, binding, silentLogger)
    expect(again.version).toBe(5)
    expect(await db.col.audit.countDocuments()).toBe(1)
  })

  it("never turns a stored shadow level on", async () => {
    await db.col.settings.insertOne({ _id: "current", settings: { agent: { level: "shadow", model: "local/x" }, limit: 7 } as unknown as S, version: 2, updated_at: new Date(), updated_by: "owner" })
    expect((await SettingsStore.load(db.col, binding, silentLogger)).current.agent.level).toBe("off")
  })
})
