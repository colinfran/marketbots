import "server-only"
import type { AiCallDoc, AuditDoc, EngineStateDoc, NotificationDoc } from "@mb/core/db"
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
  /** The local model's summary of the article, when it passed every check (@mb/wire/enrich). */
  article: ArticleView | null
}

/** A machine summary for display (same shape as @mb/ui/wire's ArticleView). */
export type ArticleView = { summary: string; key_points: string[]; model: string; at: string }

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
  item_title: string | null
}

export type WireFilter = { symbol?: string; category?: string; minSeverity?: number; source?: string; hours?: number; limit?: number }

/**
 * Feed summaries never leave the database: Benzinga items (stock's alpaca_news) may show only
 * headline, source and link. The local model's article summary (`article`) does: it is ours, made
 * from the publisher's page, and never from Benzinga's (enrich/select.ts skips benzinga.com).
 */
export const ITEM_PROJECTION = { summary: 0, severity_parts: 0, meta: 0, confirmations: 0 } as const

/** Only a summary that passed every check is shown; skipped, failed and rejected ones stay in the database. */
const toArticleView = (a: WireItemDoc<string>["article"]): ArticleView | null =>
  a?.status === "ok" && a.summary ? { summary: a.summary, key_points: a.key_points ?? [], model: a.model, at: a.at.toISOString() } : null

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
  article: toArticleView(i.article),
})

/** The collections the shared queries read. Each bot passes its own map; the bot-specific document types are read off it. */
type QueryCollectionName = "engineStatus" | "engineState" | "events" | "commands" | "audit" | "notifications" | "aiCalls" | "wireItems" | "wireTriggers"

type DocOf<X> = X extends Collection<infer T> ? T : never

type LooseDoc = { _id: string | number } & Document
type Loose = Collection<LooseDoc>

export const createQueries = <Cols extends Record<QueryCollectionName, unknown>, E extends { type: string; level: EventLevel; visibility: EventVisibility }>({
  collections,
  eventForViewer,
  recentEventsFilter = {},
}: {
  collections: () => Promise<Cols>
  /** The bot core's visibility check (its owner-only events). */
  eventForViewer: (event: E, scope: EventVisibility) => E | null
  /** Which events the default recent-events query reads. */
  recentEventsFilter?: Filter<LooseDoc>
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

  /** Trigger docs for display, with the first item's title. */
  const toTriggerViews = async (triggers: WireTriggerDoc[]): Promise<TriggerView[]> => {
    const itemIds = [...new Set(triggers.flatMap((t) => t.item_ids.slice(0, 1)))]
    const items = itemIds.length ? await (await wireItems()).find({ _id: { $in: itemIds } }, { projection: { title: 1 } }).toArray() : []
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
      item_title: titles.get(t.item_ids[0] ?? "") ?? null,
    }))
  }

  const getWireTriggers = async (limit = 40) => {
    await connection()
    return toTriggerViews(await (await typed()).wireTriggers.find({}).sort({ at: -1 }).limit(limit).toArray())
  }

  /** The news-engine numbers both bots count the same way: items stored and triggers acted on in the last 7 days. */
  const getWireActivity = async () => {
    await connection()
    const { wireTriggers } = await typed()
    const week = new Date(Date.now() - 7 * 86_400_000)
    const [items, triggers] = await Promise.all([(await wireItems()).countDocuments({ first_seen_at: { $gte: week } }), wireTriggers.countDocuments({ at: { $gte: week }, status: { $in: ["fired", "queued"] } })])
    return { items, triggers }
  }

  return {
    getEngine,
    getEngineState,
    getAudit,
    getCommands,
    getNotifications,
    getRecentEvents,
    getWireItems,
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
