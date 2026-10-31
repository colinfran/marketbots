import { randomUUID } from "node:crypto"
import { BASE_COLLECTIONS, type AuditDoc, type CommandStatus } from "@mb/core/db"
import { HOST_COLLECTIONS, type EnergyPeriod, type HostCommandDoc, type HostSampleDoc, type HostStatusDoc } from "@mb/core/host"
import type { Db, MongoClient } from "mongodb"
import { EnergyMinutes } from "./energy"

/**
 * The agent's side of MongoDB: its documents, written into each of HOST_DATABASES (its own database,
 * `serverstats`, which both dashboards read); and the owner's commands, taken from any of them.
 */

const DAY_MS = 86_400_000

/** How long the kept energy minutes are trusted before being read again (another process may have written some: the history import). */
const ENERGY_RELOAD_MS = DAY_MS

export type EnergyTotals = { today_recorded_kwh: number | null; last_24h: EnergyPeriod; last_7d: EnergyPeriod; last_30d: EnergyPeriod }

export class HostStore {
  private readonly dbs: Db[]
  private energyMinutes: EnergyMinutes | null = null

  constructor(client: MongoClient, names: string[]) {
    this.dbs = names.map((n) => client.db(n))
  }

  /** The collections' indexes; minute and raw samples, and old commands, expire on their own. */
  async init() {
    await Promise.all(
      this.dbs.map(async (db) => {
        await db.collection(HOST_COLLECTIONS.samples).createIndexes([{ key: { res: 1, t: 1 } }, { key: { res: 1, outlet_id: 1, t: 1 } }, { key: { expires_at: 1 }, expireAfterSeconds: 0 }])
        await db.collection(HOST_COLLECTIONS.commands).createIndexes([{ key: { status: 1, created_at: 1 } }, { key: { created_at: 1 }, expireAfterSeconds: 30 * 86_400 }])
      }),
    )
  }

  /** The latest reading and any finished samples, into every database. */
  async write(status: HostStatusDoc, samples: HostSampleDoc[]) {
    await Promise.all(this.dbs.map((db) => Promise.all([db.collection<HostStatusDoc>(HOST_COLLECTIONS.status).replaceOne({ _id: "current" }, status, { upsert: true }), this.upsert(db, samples)])))
    for (const s of samples) this.energyMinutes?.put(s)
  }

  /** Samples into every database: replacing any with the same bucket, or with `keep`, only where there is none (the history import). */
  async writeSamples(samples: HostSampleDoc[], { keep = false } = {}) {
    await Promise.all(this.dbs.map((db) => this.upsert(db, samples, keep)))
    for (const s of samples) this.energyMinutes?.put(s, keep)
  }

  private async upsert(db: Db, samples: HostSampleDoc[], keep = false) {
    if (!samples.length) return
    await db
      .collection<HostSampleDoc>(HOST_COLLECTIONS.samples)
      .bulkWrite(
        samples.map((s) => (keep ? { updateOne: { filter: { _id: s._id }, update: { $setOnInsert: s }, upsert: true } } : { replaceOne: { filter: { _id: s._id }, replacement: s, upsert: true } })),
        { ordered: false },
      )
  }

  /** Recorded use of one outlet from the minute samples: since `dayStart`, and over the last 24 hours, 7 and 30 days. */
  async energy(outlet: string, now: number, dayStart: number): Promise<EnergyTotals> {
    const windows = { today: now - dayStart, last_24h: DAY_MS, last_7d: 7 * DAY_MS, last_30d: 30 * DAY_MS }
    const sums = (await this.keptMinutes(outlet, now)).totals(now, windows)
    const period = (name: keyof typeof windows): EnergyPeriod => ({ kwh: sums[name].ms ? sums[name].wh / 1000 : null, recorded_ms: sums[name].ms, window_ms: windows[name] })
    return { today_recorded_kwh: period("today").kwh, last_24h: period("last_24h"), last_7d: period("last_7d"), last_30d: period("last_30d") }
  }

  /** The outlet's kept minutes: read from the database the first time, after a day, or for another outlet. */
  private async keptMinutes(outlet: string, now: number): Promise<EnergyMinutes> {
    const kept = this.energyMinutes
    if (kept?.outlet === outlet && now - kept.loadedAt < ENERGY_RELOAD_MS) return kept
    // Kept from the start, so minutes written while the read runs are in it.
    const fresh = new EnergyMinutes(outlet, now)
    this.energyMinutes = fresh
    try {
      fresh.load(
        await this.dbs[0]
          .collection<HostSampleDoc>(HOST_COLLECTIONS.samples)
          .find({ res: "1m", outlet_id: outlet, t: { $gte: new Date(now - 30 * DAY_MS) } }, { projection: { res: 1, t: 1, wh: 1, covered_ms: 1, outlet_id: 1 } })
          .toArray(),
      )
      return fresh
    } catch (error) {
      if (this.energyMinutes === fresh) this.energyMinutes = null
      throw error
    }
  }

  /** The oldest pending command in any database, claimed (status → processing). */
  async nextCommand(): Promise<{ db: Db; doc: HostCommandDoc } | null> {
    for (const db of this.dbs) {
      const doc = await db
        .collection<HostCommandDoc>(HOST_COLLECTIONS.commands)
        .findOneAndUpdate({ status: "pending" }, { $set: { status: "processing", processed_at: new Date() } }, { sort: { created_at: 1 }, returnDocument: "after" })
      if (doc) return { db, doc }
    }
    return null
  }

  /** A command's outcome, and its audit entry. */
  async finish(db: Db, doc: HostCommandDoc, status: CommandStatus, result: string | null, error: string | null) {
    await db.collection<HostCommandDoc>(HOST_COLLECTIONS.commands).updateOne({ _id: doc._id }, { $set: { status, result, error, processed_at: new Date() } })
    await db.collection<AuditDoc>(BASE_COLLECTIONS.audit).insertOne({
      _id: randomUUID(),
      at: new Date(),
      actor: "host-agent",
      action: `host_command.${status}`,
      target: doc._id,
      details: { type: doc.type, requested_by: doc.created_by, result, error },
    })
  }
}
