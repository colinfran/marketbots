import "server-only"
import { randomUUID } from "node:crypto"
import type { AuditDoc } from "@mb/core/db"
import {
  HOST_COLLECTIONS,
  HOST_RANGES,
  hostCommandSchema,
  isHostRange,
  type HostChartPoint,
  type HostCommandDoc,
  type HostHistoryView,
  type HostRange,
  type HostSampleDoc,
  type HostStatusDoc,
  type HostStatusView,
} from "@mb/core/host"
import type { Collection, Db } from "mongodb"
import { connection, NextResponse } from "next/server"
import type { Viewer } from "./auth"
import type { SubmitResult } from "./commands"

/**
 * Admin → Server (docs/SERVER.md §11), the same in both dashboards: the host agent's latest
 * reading, its chart samples, and the owner's commands for it, all in the agent's own database
 * (HOST_DB_NAME); a command's audit entry goes to the bot's audit log. Owner only: the page lists
 * the machine's volumes and devices.
 */

export type HostCollections = {
  hostStatus: Collection<HostStatusDoc>
  hostSamples: Collection<HostSampleDoc>
  hostCommands: Collection<HostCommandDoc>
  audit: Collection<AuditDoc>
}

/** The host agent's collections, in its own database `name` on the bot database's cluster, for a dashboard's collection map (lib/db.ts). */
export const hostCollections = (d: Db, name: string) => {
  const host = d.client.db(name)
  return {
    hostStatus: host.collection<HostStatusDoc>(HOST_COLLECTIONS.status),
    hostSamples: host.collection<HostSampleDoc>(HOST_COLLECTIONS.samples),
    hostCommands: host.collection<HostCommandDoc>(HOST_COLLECTIONS.commands),
  }
}

/** Dates become ISO strings, as the page receives them. */
const toView = (doc: HostStatusDoc): HostStatusView => JSON.parse(JSON.stringify(doc)) as HostStatusView

type Bucket = { _id: Date; cpu: number | null; cpu_temp: number | null; memory: number | null; watts: number | null }
type CardBucket = { _id: { b: Date; id: string }; model: string; util: number | null; temp: number | null }

export const createHost = <Cols extends HostCollections>({ collections }: { collections: () => Promise<Cols> }) => {
  const getHostStatus = async (): Promise<HostStatusView | null> => {
    await connection()
    const { hostStatus } = await collections()
    const doc = await hostStatus.findOne({ _id: "current" })
    return doc ? toView(doc) : null
  }

  /** A range's chart points: the samples as recorded, or averaged into the range's bins. */
  const getHostHistory = async (range: HostRange): Promise<HostHistoryView> => {
    await connection()
    const { hostSamples } = await collections()
    const r = HOST_RANGES[range]
    const filter = { res: r.res, t: { $gte: new Date(Date.now() - r.ms) } }
    const models = new Map<string, string>()
    let points: HostChartPoint[]
    if (r.bin_s === 0) {
      const docs = await hostSamples.find(filter, { projection: { t: 1, cpu: 1, cpu_temp: 1, memory: 1, watts: 1, gpus: 1 } }).sort({ t: 1 }).limit(5_000).toArray()
      points = docs.map((d) => {
        for (const g of d.gpus) models.set(g.id, g.model)
        return { t: d.t.getTime(), cpu: d.cpu, cpu_temp: d.cpu_temp, memory: d.memory, watts: d.watts, gpus: Object.fromEntries(d.gpus.map((g) => [g.id, { util: g.util, temp: g.temp }])) }
      })
    } else {
      const bin = { $dateTrunc: { date: "$t", unit: "second", binSize: r.bin_s } }
      const [buckets, cards] = await Promise.all([
        hostSamples
          .aggregate<Bucket>([{ $match: filter }, { $group: { _id: bin, cpu: { $avg: "$cpu" }, cpu_temp: { $avg: "$cpu_temp" }, memory: { $avg: "$memory" }, watts: { $avg: "$watts" } } }, { $sort: { _id: 1 } }])
          .toArray(),
        hostSamples
          .aggregate<CardBucket>([{ $match: filter }, { $unwind: "$gpus" }, { $group: { _id: { b: bin, id: "$gpus.id" }, model: { $last: "$gpus.model" }, util: { $avg: "$gpus.util" }, temp: { $avg: "$gpus.temp" } } }])
          .toArray(),
      ])
      const byBin = new Map<number, HostChartPoint["gpus"]>()
      for (const c of cards) {
        models.set(c._id.id, c.model)
        const t = c._id.b.getTime()
        byBin.set(t, { ...byBin.get(t), [c._id.id]: { util: c.util, temp: c.temp } })
      }
      points = buckets.map((b) => ({ t: b._id.getTime(), cpu: b.cpu, cpu_temp: b.cpu_temp, memory: b.memory, watts: b.watts, gpus: byBin.get(b._id.getTime()) ?? {} }))
    }
    return { range, points, gpus: [...models].map(([id, model]) => ({ id, model })) }
  }

  /** Queues a command for the host agent, with an audit entry; validated again by the agent. */
  const submitHostCommand = async (input: unknown, actor: string): Promise<SubmitResult> => {
    const parsed = hostCommandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") }
    const command = parsed.data
    const { hostCommands, audit } = await collections()
    const id = randomUUID()
    const now = new Date()
    await hostCommands.insertOne({ _id: id, type: command.type, command, status: "pending", created_at: now, created_by: actor, processed_at: null, result: null, error: null })
    await audit.insertOne({ _id: randomUUID(), at: now, actor, action: "host_command.requested", target: id, details: { type: command.type, command } })
    return { ok: true, id }
  }

  return { getHostStatus, getHostHistory, submitHostCommand }
}

type Gate = { getViewer: () => Promise<Viewer> }

const NO_STORE = { headers: { "cache-control": "no-store" } }

/** GET /api/host/status (owner only): the latest reading, polled by the page every 2 seconds. */
export const hostStatusRoute =
  ({ getViewer, getHostStatus }: Gate & { getHostStatus: () => Promise<HostStatusView | null> }) =>
  async () => {
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    return NextResponse.json(await getHostStatus(), NO_STORE)
  }

/** GET /api/host/history?range=1h (owner only): a range's chart points. */
export const hostHistoryRoute =
  ({ getViewer, getHostHistory }: Gate & { getHostHistory: (range: HostRange) => Promise<HostHistoryView> }) =>
  async (request: Request) => {
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const range = new URL(request.url).searchParams.get("range")
    if (!isHostRange(range)) return NextResponse.json({ error: "unknown range" }, { status: 400 })
    return NextResponse.json(await getHostHistory(range), NO_STORE)
  }

/** POST /api/host/commands (owner only): queue a fan, settings or outlet command for the host agent. */
export const hostCommandsRoute =
  ({ getViewer, sameOrigin, submitHostCommand }: Gate & { sameOrigin: () => Promise<boolean>; submitHostCommand: (input: unknown, actor: string) => Promise<SubmitResult> }) =>
  async (request: Request) => {
    if (!(await sameOrigin())) return NextResponse.json({ error: "bad origin" }, { status: 403 })
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const result = await submitHostCommand(await request.json().catch(() => null), "owner")
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ id: result.id }, { status: 202 })
  }
