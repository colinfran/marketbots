import { checkEntry, type EnvelopeHistory } from "@mb/agent/envelope"
import { newsWoke } from "@mb/agent/observations"
import type { EpisodeInfo } from "@mb/agent/runtime"
import type { AgentAction, BookAccount } from "@mb/core/agent"
import { normalizeCryptoAgentDecisions, type CryptoAgentAnswer, type NormalizedCryptoAgentDecision } from "@mb/crypto-core/agent"
import type { DecisionDoc, PositionDoc } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { cleanLine } from "@mb/engine-kit/util/text"
import { loadFeatures, processDecision } from "../orchestrator/decide"
import { correlationMatrix } from "../risk/correlation"
import type { AccountState } from "../risk/engine"
import { boundedStop, candidateFeatures, type CryptoCandidate } from "../strategies/types"
import { agentStop, limitsText, mid, price, type CryptoAgentDeps } from "./book"
import { CRYPTO_AGENT_PROMPT_VERSION } from "./prompts"

/**
 * The crypto agent's decisions into the paper account (docs/plans/LOCAL-AI.md §8.4, §9), through the
 * bot's execution path (`processDecision`: the risk engine, the executor, the ledger, a
 * `decisions` record scored like any other). Before that, the envelope: an entry must pass
 * its rate limits; its size is the risk engine's, from its stop and conviction. Exits and stops
 * obey only the risk engine's minimum hold.
 *
 * The positions it inherited from the bot's earlier designs are its to manage; the envelope's
 * open-position limit counts only the ones it opened.
 */

const HOUR = 3_600_000
const LOOKBACK_MS = 7 * 24 * HOUR

const ORDER: Record<NormalizedCryptoAgentDecision["action"], number> = { close: 0, reduce: 1, hold: 2, buy: 3, no_trade: 4 }

const action = (d: NormalizedCryptoAgentDecision, outcome: AgentAction["outcome"], detail: string | null): AgentAction => ({ symbol: d.symbol, action: d.action, conviction: d.conviction, outcome, detail })

/** What the envelope needs from the paper account: the agent's own entries and actions (its decisions), every exit and every stop-out. */
export const liveEnvelopeHistory = async (d: Pick<CryptoAgentDeps, "ctx">, now = Date.now()): Promise<EnvelopeHistory> => {
  const since = new Date(now - LOOKBACK_MS)
  const [decisions, closed, open] = await Promise.all([
    d.ctx.col.decisions
      .find({ agent_episode_id: { $exists: true }, created_at: { $gte: since }, action: { $in: ["buy", "reduce", "close"] }, "execution.filled_qty": { $gt: 0 } }, { projection: { symbol: 1, action: 1, created_at: 1, execution: 1 } })
      .sort({ created_at: 1 })
      .toArray(),
    d.ctx.col.positions.find({ status: "closed", closed_at: { $gte: since } }, { projection: { symbol: 1, closed_at: 1, exit_reason: 1 } }).toArray(),
    d.ctx.ledger.openPositions(),
  ])
  const opened = open.map((p) => p.decision_id).filter((id): id is string => !!id)
  const openPositions = opened.length ? await d.ctx.col.decisions.countDocuments({ _id: { $in: opened }, agent_episode_id: { $exists: true } }) : 0
  const lastAction = new Map<string, number>()
  const entries: EnvelopeHistory["entries"] = []
  for (const x of decisions) {
    const at = x.created_at.getTime()
    lastAction.set(x.symbol, at)
    if (x.action === "buy" && now - at < 24 * HOUR) entries.push({ symbol: x.symbol, at })
  }
  const lastExit = new Map<string, number>()
  const lastStopOut = new Map<string, number>()
  for (const p of closed.sort((a, b) => (a.closed_at?.getTime() ?? 0) - (b.closed_at?.getTime() ?? 0))) {
    const at = p.closed_at?.getTime() ?? 0
    lastExit.set(p.symbol, at)
    if (p.exit_reason === "stop_loss") lastStopOut.set(p.symbol, at)
  }
  return { openPositions, entries, lastAction, lastExit, lastStopOut }
}

/** The paper account as the risk engine sees it, with the envelope's history and the open positions. */
export const liveRiskState = async (d: Pick<CryptoAgentDeps, "ctx">, now = Date.now()): Promise<{ state: AccountState | null; history: EnvelopeHistory; open: PositionDoc[] }> => {
  const [state, open, history] = await Promise.all([d.ctx.ledger.riskState(now), d.ctx.ledger.openPositions(), liveEnvelopeHistory(d, now)])
  return { state, history, open }
}

