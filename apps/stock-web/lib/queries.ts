import "server-only"
import type { Bar, PortfolioHistory } from "@mb/stock-core/alpaca"
import type { AccountSnapshot, ChartBars, DecisionDoc, EngineStatusDoc, OrderDoc } from "@mb/stock-core/db"
import { eventForViewer } from "@mb/stock-core/events"
import { FILLED_ORDERS, fillsFromOrders, type OrderFill } from "@mb/stock-core/fills"
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "@mb/stock-core/settings"
import { addDays, marketDay, marketTime } from "@mb/stock-core/time"
import { signEngineRequest } from "@mb/stock-core/stream-token"
import { createEngineStatus, type EngineSummary as EngineSummaryOf } from "@mb/web-kit/engine-status"
import { createQueries, decisionLatency } from "@mb/web-kit/queries"
import { azureMonitorConfig } from "@mb/web-kit/azure"
import { databaseStorage } from "@mb/web-kit/storage"
import { connection } from "next/server"
import { getEpisodesBetween } from "./agent"
import { collections, mongoClient } from "./db"
import { env } from "./env"

/**
 * Read queries for the dashboard and JSON API. The engine's heartbeat comes from the engine itself;
 * everything else from MongoDB: the engine writes the books and copies the Alpaca data the site
 * shows (account, equity history, chart bars) into the `cache` collection. Each query awaits
 * `connection()`, so pages render at request time.
 * The queries both dashboards share come from @mb/web-kit/queries; stock's own follow.
 */

// ─── Engine ──────────────────────────────────────────────────────────────────

export type EngineSummary = EngineSummaryOf<EngineStatusDoc>

/** The engine's heartbeat, from the engine itself (@mb/web-kit/engine-status). */
export const getEngine = createEngineStatus<EngineStatusDoc>({ streamUrl: env.engineStreamUrl, secret: env.streamTokenSecret, sign: signEngineRequest })

export const {
  getEngineState,
  getAudit,
  getCommands,
  getNotifications,
  getRecentEvents,
  getWireItems,
  getWireFacets,
  toTriggerViews,
  getWireTriggers,
  getWireActivity,
} = createQueries({
  collections,
  eventForViewer,
})

export const getSettingsDoc = async () => {
  await connection()
  return (await collections()).settings.findOne({ _id: "current" })
}

/** Current settings, or the defaults before the engine has ever started. */
export const getSettings = async (): Promise<Settings> => {
  const doc = await getSettingsDoc().catch(() => null)
  const parsed = settingsSchema.safeParse(doc?.settings)
  return parsed.success ? parsed.data : DEFAULT_SETTINGS
}

// ─── Account ─────────────────────────────────────────────────────────────────

const readCache = async <T>(key: string): Promise<{ data: T; fetched_at: Date } | null> => {
  const doc = await (await collections()).cache.findOne({ _id: key })
  return doc ? { data: doc.data as T, fetched_at: doc.fetched_at } : null
}

/** Account, positions and clock from the engine's snapshot (refreshed every 15 seconds and after every fill). */
/** Admin → System: the cluster's storage, both bots' databases included, and Azure's count when configured (@mb/web-kit/storage). */
export const getDatabaseStorage = async () => {
  await connection()
  return databaseStorage(mongoClient(), azureMonitorConfig(env))
}

export const getLiveAccount = async () => {
  await connection()
  const db = await collections()
  const [cached, plans, options, settings] = await Promise.all([
    readCache<AccountSnapshot>("alpaca:account"),
    db.plans.find().toArray(),
    db.optionPositions.find({ status: { $in: ["opening", "open", "closing"] } }).sort({ opened_at: -1 }).toArray(),
    getSettings(),
  ])
  if (!cached) return null
  const { account, positions, clock, as_of } = cached.data
  const starting = settings.account.starting_capital
  const equity = Number(account.equity)
  const lastEquity = Number(account.last_equity) || equity
  const planBySymbol = new Map(plans.map((p) => [p._id, p]))
  const stocks = positions.filter((p) => (p.asset_class ?? "us_equity") === "us_equity")
  return {
    equity,
    cash: Number(account.cash),
    dayPnl: equity - lastEquity,
    dayPnlPct: lastEquity ? ((equity - lastEquity) / lastEquity) * 100 : 0,
    totalPnl: equity - starting,
    totalPnlPct: ((equity - starting) / starting) * 100,
    startingCapital: starting,
    optionsLevel: account.options_trading_level ?? account.options_approved_level ?? null,
    clock,
    asOf: as_of,
    positions: stocks.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgEntry: Number(p.avg_entry_price),
      price: Number(p.current_price),
      marketValue: Number(p.market_value),
      unrealizedPl: Number(p.unrealized_pl),
      unrealizedPlPct: Number(p.unrealized_plpc) * 100,
      todayPlPct: Number(p.unrealized_intraday_plpc) * 100,
      plan: planBySymbol.get(p.symbol) ?? null,
    })),
    options,
    optionsValue: options.reduce((sum, o) => sum + (o.mark ? o.mark.value * 100 * o.qty : (o.cost_usd ?? 0)), 0),
  }
}

