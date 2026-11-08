import "server-only"
import type { DecisionDoc, EngineStatusDoc } from "@mb/crypto-core/db"
import { eventForViewer } from "@mb/crypto-core/events"
import { brierScore, calibrationTable, drawdownSeries, performanceMetrics, tradeStats } from "@mb/crypto-core/metrics"
import { ACCOUNT_ID } from "@mb/crypto-core/venues"
import { signEngineRequest } from "@mb/crypto-core/stream-token"
import { createEngineStatus, type EngineSummary as EngineSummaryOf } from "@mb/web-kit/engine-status"
import { createQueries, decisionLatency } from "@mb/web-kit/queries"
import { azureMonitorConfig } from "@mb/web-kit/azure"
import { databaseStorage } from "@mb/web-kit/storage"
import { connection } from "next/server"
import { getEpisodesBetween } from "./agent"
import { collections, mongoClient } from "./db"
import { env } from "./env"

/**
 * Read queries for the dashboard. Each awaits `connection()`, so pages render at request time
 * with live data (never prerendered at build). Only plain, serializable values leave this file.
 * The queries both dashboards share come from @mb/web-kit/queries; crypto's own follow.
 */

export type EngineSummary = EngineSummaryOf<EngineStatusDoc>

/** The engine's heartbeat, from the engine itself (@mb/web-kit/engine-status). */
export const getEngine = createEngineStatus<EngineStatusDoc>({ streamUrl: env.engineStreamUrl, url: env.engineUrl, secret: env.streamTokenSecret, sign: signEngineRequest })

export const {
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
} = createQueries({
  collections,
  eventForViewer,
  recentEventsFilter: { level: { $ne: "debug" } },
})

/** Admin → System: the cluster's storage, both bots' databases included, and Azure's count when configured (@mb/web-kit/storage). */
export const getDatabaseStorage = async () => {
  await connection()
  return databaseStorage(mongoClient(), azureMonitorConfig(env))
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

/**
 * Holding BTC instead, from `since` to now, %: Kraken's public daily candles (no key), cached for
 * an hour; from the close of the day the account started to the latest price. null when Kraken
 * doesn't answer.
 */
export const getBtcBenchmarkPct = async (since: Date): Promise<number | null> => {
  const day = Math.floor(since.getTime() / 86_400_000) * 86_400
  const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since=${day - 86_400}`, { next: { revalidate: 3_600 }, signal: AbortSignal.timeout(8_000) }).catch(() => null)
  if (!res?.ok) return null
  const body = (await res.json().catch(() => null)) as { error?: string[]; result?: Record<string, unknown> } | null
  const rows = body?.result ? Object.entries(body.result).find(([k]) => k !== "last")?.[1] : null
  if (!Array.isArray(rows)) return null
  const candles = rows as [number, string, string, string, string][]
  const start = candles.find((c) => c[0] === day)
  const end = candles.at(-1)
  if (!start || !end || !(Number(start[4]) > 0)) return null
  return (Number(end[4]) / Number(start[4]) - 1) * 100
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

export const getDecisions = async ({ limit = 100, symbol }: { limit?: number; symbol?: string } = {}) => {
  await connection()
  return (await collections()).decisions.find(symbol ? { symbol } : {}).sort({ created_at: -1 }).limit(limit).toArray()
}

export const getDecision = async (id: string) => {
  await connection()
  const { decisions, orders, fills } = await collections()
  const decision = await decisions.findOne({ _id: id })
  if (!decision) return null
  const [ord, fl] = await Promise.all([orders.find({ decision_id: id }).toArray(), fills.find({ decision_id: id }).sort({ at: 1 }).toArray()])
  // How the thesis is doing now: the position it opened, if any.
  const position = await (await collections()).positions.findOne({ decision_id: id })
  return { decision, orders: ord, fills: fl, position }
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

/** Everything that happened on one UTC day, oldest first: the agent's episodes, its decisions, fills and closed positions. */
export const getDay = async (day: string) => {
  await connection()
  const { dailyStats, decisions, fills, positions } = await collections()
  const range = dayRange(day)
  const [stats, episodes, decisionDocs, fillDocs, closed] = await Promise.all([
    dailyStats.findOne({ account_id: ACCOUNT_ID, day }),
    getEpisodesBetween(range.$gte, range.$lt),
    decisions.find({ created_at: range }).sort({ created_at: 1 }).toArray(),
    fills.find({ account_id: ACCOUNT_ID, at: range }).sort({ at: 1 }).toArray(),
    positions.find({ account_id: ACCOUNT_ID, status: "closed", closed_at: range }).sort({ closed_at: 1 }).toArray(),
  ])
  return { stats, episodes, decisions: decisionDocs, fills: fillDocs, closed }
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
    // The rules against the agent's judgment (and the positions from before either).
    byBook: [
      { key: "Long-term book (rules)", ...tradeStats(trades.filter((t) => t.strategy === "long_term")) },
      { key: "Trend core (rules)", ...tradeStats(trades.filter((t) => t.strategy === "core")) },
      { key: "Agent and earlier", ...tradeStats(trades.filter((t) => t.strategy !== "core" && t.strategy !== "long_term")) },
    ],
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

/** News-engine analytics: does acting on events pay, and how fast is it. */
export const getWireAnalytics = async () => {
  await connection()
  const { decisions, wireItems } = await collections()
  const week = new Date(Date.now() - 7 * 86_400_000)
  const month = new Date(Date.now() - 30 * 86_400_000)
  const [scored, activity, eventDecisions] = await Promise.all([
    decisions.find({ outcome: { $ne: null } }, { projection: { trigger_kind: 1, outcome: 1, wire_item_ids: 1 } }).toArray(),
    getWireActivity(),
    // The agent's decisions on news (they carry the items that woke it).
    decisions.find({ "wire_item_ids.0": { $exists: true }, created_at: { $gte: month } }, { projection: { created_at: 1, wire_item_ids: 1, risk: 1, execution: 1 } }).toArray(),
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
  return {
    byKind: [...byKind].map(([kind, list]) => ({ kind, ...rate(list) })),
    byCategory: [...byCategory].map(([category, list]) => ({ category, ...rate(list) })).sort((a, b) => b.decisions - a.decisions),
    funnel: {
      items: activity.items,
      triggers: activity.triggers,
      decisions: eventDecisions.filter((d) => d.created_at >= week).length,
      approved: eventDecisions.filter((d) => d.created_at >= week && d.risk?.approved).length,
      filled: eventDecisions.filter((d) => d.created_at >= week && (d.execution.status === "filled" || d.execution.status === "partial")).length,
    },
    ...decisionLatency(eventDecisions, (id) => itemById.get(id)?.first_seen_at),
  }
}
