import type { AuditDoc, WebBanDoc } from "@mb/core/db"
import type { Collection } from "mongodb"
import { describe, expect, it, vi } from "vitest"
import { bansRoute, createBans } from "../src/bans"

/** Just the collection calls the bans module makes, over an array. */
const fakeBans = () => {
  const docs = new Map<string, WebBanDoc>()
  const collection = {
    find: (_filter: object, options?: { projection?: object }) => {
      let rows = [...docs.values()]
      const cursor = {
        sort: (spec: { banned_at: 1 | -1 }) => {
          rows = rows.sort((a, b) => spec.banned_at * (a.banned_at.getTime() - b.banned_at.getTime()))
          return cursor
        },
        limit: (n: number) => {
          rows = rows.slice(0, n)
          return cursor
        },
        toArray: async () => (options?.projection ? rows.map((d) => ({ _id: d._id })) : rows),
      }
      return cursor
    },
    updateOne: async (filter: { _id: string }, update: { $setOnInsert: Omit<WebBanDoc, "_id"> }) => {
      if (docs.has(filter._id)) return { upsertedCount: 0 }
      docs.set(filter._id, { _id: filter._id, ...update.$setOnInsert })
      return { upsertedCount: 1 }
    },
    findOneAndDelete: async (filter: { _id: string }) => {
      const doc = docs.get(filter._id) ?? null
      docs.delete(filter._id)
      return doc
    },
    bulkWrite: async (ops: { updateOne: { filter: { _id: string }; update: { $inc: { blocked: number }; $max: { last_seen_at: Date } } } }[]) => {
      for (const { updateOne } of ops) {
        const doc = docs.get(updateOne.filter._id)
        if (!doc) continue
        doc.blocked += updateOne.update.$inc.blocked
        if (!doc.last_seen_at || doc.last_seen_at < updateOne.update.$max.last_seen_at) doc.last_seen_at = updateOne.update.$max.last_seen_at
      }
    },
  }
  return { docs, collection: collection as unknown as Collection<WebBanDoc> }
}

const setup = () => {
  const { docs, collection } = fakeBans()
  const audit: AuditDoc[] = []
  const auditCollection = { insertOne: async (doc: AuditDoc) => void audit.push(doc) } as unknown as Collection<AuditDoc>
  const bans = createBans({ bans: async () => collection, audit: async () => auditCollection })
  return { docs, audit, ...bans }
}

const ban = (key: string, at = new Date("2026-11-08T18:00:00Z")) => ({ key, at, reason: "kept going", path: "/trades", userAgent: "scraper/1.0" })

describe("createBans", () => {
  it("saves a ban once, audits it, and loads the addresses", async () => {
    const { docs, audit, store } = setup()
    await store.add(ban("203.0.113.7"))
    await store.add(ban("203.0.113.7"))
    expect(docs.get("203.0.113.7")).toEqual({
      _id: "203.0.113.7",
      banned_at: new Date("2026-11-08T18:00:00Z"),
      reason: "kept going",
      path: "/trades",
      user_agent: "scraper/1.0",
      blocked: 0,
      last_seen_at: null,
    })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor: "rate limit", action: "ban", target: "203.0.113.7", details: { reason: "kept going", path: "/trades", user_agent: "scraper/1.0" } })
    expect(await store.load()).toEqual(["203.0.113.7"])
  })

  it("adds up refused requests and keeps the latest time, skipping lifted bans", async () => {
    const { docs, store } = setup()
    await store.add(ban("a"))
    const t1 = Date.parse("2026-11-08T19:00:00Z")
    await store.recordBlocked(new Map([["a", { count: 3, last: t1 }], ["gone", { count: 1, last: t1 }]]))
    await store.recordBlocked(new Map([["a", { count: 2, last: t1 - 1 }]]))
    expect(docs.get("a")).toMatchObject({ blocked: 5, last_seen_at: new Date(t1) })
    expect(docs.has("gone")).toBe(false)
  })

  it("lists newest first and unbans with an audit entry", async () => {
    const { audit, store, listBans, unban } = setup()
    await store.add(ban("old", new Date("2026-11-01T00:00:00Z")))
    await store.add(ban("new", new Date("2026-11-08T00:00:00Z")))
    expect((await listBans()).map((b) => b._id)).toEqual(["new", "old"])
    expect(await unban("old", "owner")).toBe(true)
    expect(await unban("old", "owner")).toBe(false)
    expect((await listBans()).map((b) => b._id)).toEqual(["new"])
    expect(audit.at(-1)).toMatchObject({ actor: "owner", action: "unban", target: "old", details: { reason: "kept going", blocked: 0 } })
  })

  it("lifts a ban when the owner signs in from the address", async () => {
    const { docs, audit, store } = setup()
    await store.add(ban("a"))
    await store.lift("a")
    await store.lift("a")
    expect(docs.size).toBe(0)
    expect(audit.filter((a) => a.action === "unban")).toHaveLength(1)
  })
})

describe("bansRoute", () => {
  const request = (body: unknown) => new Request("https://cryptomarketbot.app/api/bans", { method: "DELETE", body: JSON.stringify(body) })
  const route = (opts: { owner?: boolean; sameOrigin?: boolean; found?: boolean } = {}) => {
    const unban = vi.fn(async () => opts.found ?? true)
    const handler = bansRoute({ getViewer: async () => ({ owner: opts.owner ?? true }), sameOrigin: async () => opts.sameOrigin ?? true, unban })
    return { handler, unban }
  }

  it("unbans for the owner, from this site", async () => {
    const { handler, unban } = route()
    const res = await handler(request({ address: " 203.0.113.7 " }))
    expect(res.status).toBe(200)
    expect(unban).toHaveBeenCalledWith("203.0.113.7", "owner")
  })

  it("refuses other sites, the public, bad bodies and unknown addresses", async () => {
    expect((await route({ sameOrigin: false }).handler(request({ address: "a" }))).status).toBe(403)
    expect((await route({ owner: false }).handler(request({ address: "a" }))).status).toBe(401)
    expect((await route().handler(request({}))).status).toBe(400)
    expect((await route().handler(request({ address: "x".repeat(65) }))).status).toBe(400)
    expect((await route({ found: false }).handler(request({ address: "a" }))).status).toBe(404)
  })
})
