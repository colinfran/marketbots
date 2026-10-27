import "server-only"
import type { DecisionDoc, EngineStatusDoc } from "@mb/crypto-core/db"
import type { WireItemDoc, WireTriggerDoc } from "@mb/crypto-core/wire"
import { eventForViewer, type EngineEvent } from "@mb/crypto-core/events"
import { brierScore, calibrationTable, drawdownSeries, performanceMetrics, tradeStats } from "@mb/crypto-core/metrics"
import { ACCOUNT_ID } from "@mb/crypto-core/venues"
import { connection } from "next/server"
import type { TriggerView, WireRowView } from "@/components/wire"
import type { Viewer } from "./auth"
import { collections } from "./db"

/**
 * Read queries for the dashboard. Each awaits `connection()`, so pages render at request time
 * with live data (never prerendered at build). Only plain, serializable values leave this file.
 */

/** The engine counts as online if its heartbeat is fresher than this. */
const HEARTBEAT_STALE_MS = 30_000

export type EngineSummary = { status: EngineStatusDoc | null; online: boolean; heartbeatAgeS: number | null }

export const getEngine = async (): Promise<EngineSummary> => {
  await connection()
  const { engineStatus } = await collections()
  const status = await engineStatus.findOne({ _id: "engine" })
  const age = status ? (Date.now() - status.at.getTime()) / 1000 : null
  return { status, online: age !== null && age * 1000 < HEARTBEAT_STALE_MS, heartbeatAgeS: age === null ? null : Math.round(age) }
}

export const getEngineState = async () => {
  await connection()
  return (await collections()).engineState.findOne({ _id: "engine" })
}

export const getAccount = async () => {
  await connection()
  const { accounts, positions } = await collections()
  const [account, open] = await Promise.all([accounts.findOne({ _id: ACCOUNT_ID }), positions.find({ account_id: ACCOUNT_ID, status: "open" }).sort({ opened_at: -1 }).toArray()])
  if (!account) return null
  const invested = open.reduce((s, p) => s + p.cost_basis_usd, 0)
  const marketValue = open.reduce((s, p) => s + p.qty * (p.mark_price ?? p.avg_price), 0)
  return {
    account,
    positions: open,
    invested,
    marketValue,
    unrealized: marketValue - invested,
    dayPnl: account.equity_usd - account.day_start_equity_usd,
    dayPnlPct: account.day_start_equity_usd > 0 ? (account.equity_usd / account.day_start_equity_usd - 1) * 100 : null,
    totalPnl: account.equity_usd - account.starting_usd,
    totalReturnPct: account.starting_usd > 0 ? (account.equity_usd / account.starting_usd - 1) * 100 : null,
    drawdownPct: account.peak_equity_usd > 0 ? (account.equity_usd / account.peak_equity_usd - 1) * 100 : null,
  }
}

export const getEquitySeries = async (days = 30) => {
  await connection()
  const { snapshots } = await collections()
  const since = new Date(Date.now() - days * 86_400_000)
  const docs = await snapshots.find({ account_id: ACCOUNT_ID, at: { $gte: since } }, { projection: { at: 1, equity_usd: 1 } }).sort({ at: 1 }).toArray()
  const stride = Math.max(1, Math.ceil(docs.length / 1_500))
  return docs.filter((_, i) => i % stride === 0 || i === docs.length - 1).map((d) => ({ t: d.at.getTime(), equity: d.equity_usd }))
}

export const getDailyStats = async (limit = 90) => {
  await connection()
  return (await collections()).dailyStats.find({ account_id: ACCOUNT_ID }).sort({ day: -1 }).limit(limit).toArray()
}

export const getClosedPositions = async (limit = 100) => {
  await connection()
  return (await collections()).positions.find({ account_id: ACCOUNT_ID, status: "closed" }).sort({ closed_at: -1 }).limit(limit).toArray()
}

