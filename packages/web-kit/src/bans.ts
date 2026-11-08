import "server-only"
import { randomUUID } from "node:crypto"
import type { AuditDoc, WebBanDoc } from "@mb/core/db"
import type { Collection } from "mongodb"
import { NextResponse } from "next/server"
import type { Viewer } from "./auth"
import type { BanStore } from "./rate-limit"

/**
 * The rate limit's permanent bans in the bot's database (`web_bans`, docs/SERVER.md §8.6): the
 * proxy's store (@mb/web-kit/rate-limit), and the Admin page's list and Unban. Every ban and unban
 * also goes to the audit log, which keeps the history once an unban has removed the ban.
 */
export const createBans = ({ bans, audit }: { bans: () => Promise<Collection<WebBanDoc>>; audit: () => Promise<Collection<AuditDoc>> }) => {
  const record = async (entry: Omit<AuditDoc, "_id" | "at">) => {
    await (await audit()).insertOne({ _id: randomUUID(), at: new Date(), ...entry })
  }

  const store: BanStore = {
    load: async () => (await (await bans()).find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id),
    add: async ({ key, at, reason, path, userAgent }) => {
      const { upsertedCount } = await (await bans()).updateOne(
        { _id: key },
        { $setOnInsert: { banned_at: at, reason, path, user_agent: userAgent, blocked: 0, last_seen_at: null } },
        { upsert: true },
      )
      if (upsertedCount) await record({ actor: "rate limit", action: "ban", target: key, details: { reason, path, user_agent: userAgent } })
    },
    lift: async (key) => {
      const doc = await (await bans()).findOneAndDelete({ _id: key })
      if (doc) await record({ actor: "owner", action: "unban", target: key, details: { how: "signed in from the address", banned_at: doc.banned_at, blocked: doc.blocked } })
    },
    recordBlocked: async (counts) => {
      await (await bans()).bulkWrite(
        [...counts].map(([key, { count, last }]) => ({ updateOne: { filter: { _id: key }, update: { $inc: { blocked: count }, $max: { last_seen_at: new Date(last) } } } })),
        { ordered: false },
      )
    },
  }

  /** The Admin page's list, newest first. */
  const listBans = async (limit = 500): Promise<WebBanDoc[]> => (await bans()).find({}).sort({ banned_at: -1 }).limit(limit).toArray()

  /** Lifts a ban (the proxy lets the address back in within a minute) and audits it. False when there was none. */
  const unban = async (address: string, actor: string): Promise<boolean> => {
    const doc = await (await bans()).findOneAndDelete({ _id: address })
    if (!doc) return false
    await record({ actor, action: "unban", target: address, details: { banned_at: doc.banned_at, reason: doc.reason, blocked: doc.blocked } })
    return true
  }

  return { store, listBans, unban }
}

/** DELETE /api/bans (owner only), body `{ "address": "203.0.113.7" }`: lift a ban. */
export const bansRoute =
  ({ getViewer, sameOrigin, unban }: { getViewer: () => Promise<Viewer>; sameOrigin: () => Promise<boolean>; unban: (address: string, actor: string) => Promise<boolean> }) =>
  async (request: Request) => {
    if (!(await sameOrigin())) return NextResponse.json({ error: "bad origin" }, { status: 403 })
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const body = (await request.json().catch(() => null)) as { address?: unknown } | null
    const address = typeof body?.address === "string" ? body.address.trim() : ""
    if (!address || address.length > 64) return NextResponse.json({ error: "address required" }, { status: 400 })
    if (!(await unban(address, "owner"))) return NextResponse.json({ error: "That address isn't banned (anymore)." }, { status: 404 })
    return NextResponse.json({ ok: true })
  }