export type LiveAccount = NonNullable<Awaited<ReturnType<typeof getLiveAccount>>>


const HISTORY = [
  { key: "1D", label: "1D" },
  { key: "1W", label: "1W" },
  { key: "1M", label: "1M" },
  { key: "1A", label: "1Y" },
] as const

export type EquitySeries = { key: string; label: string; points: { t: number; equity: number }[] }

export const getEquitySeries = async (): Promise<EquitySeries[]> => {
  await connection()
  return Promise.all(
    HISTORY.map(async (range) => {
      const history = (await readCache<PortfolioHistory>(`alpaca:history:${range.key}`))?.data
      const points = (history?.timestamp ?? [])
        .map((t, i) => ({ t: t * 1000, equity: history!.equity[i] }))
        .filter((p): p is { t: number; equity: number } => typeof p.equity === "number" && p.equity > 0)
      return { key: range.key, label: range.label, points }
    }),
  )
}

// ─── Decisions, days ─────────────────────────────────────────────────────────

/** A decision with the news items behind it, when news woke the agent (the "Triggered by" line). */
export type DecisionRow = DecisionDoc & { triggered_by?: { id: string; title: string; url: string | null }[] }

const withTriggers = async (decisions: DecisionDoc[]): Promise<DecisionRow[]> => {
  const ids = [...new Set(decisions.flatMap((d) => d.wire_item_ids ?? []))]
  if (!ids.length) return decisions
  const items = await (await collections()).wireItems.find({ _id: { $in: ids } }, { projection: { title: 1, url: 1 } }).toArray()
  const byId = new Map(items.map((i) => [i._id, { id: i._id, title: i.title, url: i.url }]))
  return decisions.map((d) => (d.wire_item_ids?.length ? { ...d, triggered_by: d.wire_item_ids.flatMap((id) => byId.get(id) ?? []) } : d))
}

export const listRecentDecisions = async (limit = 60): Promise<DecisionRow[]> => {
  await connection()
  return withTriggers(await (await collections()).decisions.find().sort({ created_at: -1 }).limit(limit).toArray())
}

/** Latest decision per symbol (for the market board). */
export const getLatestDecisions = async () => {
  await connection()
  const rows = await (await collections()).decisions
    .aggregate<{ _id: string; action: DecisionDoc["action"]; status: DecisionDoc["status"]; at: Date; report_id: string; agent_episode_id: string | null }>([
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id: "$symbol",
          action: { $first: "$action" },
          status: { $first: "$status" },
          at: { $first: "$created_at" },
          report_id: { $first: "$report_id" },
          agent_episode_id: { $first: { $ifNull: ["$agent_episode_id", null] } },
        },
      },
    ])
    .toArray()
  return Object.fromEntries(rows.map((r) => [r._id, r]))
}

export const listDailyStats = async () => {
  await connection()
  return (await collections()).dailyStats.find().sort({ trading_day: -1 }).toArray()
}

// ─── Fills ───────────────────────────────────────────────────────────────────

export type TradeRow = OrderFill & { rationale: string | null; report_id: string | null; agent_episode_id: string | null }

const loadFills = async (filter: Record<string, unknown> = {}): Promise<OrderFill[]> => {
  const { orders } = await collections()
  const docs = await orders.find({ ...FILLED_ORDERS, ...filter }).sort({ filled_at: 1 }).toArray()
  const parentIds = [...new Set(docs.map((d) => d.parent_id).filter((id): id is string => !!id))]
  const parents: OrderDoc[] = parentIds.length ? await orders.find({ _id: { $in: parentIds } }).toArray() : []
  return fillsFromOrders(docs, parents)
}