/** Realized results over every closed position, after fees (the trades page summary). */
export const getRealizedSummary = async () => {
  await connection()
  const { positions, fills } = await collections()
  const [closed, fillCount] = await Promise.all([
    positions.find({ account_id: ACCOUNT_ID, status: "closed", exit_reason: { $nin: ["paper_reset"] } }, { projection: { realized_pnl_usd: 1 } }).toArray(),
    fills.countDocuments({ account_id: ACCOUNT_ID }),
  ])
  const pnl = closed.map((p) => p.realized_pnl_usd)
  const wins = pnl.filter((x) => x > 0)
  const losses = pnl.filter((x) => x < 0)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  return { realized: pnl.reduce((a, b) => a + b, 0), trades: pnl.length, fills: fillCount, wins: wins.length, losses: losses.length, avgWin: avg(wins), avgLoss: avg(losses) }
}

export const getOrders = async (limit = 100, symbol?: string) => {
  await connection()
  return (await collections()).orders.find({ account_id: ACCOUNT_ID, ...(symbol ? { symbol } : {}) }).sort({ created_at: -1 }).limit(limit).toArray()
}

export const getFills = async (limit = 200, symbol?: string) => {
  await connection()
  return (await collections()).fills.find({ account_id: ACCOUNT_ID, ...(symbol ? { symbol } : {}) }).sort({ at: -1 }).limit(limit).toArray()
}

export const getCycles = async (limit = 50) => {
  await connection()
  return (await collections()).cycles.find({}, { projection: { steps: 0 } }).sort({ started_at: -1 }).limit(limit).toArray()
}

export const getCycle = async (id: string) => {
  await connection()
  const { cycles, research, decisions } = await collections()
  const cycle = await cycles.findOne({ _id: id })
  if (!cycle) return null
  const [memo, items] = await Promise.all([
    cycle.research_id ? research.findOne({ _id: cycle.research_id }) : null,
    decisions.find({ cycle_id: id }).sort({ created_at: 1 }).toArray(),
  ])
  return { cycle, research: memo, decisions: items }
}

/** The newest cycle that reached the AI, with its research subjects and decisions (the "latest research" card). */
export const getLatestAiCycle = async () => {
  await connection()
  const { cycles, research, decisions } = await collections()
  const cycle = await cycles.find({ "decision_ids.0": { $exists: true } }, { projection: { steps: 0, candidates: 0 } }).sort({ started_at: -1 }).limit(1).next()
  if (!cycle) return null
  const [memo, items] = await Promise.all([
    cycle.research_id ? research.findOne({ _id: cycle.research_id }, { projection: { subjects: 1, sources: 1, error: 1 } }) : null,
    decisions.find({ cycle_id: cycle._id }, { projection: { symbol: 1, action: 1, "ai.conviction": 1, "execution.status": 1 } }).sort({ created_at: 1 }).toArray(),
  ])
  return { cycle, research: memo, decisions: items }
}

export const getDecisions = async ({ limit = 100, symbol }: { limit?: number; symbol?: string } = {}) => {
  await connection()
  return (await collections()).decisions.find(symbol ? { symbol } : {}).sort({ created_at: -1 }).limit(limit).toArray()
}

export const getDecision = async (id: string) => {
  await connection()
  const { decisions, orders, fills, research } = await collections()
  const decision = await decisions.findOne({ _id: id })
  if (!decision) return null
  const [ord, fl, memo] = await Promise.all([
    orders.find({ decision_id: id }).toArray(),
    fills.find({ decision_id: id }).sort({ at: 1 }).toArray(),
    decision.research_id ? research.findOne({ _id: decision.research_id }, { projection: { memo: 1, sources: 1, model: 1, error: 1 } }) : null,
  ])
  // How the thesis is doing now: the position it opened, if any.
  const position = await (await collections()).positions.findOne({ decision_id: id })
  return { decision, orders: ord, fills: fl, research: memo, position }
}

export const getSettings = async () => {
  await connection()
  return (await collections()).settings.findOne({ _id: "current" })
}

/** One UTC day as a Mongo date range. */
const dayRange = (day: string) => {
  const start = new Date(`${day}T00:00:00.000Z`)
  return { $gte: start, $lt: new Date(start.getTime() + 86_400_000) }
}

/**
 * UTC days with activity, newest first, merged with their stats (the journal). The engine writes a
 * day's stats when it closes, so today has none yet.
 */