/** The paper account, summarized for the heartbeat and the breakers. */
export const liveAccount = async (d: Pick<CryptoAgentDeps, "ctx">): Promise<{ account: BookAccount; dayPnlPct: number } | null> => {
  const [a, open, closed] = await Promise.all([d.ctx.ledger.account(), d.ctx.ledger.openPositions(), d.ctx.col.positions.countDocuments({ status: "closed" })])
  if (!a) return null
  const unrealized = open.reduce((s, p) => s + p.qty * (mid(d.ctx)(p.symbol) ?? p.mark_price ?? p.avg_price) - p.cost_basis_usd, 0)
  return {
    account: {
      starting_usd: a.starting_usd,
      cash_usd: roundTo(a.cash_usd, 2),
      equity_usd: roundTo(a.equity_usd, 2),
      exposure_usd: roundTo(a.exposure_usd, 2),
      realized_pnl_usd: roundTo(a.realized_pnl_usd, 2),
      unrealized_pnl_usd: roundTo(unrealized, 2),
      return_pct: a.starting_usd > 0 ? roundTo((a.equity_usd / a.starting_usd - 1) * 100, 2) : 0,
      open_positions: open.length,
      closed_positions: closed,
    },
    dayPnlPct: a.day_start_equity_usd > 0 ? (a.equity_usd / a.day_start_equity_usd - 1) * 100 : 0,
  }
}

/** YOUR BOOK and LIMITS for the paper account: the brief's account part, also the `book` tool's answer. */
export const liveBookText = async (d: Pick<CryptoAgentDeps, "ctx">, now = new Date()) => {
  const [{ state, history, open }, a] = await Promise.all([liveRiskState(d, now.getTime()), d.ctx.ledger.account()])
  const lines = open.map((p) => {
    const m = mid(d.ctx)(p.symbol)
    const pnl = m ? ((m / p.avg_price - 1) * 100).toFixed(2) : "n/a"
    const hours = ((now.getTime() - p.opened_at.getTime()) / HOUR).toFixed(1)
    return `- ${p.symbol}: ${p.qty} at ${price(d, p.symbol, p.avg_price)}, now ${price(d, p.symbol, m)} (${pnl}%), stop ${price(d, p.symbol, p.stop_price)}, target ${price(d, p.symbol, p.take_profit_price)}, held ${hours} h of an expected ${p.horizon_hours ?? "?"} h, ${p.strategy_id === "core" ? "TREND CORE (rules-managed: its stop trails and a broken trend closes it; close it yourself only on news that breaks the trend)" : p.strategy_id === "long_term" ? "LONG-TERM BOOK (rules-managed: held until a week closes below its 200-day average; close it yourself only on news that breaks the long-term case)" : (p.strategy_id ?? "no strategy")}. Thesis: ${p.thesis ?? "none recorded"} Invalidation: ${p.invalidation ?? "none recorded"}`
  })
  const gate = d.ctx.gate()
  const blocked = [
    gate.runStatus !== "running" ? `the engine is ${gate.runStatus}` : null,
    gate.killSwitch ? "the kill switch is engaged" : null,
    gate.venueOnline ? null : "Kraken data or the paper wallet is unavailable",
    gate.reconciled ? null : "the books don't match the paper wallet yet",
  ].filter((x): x is string => x !== null)
  const equity = state?.equityUsd ?? a?.equity_usd ?? 0
  const ret = a && a.starting_usd > 0 ? roundTo((a.equity_usd / a.starting_usd - 1) * 100, 2) : 0
  const day = a && a.day_start_equity_usd > 0 ? roundTo((a.equity_usd / a.day_start_equity_usd - 1) * 100, 2) : 0
  return [
    `YOUR BOOK (the paper account: your decisions trade it${a ? `; started with $${a.starting_usd.toLocaleString("en-US")}` : ""})`,
    a ? `cash $${a.cash_usd.toFixed(2)} · equity $${a.equity_usd.toFixed(2)} (${ret >= 0 ? "+" : ""}${ret}%) · today ${day >= 0 ? "+" : ""}${day}% · realized $${a.realized_pnl_usd.toFixed(2)} · ${open.length} open` : "the account isn't loaded yet",
    ...(lines.length ? lines : ["- no open positions"]),
    "",
    ...limitsText(d, { equityUsd: equity, history, blocked }, now),
  ].join("\n")
}

/** What became of a decision `processDecision` recorded. */
const outcomeOf = (dec: NormalizedCryptoAgentDecision, doc: DecisionDoc): AgentAction => {
  const e = doc.execution
  if (e.status === "filled" || e.status === "partial") {
    return action(dec, "filled", `${dec.action === "buy" ? "bought" : "sold"} ${e.filled_qty} at ${e.avg_price ?? "?"}${e.status === "partial" ? " (partly filled)" : ""}${doc.sizing.notes.length ? `; ${doc.sizing.notes.join("; ")}` : ""}`)
  }
  if (e.status === "rejected") return action(dec, "rejected", doc.risk?.reasons.slice(0, 3).join("; ") || e.notes[0] || "rejected")
  if (e.status === "failed" || e.status === "skipped") return action(dec, "rejected", e.notes[0] ?? e.status)
  const raised = e.notes.find((n) => n.startsWith("stop raised"))
  return action(dec, raised ? "updated" : "held", raised ?? "unchanged")
}

