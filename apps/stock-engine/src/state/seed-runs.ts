// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import { randomUUID } from "node:crypto"
import type { SeedRunDoc } from "@mb/stock-core/db"
import type { Collections } from "../db/mongo"

/**
 * Lifecycle of the owner's one-time seed buy (the `seed_runs` collection):
 *
 *   scheduled ──(due, engine running)──▶ running ──▶ done | failed
 *       │ └──(not started in time)──▶ failed ("missed")
 *       └──(seed.cancel)──▶ canceled
 *
 * Only one run is scheduled or running at a time, and a new one is refused while any run is
 * `done` unless the command sets `force`: that is how "once, unless the owner asks again" is
 * enforced. A run is a single attempt; nothing here ever retries one.
 */

type SeedCol = Pick<Collections, "seedRuns">

const MINUTE = 60_000
/** A schedule time this far in the past is a mistake, not a request to buy right now. */
const MAX_PAST_MINUTES = 10
const MAX_FUTURE_DAYS = 30

export type ScheduleSeedInput = { amount_usd: number; at: string; force?: boolean }

export const scheduleSeed = async (col: SeedCol, input: ScheduleSeedInput, by: string, now = new Date()): Promise<SeedRunDoc> => {
  const at = new Date(input.at)
  if (!Number.isFinite(at.getTime())) throw new Error("invalid seed time")
  if (at.getTime() < now.getTime() - MAX_PAST_MINUTES * MINUTE) throw new Error("the seed time is in the past")
  if (at.getTime() > now.getTime() + MAX_FUTURE_DAYS * 1_440 * MINUTE) throw new Error(`the seed time is more than ${MAX_FUTURE_DAYS} days away`)
  const active = await col.seedRuns.findOne({ status: { $in: ["scheduled", "running"] } })
  if (active) throw new Error(`a seed is already ${active.status} (${active.at.toISOString()}); cancel it first`)
  const done = await col.seedRuns.findOne({ status: "done" }, { sort: { done_at: -1 } })
  if (done && !input.force) throw new Error(`a seed already ran (${(done.done_at ?? done.at).toISOString().slice(0, 10)}); tick "force a new seed" to run another`)
  const doc: SeedRunDoc = {
    _id: randomUUID(),
    status: "scheduled",
    amount_usd: input.amount_usd,
    at,
    created_at: now,
    created_by: by,
    force: !!input.force,
    started_at: null,
    cycle_id: null,
    result: null,
    error: null,
    done_at: null,
  }
  await col.seedRuns.insertOne(doc)
  return doc
}

export const cancelSeed = async (col: SeedCol, now = new Date()): Promise<SeedRunDoc> => {
  const doc = await col.seedRuns.findOneAndUpdate({ status: "scheduled" }, { $set: { status: "canceled", done_at: now } }, { returnDocument: "after" })
  if (!doc) throw new Error("no scheduled seed to cancel")
  return doc
}

/** Scheduled runs that can no longer start in time are failed, never run late. Returns them for alerting. */
export const failMissedSeeds = async (col: SeedCol, deadline: (run: SeedRunDoc) => Date, now = new Date()): Promise<SeedRunDoc[]> => {
  const missed: SeedRunDoc[] = []
  for (const run of await col.seedRuns.find({ status: "scheduled", at: { $lte: now } }).toArray()) {
    if (deadline(run).getTime() > now.getTime()) continue
    const error = `missed: the engine could not start the seed between ${run.at.toISOString()} and ${deadline(run).toISOString()}`
    const res = await col.seedRuns.updateOne({ _id: run._id, status: "scheduled" }, { $set: { status: "failed", error, done_at: now } })
    if (res.modifiedCount) missed.push({ ...run, status: "failed", error, done_at: now })
  }
  return missed
}

/** Atomically moves the oldest due run from scheduled to running, so it can only start once. */
export const claimDueSeed = (col: SeedCol, now = new Date()) =>
  col.seedRuns.findOneAndUpdate({ status: "scheduled", at: { $lte: now } }, { $set: { status: "running", started_at: now } }, { sort: { at: 1 }, returnDocument: "after" })

/** A run left `running` by a previous process stopped mid-way. It is failed, not resumed. */
export const failInterruptedSeeds = async (col: SeedCol, now = new Date()) => {
  const res = await col.seedRuns.updateMany({ status: "running" }, { $set: { status: "failed", error: "the engine restarted during the seed run", done_at: now } })
  return res.modifiedCount
}

export const finishSeed = (col: SeedCol, id: string, fields: Pick<SeedRunDoc, "status" | "cycle_id" | "result" | "error">, now = new Date()) =>
  col.seedRuns.updateOne({ _id: id }, { $set: { ...fields, done_at: now } })