export const getDays = async (limit = 180) => {
  await connection()
  const { dailyStats, decisions } = await collections()
  const [stats, counts] = await Promise.all([
    dailyStats.find({ account_id: ACCOUNT_ID }).sort({ day: -1 }).limit(limit).toArray(),
    decisions
      .aggregate<{ _id: string; total: number; executed: number }>([
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } }, total: { $sum: 1 }, executed: { $sum: { $cond: [{ $in: ["$execution.status", ["filled", "partial"]] }, 1, 0] } } } },
        { $sort: { _id: -1 } },
        { $limit: limit },
      ])
      .toArray(),
  ])
  const byDay = new Map(stats.map((s) => [s.day, s]))
  const countByDay = new Map(counts.map((c) => [c._id, c]))
  const today = new Date().toISOString().slice(0, 10)
  const all = [...new Set([today, ...stats.map((s) => s.day), ...counts.map((c) => c._id)])].sort().reverse().slice(0, limit)
  return all.map((day) => ({ day, stats: byDay.get(day) ?? null, decisions: countByDay.get(day) ?? { total: 0, executed: 0 } }))
}

/** Everything that happened on one UTC day, oldest first. Only cycles that reached the AI are listed. */
export const getDay = async (day: string) => {
  await connection()
  const { dailyStats, cycles, decisions, fills, positions } = await collections()
  const range = dayRange(day)
  const [stats, research, decisionDocs, fillDocs, closed] = await Promise.all([
    dailyStats.findOne({ account_id: ACCOUNT_ID, day }),
    cycles.find({ started_at: range, "decision_ids.0": { $exists: true } }, { projection: { steps: 0 } }).sort({ started_at: 1 }).toArray(),
    decisions.find({ created_at: range }).sort({ created_at: 1 }).toArray(),
    fills.find({ account_id: ACCOUNT_ID, at: range }).sort({ at: 1 }).toArray(),
    positions.find({ account_id: ACCOUNT_ID, status: "closed", closed_at: range }).sort({ closed_at: 1 }).toArray(),
  ])
  return { stats, cycles: research, decisions: decisionDocs, fills: fillDocs, closed }
}

export const getAudit = async (limit = 100) => {
  await connection()
  return (await collections()).audit.find({}).sort({ at: -1 }).limit(limit).toArray()
}

export const getCommands = async (limit = 30) => {
  await connection()
  return (await collections()).commands.find({}).sort({ created_at: -1 }).limit(limit).toArray()
}

/** One-time seed runs, newest first (the Admin card shows the current or last one). */
export const getSeedRuns = async (limit = 5) => {
  await connection()
  return (await collections()).seedRuns.find({}).sort({ created_at: -1 }).limit(limit).toArray()
}

export const getNotifications = async (limit = 30) => {
  await connection()
  return (await collections()).notifications.find({}).sort({ at: -1 }).limit(limit).toArray()
}

/**
 * Recent persisted events, filtered for the viewer (initial history for the activity feed). Idle
 * cycles end with a debug-level cycle.completed; it's included so live views know the cycle is over.
 */
export const getRecentEvents = async (viewer: Viewer, { limit = 80, levels }: { limit?: number; levels?: EngineEvent["level"][] } = {}): Promise<EngineEvent[]> => {
  await connection()
  const { events } = await collections()
  const docs = await events.find(levels ? { level: { $in: levels } } : { $or: [{ level: { $ne: "debug" } }, { type: "cycle.completed" }] }).sort({ _id: -1 }).limit(limit).toArray()
  return docs
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ _id, expires_at, ...e }) => eventForViewer(e as EngineEvent, viewer.owner ? "owner" : "public"))
    .filter((e): e is EngineEvent => e !== null)
}

/** Every stored event of one cycle, oldest first (the live cycle trail). */
export const getCycleEvents = async (cycleId: string, viewer: Viewer): Promise<EngineEvent[]> => {
  await connection()
  const docs = await (await collections()).events.find({ cycle_id: cycleId }).sort({ _id: 1 }).limit(2_000).toArray()
  return docs
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    .map(({ _id, expires_at, ...e }) => eventForViewer(e as EngineEvent, viewer.owner ? "owner" : "public"))
    .filter((e): e is EngineEvent => e !== null)
}