/** The agent's decisions into the paper account: exits first, holds, then entries by conviction. */
export const actOnCryptoAnswer = async (d: Pick<CryptoAgentDeps, "ctx">, answer: CryptoAgentAnswer, episode: Pick<EpisodeInfo, "id" | "urls" | "wake" | "entriesPaused">): Promise<AgentAction[]> => {
  const { ctx } = d
  const settings = ctx.settings.current
  const held = new Map((await ctx.ledger.openPositions()).map((p) => [p.symbol, p]))
  const { decisions, dropped } = normalizeCryptoAgentDecisions(answer.decisions, { universe: new Set(ctx.hub.universe), held: new Set(held.keys()), sourceUrls: episode.urls })
  const out: AgentAction[] = dropped.map((why) => ({ symbol: why.split(":")[0], action: "unknown", conviction: 0, outcome: "rejected", detail: why }))
  const acting = decisions.filter((x) => x.action !== "no_trade")
  const { features } = acting.length ? await loadFeatures(ctx, [...new Set([...acting.map((x) => x.symbol), ...held.keys()])]) : { features: [] }
  const featuresOf = new Map(features.map((f) => [f.symbol, f]))
  const matrix = correlationMatrix(new Map(features.map((f) => [f.symbol, f.closes_1h])))
  const wireItemIds = [...new Set(episode.wake.observations.flatMap((o) => o.refs.item_ids ?? []))]
  try {
    for (const dec of [...decisions].sort((a, b) => ORDER[a.action] - ORDER[b.action] || b.conviction - a.conviction)) await decide(dec)
  } finally {
    // The execution path reports its steps as the engine's cycle state; the engine is idle again after.
    ctx.setCycleState("idle")
  }
  return out

  async function decide(dec: NormalizedCryptoAgentDecision) {
    const position = held.get(dec.symbol) ?? null
    const f = featuresOf.get(dec.symbol) ?? null
    if (dec.action === "no_trade") {
      out.push(action(dec, "not_applicable", "no trade"))
      return
    }
    if (dec.action !== "buy" && !position) {
      out.push(action(dec, "not_applicable", "not held"))
      return
    }
    // The trend core's and the long-term book's positions end by their rules; the agent overrides them only on news.
    if (dec.action === "close" && (position?.strategy_id === "core" || position?.strategy_id === "long_term") && !newsWoke(episode.wake.observations, dec.symbol)) {
      const book = position.strategy_id === "core" ? "a trend-core position closes by its rules (its trailing stop, a broken trend)" : "a long-term holding is sold by its rule (a week closing below its 200-day average)"
      out.push(action(dec, "blocked", `${book}; you may close it only when news about it woke you`))
      return
    }
    let decision: NormalizedCryptoAgentDecision = dec
    let candidate: CryptoCandidate | null = null
    if (dec.action === "buy") {
      if (episode.entriesPaused) {
        out.push(action(dec, "blocked", episode.entriesPaused))
        return
      }
      const { history } = await liveRiskState(d)
      const envelope = checkEntry(dec.symbol, history, settings.agent.envelope, Date.now())
      if (!envelope.approved) {
        out.push(action(dec, "blocked", `envelope: ${envelope.reason}`))
        return
      }
      const q = ctx.hub.quote(dec.symbol)
      if (!q) {
        out.push(action(dec, "rejected", "no live quote"))
        return
      }
      // The cycle's levels when the agent gives none: 2 ATR(1h) inside the allowed range, then 2.5R.
      const stop = agentStop(q.mid, dec.stop_loss, boundedStop(q.mid, 2 * (f?.atr_1h ?? q.mid * 0.015), settings), settings.kraken)
      const target = dec.take_profit !== null && dec.take_profit > q.mid ? dec.take_profit : q.mid + 2.5 * (q.mid - stop)
      const strategy = dec.strategy ?? "discretionary"
      candidate = { instrument: dec.symbol, symbol: dec.symbol, strategy, score: dec.conviction, signal: `agent: ${cleanLine(dec.thesis, 120)}`, features: f ? candidateFeatures(f) : {}, stop_hint: stop, target_hint: target }
      decision = { ...dec, stop_loss: stop, take_profit: target }
    }
    const doc = await processDecision(ctx, {
      cycleId: episode.id,
      researchId: null,
      decision,
      candidate,
      position,
      features: f,
      takerBps: ctx.feeBps(),
      matrix,
      decisionModel: settings.agent.model,
      triggerKind: "agent",
      promptVersion: CRYPTO_AGENT_PROMPT_VERSION,
      wireItemIds,
      agent: { episodeId: episode.id },
    })
    const result = outcomeOf(dec, doc)
    out.push(result)
    // Buys already post to Discord from the execution path; the agent's exits say so here.
    if (result.outcome === "filled" && (dec.action === "close" || dec.action === "reduce")) {
      await ctx.alerts
        .success(`Agent ${dec.action === "close" ? "sold" : "reduced"} ${dec.symbol}`, `[paper] ${cleanLine(dec.thesis, 400)}`, { path: `/agent/${episode.id}`, key: `agent-exit|${doc._id}`, fields: { Detail: result.detail } })
        .catch(() => undefined)
    }
  }
}