/** Attaches the decision rationale to each fill (exit legs inherit their entry's decision). */
const withRationale = async (fills: OrderFill[]): Promise<TradeRow[]> => {
  const { decisions } = await collections()
  const ids = [...new Set(fills.map((f) => f.decision_id).filter((id): id is string => !!id))]
  const docs = ids.length ? await decisions.find({ _id: { $in: ids } }, { projection: { "request.rationale": 1, report_id: 1, agent_episode_id: 1 } }).toArray() : []
  const byId = new Map(docs.map((d) => [d._id, d]))
  return fills.map((f) => {
    const d = f.decision_id ? byId.get(f.decision_id) : undefined
    return { ...f, rationale: d?.request.rationale ?? null, report_id: d?.report_id ?? null, agent_episode_id: d?.agent_episode_id ?? null }
  })
}

export const listTrades = async (limit = 300): Promise<TradeRow[]> => {
  await connection()
  return withRationale((await loadFills()).reverse().slice(0, limit))
}

export const getDay = async (day: string) => {
  await connection()
  const db = await collections()
  // The trading day in New York, midnight to midnight.
  const from = marketTime(day, "00:00")
  const to = marketTime(addDays(day, 1), "00:00")
  const [stats, episodes, decisions, fills] = await Promise.all([
    db.dailyStats.findOne({ _id: day }),
    getEpisodesBetween(from, to),
    db.decisions.find({ trading_day: day }).sort({ created_at: 1 }).toArray(),
    loadFills(),
  ])
  const [trades, decisionRows] = await Promise.all([withRationale(fills.filter((f) => marketDay(f.at) === day)), withTriggers(decisions)])
  return { stats, episodes, decisions: decisionRows, trades }
}

/** Days with any activity, newest first, merged with their stats. */
export const listDays = async () => {
  await connection()
  const db = await collections()
  const [stats, days] = await Promise.all([listDailyStats(), db.decisions.distinct("trading_day")])
  const byDay = new Map(stats.map((s) => [s.trading_day, s]))
  const all = [...new Set([...days, ...stats.map((s) => s.trading_day)])].sort().reverse()
  const counts = await db.decisions
    .aggregate<{ _id: string; total: number; executed: number }>([{ $group: { _id: "$trading_day", total: { $sum: 1 }, executed: { $sum: { $cond: [{ $eq: ["$status", "executed"] }, 1, 0] } } } }])
    .toArray()
  const countByDay = new Map(counts.map((c) => [c._id, c]))
  return all.map((day) => ({ day, stats: byDay.get(day) ?? null, decisions: countByDay.get(day) ?? { total: 0, executed: 0 } }))
}

// ─── Options ─────────────────────────────────────────────────────────────────

export const getOptionsPositions = async () => {
  await connection()
  const { optionPositions } = await collections()
  const [open, closed] = await Promise.all([
    optionPositions.find({ status: { $in: ["opening", "open", "closing"] } }).sort({ opened_at: -1 }).toArray(),
    optionPositions.find({ status: "closed" }).sort({ closed_at: -1 }).limit(200).toArray(),
  ])
  return { open, closed }
}

// ─── Symbols & charts ────────────────────────────────────────────────────────

export type ChartFill = Pick<TradeRow, "side" | "qty" | "price" | "role" | "realized_pnl"> & { t: number }

/** One price bar on an index axis (no overnight/weekend gaps), with any fills that happened during it. */
export type PriceRow = { i: number; t: number; c: number; buy: number | null; sell: number | null; fills: ChartFill[] }

export type PriceRange = { key: string; label: string; intraday: boolean; rows: PriceRow[] }

export const toRows = (bars: Bar[], fills: ChartFill[]): PriceRow[] => {
  const rows: PriceRow[] = bars.map((b, i) => ({ i, t: new Date(b.t).getTime(), c: b.c, buy: null, sell: null, fills: [] }))
  for (const fill of fills) {
    // The bar whose window contains the fill (bar start <= fill time < next bar start).
    const idx = rows.findLastIndex((r) => r.t <= fill.t)
    if (idx < 0 || (idx === rows.length - 1 && fill.t - rows[idx].t > 86_400_000)) continue
    const row = rows[idx]
    row.fills.push(fill)
    row[fill.side] = fill.price
  }
  return rows
}

