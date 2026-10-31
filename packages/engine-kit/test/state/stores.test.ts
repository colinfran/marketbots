import type { AuditDoc, EngineStateDoc, SettingsDoc } from "@mb/core/db"
import { applySettingsPatch, upgradeStoredSettings } from "@mb/core/settings"
import type { Db } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { silentLogger } from "../../src/log"
import { EngineStateStore, SettingsStore } from "../../src/state/stores"
import { useMongoTestDb } from "../../src/testing/db"

const schema = z.object({ agent: z.object({ level: z.enum(["off", "on"]), model: z.string() }), limit: z.number() })
type S = z.infer<typeof schema>
const defaults: S = { agent: { level: "on", model: "local/m" }, limit: 5 }
const binding = { schema, defaults, applyPatch: (base: S, patch: Partial<S>) => applySettingsPatch(schema, base, patch), seed: (d: S) => d, upgrade: upgradeStoredSettings }

const db = useMongoTestDb({
  prefix: "kit_stores",
  indexes: {},
  collections: (d: Db) => ({ settings: d.collection<SettingsDoc<S>>("settings"), audit: d.collection<AuditDoc>("audit_log"), engineState: d.collection<EngineStateDoc>("engine_state") }),
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

  it("reads stored settings with fields the schema no longer has as they are, and drops them at the next change", async () => {
    const old = { agent: { level: "on", model: "local/x", models: { research: "local/x" } }, limit: 7, ai: { research_timeout_seconds: 180 } }
    await db.col.settings.insertOne({ _id: "current", settings: old as unknown as S, version: 3, updated_at: new Date(), updated_by: "owner" })
    const store = await SettingsStore.load(db.col, binding, silentLogger)
    expect(store.current).toEqual({ agent: { level: "on", model: "local/x" }, limit: 7 })
    // No migration: the stored document stays as it is until the owner changes something.
    expect(store.version).toBe(3)
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings).toEqual(old)
    expect(await db.col.audit.countDocuments()).toBe(0)
    expect(await store.apply({ limit: 8 }, "owner", 3)).toEqual({ ok: true, changes: 1 })
    expect((await db.col.settings.findOne({ _id: "current" }))!.settings).toEqual({ agent: { level: "on", model: "local/x" }, limit: 8 })
  })

  it("never turns a stored shadow level on", async () => {
    await db.col.settings.insertOne({ _id: "current", settings: { agent: { level: "shadow", model: "local/x" }, limit: 7 } as unknown as S, version: 2, updated_at: new Date(), updated_by: "owner" })
    expect((await SettingsStore.load(db.col, binding, silentLogger)).current.agent.level).toBe("off")
  })
})

describe("engine state store", () => {
  const stored = async () => (await db.col.engineState.findOne({ _id: "engine" }))!.status

  it("puts a pause in effect while the database fails, and saves it once the database takes it", async () => {
    const store = await EngineStateStore.load(db.col)
    const failing = vi.spyOn(db.col.engineState, "replaceOne").mockRejectedValue(new Error("An unexpected internal error has occurred."))
    await store.update({ status: "paused", pause_reason: "test" }, "owner", "pause", {}, { first: "memory" })
    expect(store.state.status).toBe("paused")
    expect(await store.settle(1_000)).toBe(false)
    expect(await stored()).toBe("running")
    failing.mockRestore()
    expect(await store.settle(5_000)).toBe(true)
    expect(await stored()).toBe("paused")
    expect(await db.col.audit.findOne({ action: "pause" })).toMatchObject({ actor: "owner", target: "engine" })
  })

  it("saves a resume first: while the database fails, the engine stays paused", async () => {
    const store = await EngineStateStore.load(db.col)
    await store.update({ status: "paused" }, "owner", "pause", {}, { first: "memory" })
    await store.settle(5_000)
    const failing = vi.spyOn(db.col.engineState, "replaceOne").mockRejectedValue(new Error("An unexpected internal error has occurred."))
    await expect(store.update({ status: "running", pause_reason: null }, "owner", "resume")).rejects.toThrow(/unexpected internal error/)
    expect(store.state.status).toBe("paused")
    failing.mockRestore()
    expect(await stored()).toBe("paused")
  })

  it("never lets a save still owed overwrite a later change", async () => {
    const store = await EngineStateStore.load(db.col)
    const failing = vi.spyOn(db.col.engineState, "replaceOne").mockRejectedValueOnce(new Error("An unexpected internal error has occurred."))
    await store.update({ status: "paused" }, "owner", "pause", {}, { first: "memory" })
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1))
    failing.mockRestore()
    await store.update({ status: "running", pause_reason: null }, "owner", "resume")
    expect(await store.settle(5_000)).toBe(true)
    expect(await stored()).toBe("running")
    expect((await db.col.audit.find({ target: "engine" }).toArray()).map((a) => a.action)).toEqual(["pause", "resume"])
  })
})
