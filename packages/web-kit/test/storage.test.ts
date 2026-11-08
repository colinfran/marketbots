import { DB_STORAGE_BUDGET_BYTES } from "@mb/core/db"
import type { MongoClient } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { databaseStorage, storageAlertLevel, watchDatabaseStorage } from "../src/storage"

const MB = 1024 ** 2
const GB = 1024 ** 3

/** A client whose listDatabases and dbStats answer with these sizes. */
const fakeClient = ({ totalSize, stats }: { totalSize?: number; stats: Record<string, Record<string, unknown>> }) =>
  ({
    db: (name: string) => ({
      admin: () => ({ listDatabases: async () => ({ databases: ["admin", ...Object.keys(stats), "local", "config"].map((n) => ({ name: n })), totalSize }) }),
      stats: async () => stats[name],
    }),
  }) as unknown as MongoClient

const failingClient = {
  db: () => ({
    admin: () => ({
      listDatabases: async () => {
        throw new Error("not authorized on admin")
      },
    }),
  }),
} as unknown as MongoClient

describe("databaseStorage", () => {
  it("lists every database but the system ones, largest first, and the disk they are on", async () => {
    const disk = { fsUsedSize: 198 * GB, fsTotalSize: 1007 * GB }
    const view = await databaseStorage(
      fakeClient({ totalSize: 172 * MB, stats: { cryptomarketbot: { totalSize: 48 * MB, ...disk }, stockmarketbot: { totalSize: 121 * MB, ...disk } } }),
    )
    expect(view).toEqual({
      used_bytes: 172 * MB,
      budget_bytes: DB_STORAGE_BUDGET_BYTES,
      databases: [
        { name: "stockmarketbot", bytes: 121 * MB },
        { name: "cryptomarketbot", bytes: 48 * MB },
      ],
      disk: { used_bytes: 198 * GB, total_bytes: 1007 * GB },
      error: null,
    })
  })

  it("never reports less than the databases themselves, and adds up storage and indexes without totalSize", async () => {
    const view = await databaseStorage(fakeClient({ stats: { a: { storageSize: 10 * MB, indexSize: 2 * MB }, b: { totalSize: 5 * MB } } }))
    expect(view.used_bytes).toBe(17 * MB)
    expect(view.databases).toEqual([
      { name: "a", bytes: 12 * MB },
      { name: "b", bytes: 5 * MB },
    ])
  })

  it("takes the disk from the first database that reports it, as numbers or Longs", async () => {
    const long = (n: number) => ({ valueOf: () => n })
    const view = await databaseStorage(fakeClient({ stats: { a: { totalSize: MB, fsUsedSize: 0 }, b: { totalSize: MB, fsUsedSize: long(2 * GB), fsTotalSize: long(8 * GB) } } }))
    expect(view.disk).toEqual({ used_bytes: 2 * GB, total_bytes: 8 * GB })
  })

  it("leaves the disk out when MongoDB doesn't report it", async () => {
    expect((await databaseStorage(fakeClient({ stats: { a: { totalSize: MB } } }))).disk).toBeNull()
  })

  it("returns the error instead of throwing", async () => {
    expect(await databaseStorage(failingClient)).toEqual({ used_bytes: null, budget_bytes: DB_STORAGE_BUDGET_BYTES, databases: [], disk: null, error: "not authorized on admin" })
  })
})

describe("the 32 GB budget", () => {
  const view = (used: number | null) => ({ used_bytes: used, budget_bytes: 32 * GB, databases: [], disk: null, error: null })

  it("is the old Azure free tier's size", () => {
    expect(DB_STORAGE_BUDGET_BYTES).toBe(32 * GB)
  })

  it("alerts from 80% and from 90%", () => {
    expect(storageAlertLevel(view(25.5 * GB))).toBeNull()
    expect(storageAlertLevel(view(25.6 * GB))).toBe(80)
    expect(storageAlertLevel(view(28.8 * GB))).toBe(90)
    expect(storageAlertLevel(view(40 * GB))).toBe(90)
    expect(storageAlertLevel(view(null))).toBeNull()
  })
})

describe("watchDatabaseStorage", () => {
  let stop = () => {}
  afterEach(() => stop())

  /** A watch over a database whose size the test sets. */
  const watch = () => {
    let used = 0
    let t = 0
    const sendAlert = vi.fn<(alert: { title: string; message: string; key?: string }) => Promise<void>>(async () => {})
    const w = watchDatabaseStorage({ client: () => fakeClient({ totalSize: used, stats: { cryptomarketbot: { totalSize: used } } }), sendAlert, now: () => t })
    stop = w.stop
    return { check: w.check, sendAlert, setUsed: (gb: number) => (used = gb * GB), advance: (ms: number) => (t += ms) }
  }

  it("alerts once per level, again on the higher one, then once a day while above", async () => {
    const { check, sendAlert, setUsed, advance } = watch()
    setUsed(10)
    await check()
    expect(sendAlert).not.toHaveBeenCalled()
    setUsed(26)
    await check()
    await check()
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(sendAlert.mock.calls[0][0]).toMatchObject({ title: "Database storage at 81% of its budget", key: "storage|80" })
    expect(sendAlert.mock.calls[0][0].message).toContain("26.0 GB of their 32.0 GB budget")
    setUsed(29)
    await check()
    expect(sendAlert).toHaveBeenCalledTimes(2)
    expect(sendAlert.mock.calls[1][0]).toMatchObject({ key: "storage|90" })
    advance(23 * 3_600_000)
    await check()
    expect(sendAlert).toHaveBeenCalledTimes(2)
    advance(3_600_000)
    await check()
    expect(sendAlert).toHaveBeenCalledTimes(3)
  })

  it("starts over once below the budget's first level", async () => {
    const { check, sendAlert, setUsed } = watch()
    setUsed(26)
    await check()
    setUsed(20)
    await check()
    setUsed(26)
    await check()
    expect(sendAlert).toHaveBeenCalledTimes(2)
  })

  it("alerts nothing when the database can't be read", async () => {
    const sendAlert = vi.fn(async () => {})
    const w = watchDatabaseStorage({ client: () => failingClient, sendAlert })
    stop = w.stop
    await w.check()
    const noUri = watchDatabaseStorage({
      client: () => {
        throw new Error("MONGODB_URI is not set")
      },
      sendAlert,
    })
    noUri.stop()
    await noUri.check()
    expect(sendAlert).not.toHaveBeenCalled()
  })
})