export const getBacktests = async (limit = 20) => {
  await connection()
  return (await collections()).backtests.find({}, { projection: { trades: 0 } }).sort({ created_at: -1 }).limit(limit).toArray()
}

export const getBacktest = async (id: string) => {
  await connection()
  return (await collections()).backtests.findOne({ _id: id })
}

export const getAiCosts = async (days = 30) => {
  await connection()
  const { aiCalls } = await collections()
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  return aiCalls
    .aggregate<{ _id: string; cost: number; calls: number; failures: number }>([
      { $match: { day: { $gte: since } } },
      { $group: { _id: "$day", cost: { $sum: "$cost_usd" }, calls: { $sum: 1 }, failures: { $sum: { $cond: ["$ok", 0, 1] } } } },
      { $sort: { _id: 1 } },
    ])
    .toArray()
}

/**
 * Performance and AI-quality analytics, all from stored records:
 * - realized trade stats overall and by strategy (closed positions, after fees);
 * - risk metrics from the equity snapshots;
 * - decision quality: hit rate by action, AI vs the no-AI screen baseline, and calibration of
 *   the AI's "target before stop" probability against what actually happened.
 */
export const getAnalytics = async () => {
  await connection()
  const { positions, decisions, snapshots, fills } = await collections()
  const [closed, scored, curve, entryCosts] = await Promise.all([
    positions.find({ account_id: ACCOUNT_ID, status: "closed", exit_reason: { $nin: ["paper_reset"] } }, { projection: { strategy_id: 1, realized_pnl_usd: 1, opened_at: 1, closed_at: 1, symbol: 1 } }).toArray(),
    decisions.find({ outcome: { $ne: null } }, { projection: { action: 1, strategy_id: 1, outcome: 1, ai: 1, ev: 1, quant: 1, model: 1, prompt_version: 1, held: 1, execution: 1 } }).toArray(),
    snapshots.find({ account_id: ACCOUNT_ID, at: { $gte: new Date(Date.now() - 365 * 86_400_000) } }, { projection: { at: 1, equity_usd: 1, exposure_usd: 1 } }).sort({ at: 1 }).toArray(),
    // Everything paid to build each position (price × qty + fees), the base for its return.
    fills
      .aggregate<{ _id: string; cost: number }>([
        { $match: { account_id: ACCOUNT_ID, side: "buy", position_id: { $ne: null } } },
        { $group: { _id: "$position_id", cost: { $sum: { $add: [{ $multiply: ["$qty", "$price"] }, "$fee_usd"] } } } },
      ])
      .toArray(),
  ])

  const costOf = new Map(entryCosts.map((c) => [c._id, c.cost]))
  const trades = closed.map((p) => {
    const cost = costOf.get(p._id) ?? 0
    return { pnl_usd: p.realized_pnl_usd, return_pct: cost > 0 ? (p.realized_pnl_usd / cost) * 100 : 0, strategy: p.strategy_id ?? "unknown", symbol: p.symbol }
  })
  const byKey = (key: (t: (typeof trades)[number]) => string) => {
    const groups = new Map<string, typeof trades>()
    for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t])
    return [...groups].map(([k, v]) => ({ key: k, ...tradeStats(v) })).sort((a, b) => b.total_pnl_usd - a.total_pnl_usd)
  }
  const points = curve.map((s) => ({ t: s.at.getTime(), equity: s.equity_usd }))
  const exposure = curve.length ? (curve.filter((s) => s.exposure_usd > 1).length / curve.length) * 100 : null

  const judge = (list: DecisionDoc[]) => {
    const judged = list.filter((d) => d.outcome?.correct !== null && d.outcome?.correct !== undefined)
    return { n: list.length, judged: judged.length, correct: judged.filter((d) => d.outcome!.correct).length }
  }
  const actions = ["buy", "no_trade", "hold", "reduce", "close"] as const
  const byAction = actions.map((a) => ({ action: a, ...judge(scored.filter((d) => d.action === a)) }))
  // AI vs baseline on screened candidates: the screen alone would have bought every one.
  const candidates = scored.filter((d) => d.quant.baseline_action === "buy" && d.outcome?.forward_return_pct !== null && d.outcome?.forward_return_pct !== undefined)
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const aiBought = candidates.filter((d) => d.action === "buy")
  const aiSkipped = candidates.filter((d) => d.action !== "buy")
  const forecasts = scored
    .filter((d) => d.action === "buy" && d.ai.p_target_first !== null && (d.outcome?.hit === "target" || d.outcome?.hit === "stop"))
    .map((d) => ({ p: d.ai.p_target_first!, pAdj: d.ev.p_adjusted, pPrior: d.ev.p_prior, outcome: (d.outcome!.hit === "target" ? 1 : 0) as 0 | 1 }))
  const byModel = new Map<string, DecisionDoc[]>()
  for (const d of scored) byModel.set(`${d.model} · ${d.prompt_version}`, [...(byModel.get(`${d.model} · ${d.prompt_version}`) ?? []), d])

  return {
    trades: tradeStats(trades),
    byStrategy: byKey((t) => t.strategy),
    bySymbol: byKey((t) => t.symbol),
    risk: performanceMetrics(points, [], { exposure_pct: exposure }),
    drawdown: drawdownSeries(points).filter((_, i, arr) => i % Math.max(1, Math.ceil(arr.length / 1_500)) === 0),
    decisions: {
      scored: scored.length,
      byAction,
      baseline: {
        candidates: candidates.length,
        screenAvgReturnPct: avg(candidates.map((d) => d.outcome!.forward_return_pct!)),
        aiBoughtAvgReturnPct: avg(aiBought.map((d) => d.outcome!.forward_return_pct!)),
        aiSkippedAvgReturnPct: avg(aiSkipped.map((d) => d.outcome!.forward_return_pct!)),
        aiBought: aiBought.length,
        aiSkipped: aiSkipped.length,
      },
      calibration: {
        n: forecasts.length,
        brierAi: brierScore(forecasts.map((f) => ({ p: f.p, outcome: f.outcome }))),
        brierAdjusted: brierScore(forecasts.filter((f) => f.pAdj !== null).map((f) => ({ p: f.pAdj!, outcome: f.outcome }))),
        brierPrior: brierScore(forecasts.filter((f) => f.pPrior !== null).map((f) => ({ p: f.pPrior!, outcome: f.outcome }))),
        table: calibrationTable(forecasts.map((f) => ({ p: f.p, outcome: f.outcome }))),
      },
      byModel: [...byModel].map(([key, list]) => ({ key, ...judge(list) })),
    },
  }
}