export const getSymbolPage = async (symbol: string) => {
  await connection()
  const db = await collections()
  const [fills, decisions, plan, cached, chart, options] = await Promise.all([
    loadFills({ symbol }),
    db.decisions.find({ symbol }).sort({ created_at: -1 }).limit(200).toArray().then(withTriggers),
    db.plans.findOne({ _id: symbol }),
    readCache<AccountSnapshot>("alpaca:account"),
    readCache<ChartBars>(`chart:${symbol}`),
    db.optionPositions.find({ underlying: symbol }).sort({ opened_at: -1 }).limit(50).toArray(),
  ])
  const trades = await withRationale(fills)
  const position = cached?.data.positions.find((p) => p.symbol === symbol && (p.asset_class ?? "us_equity") === "us_equity") ?? null
  const chartFills: ChartFill[] = trades.map((t) => ({ t: t.at.getTime(), side: t.side, qty: t.qty, price: t.price, role: t.role, realized_pnl: t.realized_pnl }))
  const ranges = chart?.data.ranges
  const monthStart = Date.now() - 31 * 86_400_000
  const charts: PriceRange[] = [
    { key: "1D", label: "1D", intraday: true, rows: toRows(ranges?.["1D"] ?? [], chartFills) },
    { key: "1W", label: "1W", intraday: true, rows: toRows(ranges?.["1W"] ?? [], chartFills) },
    { key: "1M", label: "1M", intraday: false, rows: toRows((ranges?.["6M"] ?? []).filter((b) => new Date(b.t).getTime() >= monthStart), chartFills) },
    { key: "6M", label: "6M", intraday: false, rows: toRows(ranges?.["6M"] ?? [], chartFills) },
  ]
  return { trades: trades.reverse(), decisions, plan, position, charts, options }
}

export type SymbolSummary = { symbol: string; fills: number; closed: number; realized: number; wins: number; losses: number; last_at: Date }

/** Per-symbol results. Option fills count toward their underlying. */
export const summarizeBySymbol = (trades: TradeRow[]): SymbolSummary[] => {
  const map = new Map<string, SymbolSummary>()
  for (const t of trades) {
    const key = t.underlying ?? t.symbol
    const s = map.get(key) ?? { symbol: key, fills: 0, closed: 0, realized: 0, wins: 0, losses: 0, last_at: t.at }
    s.fills += 1
    if (t.realized_pnl !== null) {
      s.closed += 1
      s.realized += t.realized_pnl
      if (t.realized_pnl > 0) s.wins += 1
      if (t.realized_pnl < 0) s.losses += 1
    }
    if (t.at > s.last_at) s.last_at = t.at
    map.set(key, s)
  }
  return [...map.values()].sort((a, b) => b.realized - a.realized)
}

export type CumulativePoint = { i: number; t: number; symbol: string; pnl: number; cum: number }

/** Running total of realized P&L starting from $0, then one point per closing trade, oldest first. */
export const cumulativePnl = (trades: TradeRow[]): CumulativePoint[] => {
  const closed = trades.filter((t) => t.realized_pnl !== null).sort((a, b) => a.at.getTime() - b.at.getTime())
  if (closed.length === 0) return []
  let cum = 0
  return [
    { i: 0, t: closed[0].at.getTime(), symbol: "", pnl: 0, cum: 0 },
    ...closed.map((t, i) => {
      cum += t.realized_pnl!
      return { i: i + 1, t: t.at.getTime(), symbol: t.underlying ?? t.symbol, pnl: t.realized_pnl!, cum: Math.round(cum * 100) / 100 }
    }),
  ]
}

// ─── Strategies ──────────────────────────────────────────────────────────────

export const BOOKS = [
  { key: "day", label: "Day trades" },
  { key: "swing", label: "Swing holds" },
  { key: "options", label: "Options" },
] as const

export type Book = (typeof BOOKS)[number]["key"]

export type SetupTally = { entries: number; executed: number; closed: number; wins: number; losses: number; realized: number }

const emptyTally = (): SetupTally => ({ entries: 0, executed: 0, closed: 0, wins: 0, losses: 0, realized: 0 })

