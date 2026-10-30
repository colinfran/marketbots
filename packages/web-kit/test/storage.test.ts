import { DB_STORAGE_LIMIT_BYTES } from "@mb/core/db"
import type { MongoClient } from "mongodb"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetAzureTokenCache } from "../src/azure"
import { databaseStorage } from "../src/storage"

const MB = 1024 ** 2

/** A client whose listDatabases and dbStats answer with these sizes. */
const fakeClient = ({ totalSize, stats }: { totalSize?: number; stats: Record<string, Record<string, number>> }) =>
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

afterEach(() => {
  vi.unstubAllGlobals()
  resetAzureTokenCache()
})

describe("databaseStorage", () => {
  it("lists every database but the system ones, largest first, against the cap", async () => {
    const view = await databaseStorage(
      fakeClient({ totalSize: 192 * MB, stats: { serverstats: { totalSize: 23 * MB }, cryptomarketbot: { totalSize: 59 * MB }, stockmarketbot: { totalSize: 79 * MB } } }),
      null,
    )
    expect(view).toEqual({
      used_bytes: 192 * MB,
      limit_bytes: DB_STORAGE_LIMIT_BYTES,
      databases: [
        { name: "stockmarketbot", bytes: 79 * MB },
        { name: "cryptomarketbot", bytes: 59 * MB },
        { name: "serverstats", bytes: 23 * MB },
      ],
      error: null,
      azure: null,
      azure_error: null,
    })
  })

  it("never reports less than the databases themselves, and adds up storage and indexes without totalSize", async () => {
    const view = await databaseStorage(fakeClient({ stats: { a: { storageSize: 10 * MB, indexSize: 2 * MB }, b: { totalSize: 5 * MB } } }), null)
    expect(view.used_bytes).toBe(17 * MB)
    expect(view.databases).toEqual([
      { name: "a", bytes: 12 * MB },
      { name: "b", bytes: 5 * MB },
    ])
  })

  it("returns the error instead of throwing", async () => {
    expect(await databaseStorage(failingClient, null)).toEqual({ used_bytes: null, limit_bytes: DB_STORAGE_LIMIT_BYTES, databases: [], error: "not authorized on admin", azure: null, azure_error: null })
  })

  it("adds Azure's count when configured, and shows each side's failure on its own", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("login.microsoftonline.com")
          ? new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }))
          : new Response(
              JSON.stringify({
                value: [
                  { name: { value: "StorageUsed" }, timeseries: [{ data: [{ timeStamp: "2026-10-30T22:02:00Z", maximum: 4_958_121_984 }] }] },
                  { name: { value: "StoragePercent" }, timeseries: [{ data: [{ timeStamp: "2026-10-30T22:02:00Z", maximum: 14.8 }] }] },
                ],
              }),
            ),
      ),
    )
    const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", resourceId: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.DocumentDB/mongoClusters/x" }
    const view = await databaseStorage(failingClient, cfg)
    expect(view.azure).toMatchObject({ used_bytes: 4_958_121_984, percent: 14.8 })
    expect(view.azure_error).toBeNull()
    expect(view.error).toBe("not authorized on admin")
  })
})
