import "server-only"
import type { AiCallDoc, AuditDoc, EngineStateDoc, NotificationDoc, SeedRunDoc } from "@mb/core/db"
import type { EventLevel, EventVisibility } from "@mb/core/events"
import type { NotableReason, WireItemDoc, WireTriggerDoc } from "@mb/core/wire"
import type { Collection, Document, Filter } from "mongodb"
import { connection } from "next/server"
import type { Viewer } from "./auth"

/**
 * The read queries both dashboards run the same way: engine state, the admin lists, events,
 * AI costs and the news engine. Each awaits `connection()`, so pages render at request time with
 * live data (never prerendered at build). Only plain, serializable values leave this module.
 * Each app binds them to its collections (lib/data.ts, lib/queries.ts) and keeps its own
 * trading queries next to them.
 */

/** The engine counts as online if its heartbeat is fresher than this. */
const HEARTBEAT_STALE_MS = 30_000

export type EngineSummary<S> = { status: S | null; online: boolean; heartbeatAgeS: number | null }

/** A news item for display (same shape as @mb/ui/wire's WireRowView; ui and web-kit can't import each other). */
export type WireRowView = {
  id: string
  title: string
  url: string | null
  source: string
  domain: string | null
  tier: 1 | 2 | 3
  category: string
  kind: string
  symbols: string[]
  severity: number
  first_seen_at: string
  notable: boolean
  notable_reasons: NotableReason[]
  price_at_seen: Record<string, number>
}

/** A trigger for display (same shape as @mb/ui/wire's TriggerView). */
export type TriggerView = {
  id: string
  at: string
  rule: string
  action: string
  status: string
  reason: string
  symbols: string[]
  severity: number
  href: string | null
  item_title: string | null
}

export type WireFilter = { symbol?: string; category?: string; minSeverity?: number; source?: string; hours?: number; limit?: number }

/** Summaries never leave the database: Benzinga items (stock's alpaca_news) may show only headline, source and link. */
export const ITEM_PROJECTION = { summary: 0, severity_parts: 0, meta: 0, confirmations: 0 } as const

export const toRowView = (i: WireItemDoc<string>): WireRowView => ({
  id: i._id,
  title: i.title,
  url: i.url,
  source: i.source,
  domain: i.domain,
  tier: i.tier,
  category: i.category,
  kind: i.kind,
  symbols: i.symbols,
  severity: i.severity,
  first_seen_at: i.first_seen_at.toISOString(),
  notable: i.notable,
  notable_reasons: i.notable_reasons,
  price_at_seen: i.price_at_seen,
})

/** The collections the shared queries read. Each bot passes its own map; the bot-specific document types are read off it. */
type QueryCollectionName = "engineStatus" | "engineState" | "events" | "commands" | "audit" | "notifications" | "seedRuns" | "aiCalls" | "wireItems" | "wireTriggers" | "cycles"

type DocOf<X> = X extends Collection<infer T> ? T : never

type LooseDoc = { _id: string | number } & Document
type Loose = Collection<LooseDoc>