/** Recent research that covered a symbol, newest first (memo excerpt and sources). */
export const getResearchFor = async (symbol: string, limit = 5) => {
  await connection()
  return (await collections()).research
    .find({ subjects: symbol }, { projection: { memo: 1, sources: 1, started_at: 1, cycle_id: 1, model: 1, error: 1 } })
    .sort({ started_at: -1 })
    .limit(limit)
    .toArray()
}

/** Latest decision per symbol (for the market board). */
export const getLatestDecisions = async () => {
  await connection()
  const rows = await (await collections()).decisions
    .aggregate<{ _id: string; action: string; at: Date; conviction: number; id: string }>([
      { $sort: { created_at: -1 } },
      { $group: { _id: "$symbol", action: { $first: "$action" }, at: { $first: "$created_at" }, conviction: { $first: "$ai.conviction" }, id: { $first: "$_id" } } },
    ])
    .toArray()
  return Object.fromEntries(rows.map((r) => [r._id, r]))
}

// ─── News engine ("wire") ────────────────────────────────────────────────────

const toRowView = (i: WireItemDoc): WireRowView => ({
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

const ITEM_PROJECTION = { summary: 0, severity_parts: 0, meta: 0, confirmations: 0 } as const

export type WireFilter = { symbol?: string; category?: string; minSeverity?: number; source?: string; hours?: number; limit?: number }

/** Items our feeds stored, newest first (cluster roots only: copies are confirmations on them). */
export const getWireItems = async ({ symbol, category, minSeverity, source, hours = 72, limit = 100 }: WireFilter = {}) => {
  await connection()
  const filter: Record<string, unknown> = { first_seen_at: { $gte: new Date(Date.now() - hours * 3_600_000) } }
  if (symbol) filter.symbols = symbol
  if (category) filter.category = category
  if (source) filter.source = source
  if (minSeverity) filter.severity = { $gte: minSeverity }
  const docs = await (await collections()).wireItems.find(filter, { projection: ITEM_PROJECTION }).sort({ first_seen_at: -1 }).limit(limit).toArray()
  return docs.filter((d) => d.cluster_id === d._id).map(toRowView)
}

/** What the Live page may show: items the engine marked notable in the last `hours`. */
export const getNotableItems = async (hours = 6, limit = 10) => {
  await connection()
  const docs = await (await collections()).wireItems.find({ notable: true, first_seen_at: { $gte: new Date(Date.now() - hours * 3_600_000) } }, { projection: ITEM_PROJECTION }).sort({ first_seen_at: -1 }).limit(limit).toArray()
  return docs.map(toRowView)
}

/** Categories and sources seen recently, for the filters. */
export const getWireFacets = async (hours = 72) => {
  await connection()
  const { wireItems } = await collections()
  const since = { first_seen_at: { $gte: new Date(Date.now() - hours * 3_600_000) } }
  const [categories, sources] = await Promise.all([wireItems.distinct("category", since), wireItems.distinct("source", since)])
  return { categories: categories.sort(), sources: sources.sort() }
}

const toTriggerView = (t: WireTriggerDoc, titles: Map<string, string>): TriggerView => ({
  id: t._id,
  at: t.at.toISOString(),
  rule: t.rule,
  action: t.action,
  status: t.status,
  reason: t.reason,
  symbols: t.symbols,
  severity: t.severity,
  cycle_id: t.cycle_id,
  item_title: titles.get(t.item_ids[0] ?? "") ?? null,
})

const withTitles = async (triggers: WireTriggerDoc[]) => {
  const ids = [...new Set(triggers.flatMap((t) => t.item_ids))]
  const items = ids.length ? await (await collections()).wireItems.find({ _id: { $in: ids } }, { projection: { title: 1 } }).toArray() : []
  const titles = new Map(items.map((i) => [i._id, i.title]))
  return triggers.map((t) => toTriggerView(t, titles))
}

export const getWireTriggers = async (limit = 40) => {
  await connection()
  return withTitles(await (await collections()).wireTriggers.find({}).sort({ at: -1 }).limit(limit).toArray())
}

/** A cycle's wire context: what started it (event cycles) and the dossier the AI was given. */
export const getWireForCycle = async (cycleId: string) => {
  await connection()
  const { cycles, research, wireTriggers, wireItems } = await collections()
  const [cycle, memo] = await Promise.all([cycles.findOne({ _id: cycleId }, { projection: { kind: 1, wire_trigger_id: 1, wire_item_ids: 1, research_skip_reason: 1 } }), research.findOne({ cycle_id: cycleId }, { projection: { mode: 1, dossier: 1 } })])
  const trigger = cycle?.wire_trigger_id ? await wireTriggers.findOne({ _id: cycle.wire_trigger_id }) : null
  const items = cycle?.wire_item_ids?.length ? (await wireItems.find({ _id: { $in: cycle.wire_item_ids } }, { projection: ITEM_PROJECTION }).toArray()).map(toRowView) : []
  return {
    kind: cycle?.kind ?? null,
    trigger: trigger ? (await withTitles([trigger]))[0] : null,
    items,
    dossier: memo?.dossier ?? [],
    mode: memo?.mode ?? null,
    skipReason: cycle?.research_skip_reason ?? null,
  }
}

/** Items by id (decision pages' "Triggered by"). */
export const getWireItemsById = async (ids: string[]) => {
  await connection()
  if (!ids.length) return []
  return (await (await collections()).wireItems.find({ _id: { $in: ids } }, { projection: ITEM_PROJECTION }).toArray()).map(toRowView)
}

/** News-engine analytics: does acting on events pay, how fast is it, and what does research cost now. */
export const getWireAnalytics = async () => {
  await connection()
  const { decisions, wireItems, wireTriggers, cycles, aiCalls } = await collections()
  const week = new Date(Date.now() - 7 * 86_400_000)
  const month = new Date(Date.now() - 30 * 86_400_000)
  const [scored, items, triggers, eventCycles, eventDecisions, calls] = await Promise.all([
    decisions.find({ outcome: { $ne: null } }, { projection: { trigger_kind: 1, outcome: 1, wire_item_ids: 1 } }).toArray(),
    wireItems.countDocuments({ first_seen_at: { $gte: week } }),
    wireTriggers.countDocuments({ at: { $gte: week }, status: { $in: ["fired", "queued"] } }),
    cycles.countDocuments({ kind: "event", started_at: { $gte: week } }),
    decisions.find({ trigger_kind: "event", created_at: { $gte: month } }, { projection: { created_at: 1, wire_item_ids: 1, risk: 1, execution: 1 } }).toArray(),
    aiCalls
      .aggregate<{ _id: { day: string; task: string }; cost: number }>([{ $match: { at: { $gte: new Date(Date.now() - 14 * 86_400_000) } } }, { $group: { _id: { day: "$day", task: "$task" }, cost: { $sum: "$cost_usd" } } }])
      .toArray(),
  ])
  const rate = (list: { outcome: DecisionDoc["outcome"] }[]) => {
    const judged = list.filter((d) => d.outcome?.correct === true || d.outcome?.correct === false)
    return { decisions: list.length, judged: judged.length, correct_pct: judged.length ? Math.round((judged.filter((d) => d.outcome!.correct).length / judged.length) * 100) : null }
  }
  const byKind = new Map<string, typeof scored>()
  for (const d of scored) byKind.set(d.trigger_kind ?? "scheduled", [...(byKind.get(d.trigger_kind ?? "scheduled") ?? []), d])

  const ids = [...new Set([...scored, ...eventDecisions].flatMap((d) => d.wire_item_ids ?? []))]
  const wired = ids.length ? await wireItems.find({ _id: { $in: ids } }, { projection: { category: 1, first_seen_at: 1 } }).toArray() : []
  const itemById = new Map(wired.map((i) => [i._id, i]))
  const byCategory = new Map<string, typeof scored>()
  for (const d of scored) {
    const cat = d.wire_item_ids?.length ? itemById.get(d.wire_item_ids[0])?.category : undefined
    if (cat) byCategory.set(cat, [...(byCategory.get(cat) ?? []), d])
  }
  const latencies = eventDecisions
    .map((d) => {
      const seen = (d.wire_item_ids ?? []).map((id) => itemById.get(id)?.first_seen_at.getTime()).filter((t): t is number => typeof t === "number")
      return seen.length ? (d.created_at.getTime() - Math.min(...seen)) / 1000 : null
    })
    .filter((s): s is number => s !== null)
    .sort((a, b) => a - b)
  const days = [...new Set(calls.map((c) => c._id.day))].sort()
  return {
    byKind: [...byKind].map(([kind, list]) => ({ kind, ...rate(list) })),
    byCategory: [...byCategory].map(([category, list]) => ({ category, ...rate(list) })).sort((a, b) => b.decisions - a.decisions),
    funnel: {
      items,
      triggers,
      eventCycles,
      decisions: eventDecisions.filter((d) => d.created_at >= week).length,
      approved: eventDecisions.filter((d) => d.created_at >= week && d.risk?.approved).length,
      filled: eventDecisions.filter((d) => d.created_at >= week && (d.execution.status === "filled" || d.execution.status === "partial")).length,
    },
    medianLatencyS: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    latencySamples: latencies.length,
    researchSpend: days.map((day) => ({
      day,
      research: calls.filter((c) => c._id.day === day && c._id.task === "research").reduce((s, c) => s + c.cost, 0),
      gap: calls.filter((c) => c._id.day === day && c._id.task === "research_gap").reduce((s, c) => s + c.cost, 0),
      decision: calls.filter((c) => c._id.day === day && c._id.task === "decision").reduce((s, c) => s + c.cost, 0),
    })),
  }
}
