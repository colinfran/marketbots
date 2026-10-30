import { DB_STORAGE_LIMIT_BYTES } from "@mb/core/db"
import type { MongoClient } from "mongodb"
import { describe, expect, it } from "vitest"
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

describe("databaseStorage", () => {
  it("lists every database but the system ones, largest first, against the cap", async () => {
    const view = await databaseStorage(
      fakeClient({ totalSize: 192 * MB, stats: { serverstats: { totalSize: 23 * MB }, cryptomarketbot: { totalSize: 59 * MB }, stockmarketbot: { totalSize: 79 * MB } } }),
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

  it("returns the error instead of throwing", async () => {
    const client = {
      db: () => ({
        admin: () => ({
          listDatabases: async () => {
            throw new Error("not authorized on admin")
          },
        }),
      }),
    } as unknown as MongoClient
    expect(await databaseStorage(client)).toEqual({ used_bytes: null, limit_bytes: DB_STORAGE_LIMIT_BYTES, databases: [], error: "not authorized on admin" })
  })
})