export const createQueries = <Cols extends Record<QueryCollectionName, unknown>, E extends { type: string; level: EventLevel; visibility: EventVisibility }>({
  collections,
  eventForViewer,
  recentEventsFilter = {},
  triggerLinks,
}: {
  collections: () => Promise<Cols>
  /** The bot core's visibility check (its owner-only events). */
  eventForViewer: (event: E, scope: EventVisibility) => E | null
  /** Which events the default recent-events query reads. */
  recentEventsFilter?: Filter<LooseDoc>
  /** The page each trigger's cycle produced, by cycle id. */
  triggerLinks: (cycleIds: string[]) => Promise<Map<string, string>>
}) => {
  type S = DocOf<Cols["engineStatus"]>
  /**
   * The shared queries only read fields both bots have, so they work on a plain view of each
   * collection (the driver's generic types don't narrow across bots) and type their results.
   */
  const loose = async () => (await collections()) as unknown as Record<QueryCollectionName, Loose>
  const typed = async () =>
    (await collections()) as unknown as {
      engineState: Collection<EngineStateDoc>
      audit: Collection<AuditDoc>
      notifications: Collection<NotificationDoc>
      seedRuns: Collection<SeedRunDoc>
      aiCalls: Collection<AiCallDoc>
      wireTriggers: Collection<WireTriggerDoc>
    }

  const getEngine = async (): Promise<EngineSummary<S>> => {
    await connection()
    const status = (await (await loose()).engineStatus.findOne({ _id: "engine" })) as S | null
    const age = status ? (Date.now() - (status as unknown as { at: Date }).at.getTime()) / 1000 : null
    return { status, online: age !== null && age * 1000 < HEARTBEAT_STALE_MS, heartbeatAgeS: age === null ? null : Math.round(age) }
  }

  const getEngineState = async () => {
    await connection()
    return (await typed()).engineState.findOne({ _id: "engine" })
  }

  const getAudit = async (limit = 100) => {
    await connection()
    return (await typed()).audit.find({}).sort({ at: -1 }).limit(limit).toArray()
  }

  const getCommands = async (limit = 30) => {
    await connection()
    return (await (await loose()).commands.find({}).sort({ created_at: -1 }).limit(limit).toArray()) as unknown as DocOf<Cols["commands"]>[]
  }

  /** One-time seed runs, newest first (the Admin card shows the current or last one). */
  const getSeedRuns = async (limit = 5) => {
    await connection()
    return (await typed()).seedRuns.find({}).sort({ created_at: -1 }).limit(limit).toArray()
  }

  const getNotifications = async (limit = 30) => {
    await connection()
    return (await typed()).notifications.find({}).sort({ at: -1 }).limit(limit).toArray()
  }

  const toEvents = (docs: Document[], viewer: Viewer) =>
    docs
      .map(({ _id, expires_at, ...e }) => {
        void _id
        void expires_at
        return eventForViewer(e as E, viewer.owner ? "owner" : "public")
      })
      .filter((e): e is E => e !== null)

  /** Recent persisted events, filtered for the viewer (initial history for the activity feed). */
  const getRecentEvents = async (viewer: Viewer, { limit = 80, levels }: { limit?: number; levels?: EventLevel[] } = {}): Promise<E[]> => {
    await connection()
    const docs = await (await loose()).events.find(levels ? { level: { $in: levels } } : recentEventsFilter).sort({ _id: -1 }).limit(limit).toArray()
    return toEvents(docs, viewer)
  }

  /** Every stored event of one cycle, oldest first: the full trail of what the AI did. */
  const getCycleEvents = async (cycleId: string, viewer: Viewer): Promise<E[]> => {
    await connection()
    const docs = await (await loose()).events.find({ cycle_id: cycleId }).sort({ _id: 1 }).limit(2_000).toArray()
    return toEvents(docs, viewer)
  }

  /** AI spend per budget day: cost, calls and failures. */
  const getAiCosts = async (days = 30) => {
    await connection()
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
    return (await typed()).aiCalls
      .aggregate<{ _id: string; cost: number; calls: number; failures: number }>([
        { $match: { day: { $gte: since } } },
        { $group: { _id: "$day", cost: { $sum: "$cost_usd" }, calls: { $sum: 1 }, failures: { $sum: { $cond: ["$ok", 0, 1] } } } },
        { $sort: { _id: 1 } },
      ])
      .toArray()
  }

  // ─── News engine ("wire") ──────────────────────────────────────────────────

  const wireItems = async () => (await loose()).wireItems

  /** Items our feeds stored, newest first (cluster roots only: copies are confirmations on them). */
  const getWireItems = async ({ symbol, category, minSeverity, source, hours = 72, limit = 100 }: WireFilter = {}) => {
    await connection()
    const filter: Record<string, unknown> = { first_seen_at: { $gte: new Date(Date.now() - hours * 3_600_000) } }
    if (symbol) filter.symbols = symbol
    if (category) filter.category = category
    if (source) filter.source = source
    if (minSeverity) filter.severity = { $gte: minSeverity }
    const docs = (await (await wireItems()).find(filter, { projection: ITEM_PROJECTION }).sort({ first_seen_at: -1 }).limit(limit).toArray()) as unknown as WireItemDoc<string>[]
    return docs.filter((d) => d.cluster_id === d._id).map(toRowView)
  }

  /** What the Live page may show: items the engine marked notable in the last `hours`. */
  const getNotableItems = async (hours = 6, limit = 10) => {
    await connection()
    const docs = (await (await wireItems()).find({ notable: true, first_seen_at: { $gte: new Date(Date.now() - hours * 3_600_000) } }, { projection: ITEM_PROJECTION }).sort({ first_seen_at: -1 }).limit(limit).toArray()) as unknown as WireItemDoc<string>[]
    return docs.map(toRowView)
  }

  /** Items by id. */
  const getWireItemsById = async (ids: string[]) => {
    await connection()
    if (!ids.length) return []
    return ((await (await wireItems()).find({ _id: { $in: ids } }, { projection: ITEM_PROJECTION }).toArray()) as unknown as WireItemDoc<string>[]).map(toRowView)
  }

  /** Categories and sources seen recently, for the filters. */
  const getWireFacets = async (hours = 72) => {
    await connection()
    const items = await wireItems()
    const since = { first_seen_at: { $gte: new Date(Date.now() - hours * 3_600_000) } }
    const [categories, sources] = await Promise.all([items.distinct("category", since), items.distinct("source", since)])
    return { categories: (categories as string[]).sort(), sources: (sources as string[]).sort() }
  }

  /** Trigger docs for display, with the first item's title and the page of the cycle each one started. */
  const toTriggerViews = async (triggers: WireTriggerDoc[]): Promise<TriggerView[]> => {
    const itemIds = [...new Set(triggers.flatMap((t) => t.item_ids.slice(0, 1)))]
    const cycleIds = [...new Set(triggers.flatMap((t) => (t.cycle_id ? [t.cycle_id] : [])))]
    const [items, links] = await Promise.all([itemIds.length ? (await wireItems()).find({ _id: { $in: itemIds } }, { projection: { title: 1 } }).toArray() : [], triggerLinks(cycleIds)])
    const titles = new Map(items.map((i) => [String(i._id), String(i.title)]))
    return triggers.map((t) => ({
      id: t._id,
      at: t.at.toISOString(),
      rule: t.rule,
      action: t.action,
      status: t.status,
      reason: t.reason,
      symbols: t.symbols,
      severity: t.severity,
      href: t.cycle_id ? (links.get(t.cycle_id) ?? null) : null,
      item_title: titles.get(t.item_ids[0] ?? "") ?? null,
    }))
  }

  const getWireTriggers = async (limit = 40) => {
    await connection()
    return toTriggerViews(await (await typed()).wireTriggers.find({}).sort({ at: -1 }).limit(limit).toArray())
  }

  /**
   * The news-engine numbers both bots count the same way: items stored and triggers acted on in
   * the last 7 days, event cycles, and the AI spend per budget day by task (last 14 days).
   */
  const getWireActivity = async () => {
    await connection()
    const { wireTriggers, aiCalls } = await typed()
    const cycles = (await loose()).cycles
    const week = new Date(Date.now() - 7 * 86_400_000)
    const [items, triggers, eventCycles, calls] = await Promise.all([
      (await wireItems()).countDocuments({ first_seen_at: { $gte: week } }),
      wireTriggers.countDocuments({ at: { $gte: week }, status: { $in: ["fired", "queued"] } }),
      cycles.countDocuments({ kind: "event", started_at: { $gte: week } }),
      aiCalls
        .aggregate<{ _id: { day: string; task: string }; cost: number }>([{ $match: { at: { $gte: new Date(Date.now() - 14 * 86_400_000) } } }, { $group: { _id: { day: "$day", task: "$task" }, cost: { $sum: "$cost_usd" } } }])
        .toArray(),
    ])
    const days = [...new Set(calls.map((c) => c._id.day))].sort()
    const spend = (day: string, task: string) => calls.filter((c) => c._id.day === day && c._id.task === task).reduce((s, c) => s + c.cost, 0)
    return { items, triggers, eventCycles, researchSpend: days.map((day) => ({ day, research: spend(day, "research"), gap: spend(day, "research_gap"), decision: spend(day, "decision") })) }
  }

  return {
    getEngine,
    getEngineState,
    getAudit,
    getCommands,
    getSeedRuns,
    getNotifications,
    getRecentEvents,
    getCycleEvents,
    getAiCosts,
    getWireItems,
    getNotableItems,
    getWireItemsById,
    getWireFacets,
    toTriggerViews,
    getWireTriggers,
    getWireActivity,
  }
}

/** Median time from first seeing an item to the decision it led to, over decisions whose items are known. */
export const decisionLatency = (decisions: { created_at: Date; wire_item_ids?: string[] }[], firstSeen: (id: string) => Date | undefined) => {
  const latencies = decisions
    .map((d) => {
      const seen = (d.wire_item_ids ?? []).map((id) => firstSeen(id)?.getTime()).filter((t): t is number => typeof t === "number")
      return seen.length ? (d.created_at.getTime() - Math.min(...seen)) / 1000 : null
    })
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b)
  return { medianLatencyS: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null, latencySamples: latencies.length }
}