/** Counts entry decisions and the realized P&L of the positions they opened into tallies picked per decision. */
const tally = <D extends Pick<DecisionDoc, "_id" | "action" | "status">>(
  { fills, decisions, structures }: { fills: OrderFill[]; decisions: D[]; structures: { _id: string; decision_id: string | null }[] },
  tallies: (d: D) => SetupTally[],
) => {
  for (const d of decisions) {
    if (d.action !== "buy" && d.action !== "buy_option") continue
    for (const t of tallies(d)) {
      t.entries += 1
      if (d.status === "executed") t.executed += 1
    }
  }

  const byId = new Map(decisions.map((d) => [d._id, d]))
  const structureDecision = new Map(structures.map((s) => [s._id, s.decision_id]))
  const openedBy = new Map<string, string>()
  for (const f of fills) {
    let entry: string | null | undefined
    if (f.asset_class === "us_option") entry = f.structure_id ? structureDecision.get(f.structure_id) : null
    else {
      if (f.side === "buy" && f.decision_id) openedBy.set(f.symbol, f.decision_id)
      entry = openedBy.get(f.symbol)
    }
    const d = entry ? byId.get(entry) : undefined
    if (f.realized_pnl === null || !d) continue
    for (const t of tallies(d)) {
      t.closed += 1
      t.realized += f.realized_pnl
      if (f.realized_pnl > 0) t.wins += 1
      if (f.realized_pnl < 0) t.losses += 1
    }
  }
}

// ─── News engine ("wire") ────────────────────────────────────────────────────

/** What started a decision, for the analytics tables. Decisions from before it was recorded have no kind. */
const KIND_LABEL: Record<string, string> = { agent: "The agent", scheduled: "Schedule (before the agent)", price_move: "Price move (before the agent)", manual: "Owner (manual)", event: "News event (before the agent)", seed: "Seed buy", core: "Trend core (rules)", unrecorded: "Not recorded (older)" }

/** News-engine analytics: does acting on news pay, and how fast is it. */
export const getWireAnalytics = async () => {
  await connection()
  const db = await collections()
  const week = new Date(Date.now() - 7 * 86_400_000)
  const month = new Date(Date.now() - 30 * 86_400_000)
  const [fills, decisions, structures, activity] = await Promise.all([
    loadFills(),
    db.decisions.find({}, { projection: { action: 1, status: 1, checks: 1, created_at: 1, trigger_kind: 1, wire_item_ids: 1 } }).toArray(),
    db.optionPositions.find({}, { projection: { decision_id: 1 } }).toArray(),
    getWireActivity(),
  ])

  const ids = [...new Set(decisions.flatMap((d) => d.wire_item_ids ?? []))]
  const wired = ids.length ? await db.wireItems.find({ _id: { $in: ids } }, { projection: { category: 1, first_seen_at: 1 } }).toArray() : []
  const itemById = new Map(wired.map((i) => [i._id, i]))

  // Outcomes: entries and the realized P&L of the positions they opened, by what started them and by the news category behind them.
  const byKind = new Map<string, SetupTally>()
  const byCategory = new Map<string, SetupTally>()
  const slot = (map: Map<string, SetupTally>, key: string) => map.get(key) ?? map.set(key, emptyTally()).get(key)!
  tally({ fills, decisions, structures }, (d) => {
    const category = d.wire_item_ids?.length ? itemById.get(d.wire_item_ids[0])?.category : undefined
    return [slot(byKind, d.trigger_kind ?? "unrecorded"), ...(category ? [slot(byCategory, category)] : [])]
  })

  // Decisions on news: the agent's carry the items that woke it.
  const eventDecisions = decisions.filter((d) => (d.wire_item_ids?.length ?? 0) > 0)
  const weekDecisions = eventDecisions.filter((d) => d.created_at >= week)
  const filled = new Set(fills.flatMap((f) => (f.decision_id ? [f.decision_id] : [])))
  return {
    byKind: [...byKind].map(([kind, t]) => ({ kind, label: KIND_LABEL[kind] ?? kind, ...t })).sort((a, b) => b.entries - a.entries),
    byCategory: [...byCategory].map(([category, t]) => ({ category, ...t })).sort((a, b) => b.entries - a.entries),
    funnel: {
      items: activity.items,
      triggers: activity.triggers,
      decisions: weekDecisions.length,
      approved: weekDecisions.filter((d) => d.status !== "noop" && d.status !== "rejected" && d.checks?.length && d.checks.every((c) => c.ok)).length,
      filled: weekDecisions.filter((d) => filled.has(d._id)).length,
    },
    ...decisionLatency(
      eventDecisions.filter((d) => d.created_at >= month),
      (id) => itemById.get(id)?.first_seen_at,
    ),
  }
}
