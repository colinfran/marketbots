import { randomUUID } from "node:crypto"
import type { DecisionAction, DecisionDoc, PositionDoc } from "@mb/crypto-core/db"
import type { CycleKind } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { MAX_HORIZON_HOURS, type NormalizedCryptoDecision } from "@mb/crypto-core/report"
import type { Settings } from "@mb/crypto-core/settings"
import { ACCOUNT_ID, MODE } from "@mb/crypto-core/venues"
import { errorMessage } from "@mb/engine-kit/log"
import { cleanLine } from "@mb/engine-kit/util/text"
import { computeFeatures, type Features } from "../market/features"
import { correlatedWith, type correlationMatrix } from "../risk/correlation"
import { evaluateCryptoEntry, evaluateExit, type RiskResult } from "../risk/engine"
import { cryptoEdge, cryptoSize, roundTripCostBps, slippageBps, walkBook } from "../risk/sizing"
import type { CryptoCandidate } from "../strategies/types"
import { formatPrice, minimumViolation, roundPrice, roundQty } from "../venues/kraken/pairs"
import type { EngineContext } from "./context"
import { exitPosition } from "./trading"

/**
 * Turning one AI decision into what happens: features for the pairs it names, then for a buy the
 * levels, costs, edge and size, the risk engine and the executor; for an exit the minimum hold and
 * the sale; for a hold a stop that only moves up. Every decision is recorded in `decisions`.
 */

const HOUR = 3_600_000

export const loadFeatures = async (ctx: EngineContext, symbols: string[]) => {
  const features: Features[] = []
  const failures: string[] = []
  for (let i = 0; i < symbols.length; i += 3) {
    await Promise.all(
      symbols.slice(i, i + 3).map(async (symbol) => {
        const quote = ctx.hub.quote(symbol)
        if (!quote) return failures.push(`${symbol}: no quote`)
        try {
          const [h1, h4, d1] = await Promise.all([ctx.candles.get(symbol, 60), ctx.candles.get(symbol, 240), ctx.candles.get(symbol, 1440)])
          const f = computeFeatures(symbol, { h1, h4, d1 }, quote)
          if (f) features.push(f)
          else failures.push(`${symbol}: not enough history`)
        } catch (error) {
          failures.push(`${symbol}: ${errorMessage(error)}`)
        }
      }),
    )
  }
  return { features, failures }
}

/**
 * Whether a screen setup's own levels could pass the risk engine: reward:risk at the minimum, and an
 * edge after the round-trip cost even at the highest probability the engine allows. Setups that
 * can't are dropped before the AI is paid to look at them.
 */
export const viableSetup = (c: Pick<CryptoCandidate, "stop_hint" | "target_hint">, price: number, roundTripBps: number, k: Settings["kraken"]) => {
  const best = cryptoEdge({ price, stop: c.stop_hint, target: c.target_hint, pAi: 1, shrink: 1, roundTripBps })
  return !!best && best.rewardRisk >= k.min_reward_risk && best.netEdgeBps >= k.min_edge_bps
}

export type DecisionInput = {
  cycleId: string
  researchId: string | null
  decision: NormalizedCryptoDecision
  candidate: CryptoCandidate | null
  position: PositionDoc | null
  features: Features | null
  takerBps: number
  matrix: ReturnType<typeof correlationMatrix>
  decisionModel: string
  triggerKind: CycleKind
  /**
   * One-time seed buys: the owner set the dollar amount, so it replaces risk-based sizing, and the
   * risk engine skips only its conviction, edge and reward:risk gates. Every cap still applies.
   */
  seed?: { notionalUsd: number }
  /** The agent's prompt version. */
  promptVersion: string
  /** Event decisions: the wire items behind them. */
  wireItemIds?: string[]
  /** The agent's decisions (level auto): the episode, recorded on the decision, and the most its envelope lets a buy commit. */
  agent?: { episodeId: string; maxNotionalUsd: number }
}

/** A stop the seed can use as given: below the price and inside the configured stop range. */
const withinStopRange = (price: number, stop: number | null, k: Settings["kraken"]) => {
  if (stop === null || stop >= price) return false
  const pct = ((price - stop) / price) * 100
  return pct >= k.min_stop_pct && pct <= k.max_stop_pct
}

export const processDecision = async (ctx: EngineContext, i: DecisionInput): Promise<DecisionDoc> => {
  const settings = ctx.settings.current
  const { decision: d, features: f } = i
  const now = new Date()
  const quote = ctx.hub.quote(d.symbol)
  const doc: DecisionDoc = {
    _id: randomUUID(),
    cycle_id: i.cycleId,
    research_id: i.researchId,
    account_id: ACCOUNT_ID,
    mode: MODE,
    instrument: d.symbol,
    symbol: d.symbol,
    strategy_id: i.candidate?.strategy ?? i.position?.strategy_id ?? null,
    created_at: now,
    data_as_of: f ? new Date(f.as_of) : null,
    data_age_s: quote ? roundTo(quote.ageS, 1) : null,
    action: d.action as DecisionAction,
    held: i.position !== null,
    trigger_kind: i.triggerKind,
    ...(i.wireItemIds?.length ? { wire_item_ids: i.wireItemIds } : {}),
    ...(i.agent ? { agent_episode_id: i.agent.episodeId } : {}),
    ai: {
      conviction: d.conviction,
      uncertainty: d.uncertainty,
      thesis: d.thesis,
      bull_evidence: d.bull_evidence,
      bear_evidence: d.bear_evidence,
      risks: d.risks,
      invalidation: d.invalidation,
      horizon_hours: d.horizon_hours,
      priced_in: d.priced_in,
      stop_loss: d.stop_loss,
      take_profit: d.take_profit,
      size_pct_of_max: d.size_pct_of_max,
      reduce_pct: d.reduce_pct,
      p_target_first: d.p_target_first,
      notes: d.notes,
    },
    quant: {
      price: quote?.mid ?? f?.price ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spread_bps: quote ? roundTo(quote.spreadBps, 2) : null,
      atr_pct: f?.atr_pct_1h ?? null,
      signal: i.candidate?.signal ?? null,
      score: i.candidate?.score ?? null,
      features: i.candidate?.features ?? {},
      baseline_action: i.candidate ? "buy" : "hold",
    },
    costs: { fee_bps: i.takerBps, spread_bps: quote ? roundTo(quote.spreadBps, 2) : null, slippage_bps: null, round_trip_bps: null, fee_usd_est: null },
    ev: { p_prior: null, p_adjusted: null, gross_edge_bps: null, net_edge_bps: null },
    sizing: { qty: null, notional_usd: null, risk_usd: null, limit_price: null, stop_price: null, take_profit_price: null, notes: [] },
    risk: null,
    execution: { status: "not_applicable", order_ids: [], filled_qty: 0, avg_price: null, notes: [] },
    model: i.decisionModel,
    prompt_version: i.promptVersion,
    settings_version: ctx.settings.version,
    outcome_due_at: new Date(now.getTime() + Math.min(MAX_HORIZON_HOURS, Math.max(1, d.horizon_hours)) * HOUR),
    outcome: null,
  }

  let risk: RiskResult | null = null
  if (d.action === "buy" && i.candidate && quote?.book) {
    ctx.setCycleState("risk_check", d.symbol)
    const pair = ctx.hub.pairs.get(d.symbol)!
    const seed = i.seed
    // A seed stop outside the configured range would only fail the stop check; the bounded hint is used instead.
    const stop = seed ? (withinStopRange(quote.mid, d.stop_loss, settings.kraken) ? d.stop_loss! : i.candidate.stop_hint) : d.stop_loss && d.stop_loss < quote.mid ? d.stop_loss : i.candidate.stop_hint
    const target = d.take_profit && d.take_profit > quote.mid ? d.take_profit : i.candidate.target_hint
    const riskState = await ctx.ledger.riskState()
    const limit = roundPrice(pair, quote.ask * (1 + settings.kraken.max_slippage_bps / 10_000))
    const size = seed
      ? { qty: seed.notionalUsd / limit, notional: seed.notionalUsd, riskUsd: (seed.notionalUsd / limit) * Math.max(0, quote.ask - stop) }
      : cryptoSize({
          equity: riskState?.equityUsd ?? 0,
          price: quote.ask,
          stop,
          riskPct: settings.kraken.risk_per_trade_pct,
          maxPositionPct: settings.kraken.max_position_pct,
          sizePctOfMax: d.size_pct_of_max ?? 50,
        })
    // The agent's envelope can cap what a buy commits below what risk-based sizing would.
    const capped = i.agent !== undefined && size.qty * limit > i.agent.maxNotionalUsd
    const qty = roundQty(pair, capped ? i.agent!.maxNotionalUsd / limit : size.qty)
    const walkIn = walkBook(quote.book.asks, qty, limit, "buy")
    const walkOut = walkBook(quote.book.bids, qty, null, "sell")
    const inSlip = walkIn.avgPrice ? slippageBps(walkIn.avgPrice, quote.mid, "buy") - quote.spreadBps / 2 : settings.kraken.max_slippage_bps
    const outSlip = walkOut.avgPrice ? slippageBps(walkOut.avgPrice, quote.mid, "sell") - quote.spreadBps / 2 : settings.kraken.max_slippage_bps
    const roundTrip = roundTripCostBps({ takerFeeBps: i.takerBps, spreadBps: quote.spreadBps, entrySlippageBps: inSlip, exitSlippageBps: outSlip })
    const edge = cryptoEdge({ price: quote.mid, stop, target, pAi: d.p_target_first, shrink: settings.ai.probability_shrink, roundTripBps: roundTrip })
    doc.costs = { ...doc.costs, slippage_bps: roundTo(inSlip + outSlip, 2), round_trip_bps: roundTo(roundTrip, 2), fee_usd_est: roundTo((2 * (capped ? qty * limit : size.notional) * i.takerBps) / 10_000, 4) }
    if (edge) {
      doc.ev = { p_prior: roundTo(edge.pPrior, 4), p_adjusted: roundTo(edge.pAdjusted, 4), gross_edge_bps: roundTo(edge.grossEdgeBps, 2), net_edge_bps: roundTo(edge.netEdgeBps, 2) }
    }
    doc.sizing = {
      qty,
      notional_usd: roundTo(qty * limit, 2),
      risk_usd: roundTo(capped ? qty * Math.max(0, quote.ask - stop) : size.riskUsd, 2),
      limit_price: limit,
      stop_price: roundPrice(pair, stop),
      take_profit_price: roundPrice(pair, target),
      notes: capped ? [`capped at $${i.agent!.maxNotionalUsd.toFixed(2)} by the agent's envelope`] : [],
    }
    risk = riskState
      ? evaluateCryptoEntry(
          {
            symbol: d.symbol,
            strategyId: i.candidate.strategy,
            mid: quote.mid,
            spreadBps: quote.spreadBps,
            quoteAgeS: quote.ageS,
            qty,
            limitPrice: limit,
            stopPrice: stop,
            takeProfitPrice: target,
            conviction: d.conviction,
            netEdgeBps: edge?.netEdgeBps ?? Number.NEGATIVE_INFINITY,
            rewardRisk: edge?.rewardRisk ?? 0,
            correlatedHeld: correlatedWith(d.symbol, riskState.positions.map((p) => p.symbol), i.matrix, settings.kraken.correlation_threshold),
            takerFeeBps: i.takerBps,
            roundQty: (q) => roundQty(pair, q),
            minViolation: (q, p) => minimumViolation(pair, q, p),
            ownerDirected: !!seed,
          },
          riskState,
          ctx.gate(),
          settings,
        )
      : { approved: false, resized: false, qty: 0, notionalUsd: 0, checks: [{ name: "account", ok: false, detail: "account missing" }], reasons: ["account missing"] }
    doc.risk = { approved: risk.approved, resized: risk.resized, checks: risk.checks, reasons: risk.reasons }
    if (risk.approved) {
      ctx.setCycleState("placing_order", d.symbol)
      doc.sizing.qty = risk.qty
      doc.sizing.notional_usd = roundTo(risk.notionalUsd, 2)
      const report = await ctx.executor.execute({
        instrument: d.symbol,
        side: "buy",
        qty: risk.qty,
        limitPrice: limit,
        referencePrice: quote.mid,
        purpose: "entry",
        decisionId: doc._id,
        positionId: null,
        meta: {
          strategy_id: i.candidate.strategy,
          thesis: d.thesis,
          invalidation: d.invalidation,
          stop_price: doc.sizing.stop_price,
          take_profit_price: doc.sizing.take_profit_price,
          horizon_hours: d.horizon_hours,
        },
      })
      doc.execution = {
        status: report.order.filled_qty <= 0 ? (report.order.status === "rejected" ? "rejected" : "failed") : report.order.filled_qty < risk.qty - 1e-12 ? "partial" : "filled",
        order_ids: [report.order._id],
        filled_qty: report.order.filled_qty,
        avg_price: report.order.avg_fill_price,
        notes: report.order.reason ? [report.order.reason] : [],
      }
      const { filled_qty: filled, avg_fill_price: avg, fees_usd: fees } = report.order
      if (filled > 0 && avg !== null) {
        const cost = filled * avg + fees
        await ctx.alerts.success(seed ? `Seed buy: ${d.symbol}` : `Bought ${d.symbol}`, `[paper] ${cleanLine(d.thesis, 400)}`, {
          path: `/decisions/${doc._id}`,
          key: `buy|${report.order._id}`,
          fields: {
            Quantity: filled,
            Price: `$${formatPrice(pair, avg)}`,
            Cost: `$${cost.toFixed(2)}${riskState?.equityUsd ? ` (${((cost / riskState.equityUsd) * 100).toFixed(1)}% of equity)` : ""}`,
            Stop: `$${formatPrice(pair, stop)}`,
            Target: `$${formatPrice(pair, target)}`,
            Strategy: i.candidate.strategy.replace("_", " "),
            Conviction: `${d.conviction}/100`,
          },
        })
      }
    } else {
      doc.execution.status = "rejected"
    }
  } else if (d.action === "buy") {
    doc.execution = { ...doc.execution, status: "skipped", notes: ["no live order book at execution time"] }
  } else if ((d.action === "reduce" || d.action === "close") && i.position) {
    const check = evaluateExit({ reason: "ai", openedAt: i.position.opened_at.getTime(), venueOnline: ctx.hub.tradingOnline, minHoldMinutes: settings.kraken.min_hold_minutes })
    doc.risk = { approved: check.approved, resized: false, checks: check.checks, reasons: check.reasons }
    risk = { approved: check.approved, resized: false, qty: 0, notionalUsd: 0, checks: check.checks, reasons: check.reasons }
    if (check.approved) {
      ctx.setCycleState("placing_order", d.symbol)
      const fraction = d.action === "close" ? 1 : (d.reduce_pct ?? 50) / 100
      const report = await exitPosition(ctx, i.position, { purpose: d.action === "close" ? "exit" : "reduce", fraction, decisionId: doc._id })
      doc.execution = report
        ? {
            status: report.order.filled_qty > 0 ? (report.order.filled_qty < report.order.qty - 1e-12 ? "partial" : "filled") : "failed",
            order_ids: [report.order._id],
            filled_qty: report.order.filled_qty,
            avg_price: report.order.avg_fill_price,
            notes: report.order.reason ? [report.order.reason] : [],
          }
        : { ...doc.execution, status: "failed", notes: ["exit could not be placed (no market data)"] }
    } else {
      doc.execution.status = "rejected"
    }
  } else if (d.action === "hold" && i.position) {
    // Stops only ever move up on a long: a lower stop would add risk the original plan didn't take.
    const p = i.position
    const newStop = d.stop_loss && (!p.stop_price || d.stop_loss > p.stop_price) && quote && d.stop_loss < quote.bid ? d.stop_loss : p.stop_price
    const newTarget = d.take_profit && quote && d.take_profit > quote.ask ? d.take_profit : p.take_profit_price
    await ctx.ledger.updatePosition(p._id, { stop_price: newStop, take_profit_price: newTarget, last_reviewed_at: now, last_review_price: quote?.mid ?? p.mark_price })
    if (newStop !== p.stop_price) doc.execution.notes.push(`stop raised ${p.stop_price} → ${newStop}`)
  }
  if (i.position && d.action !== "hold") await ctx.ledger.updatePosition(i.position._id, { last_reviewed_at: now, last_review_price: quote?.mid ?? i.position.mark_price })

  await ctx.col.decisions.insertOne(doc)
  ctx.bus.emit(
    "ai.decision.proposed",
    { decision_id: doc._id, instrument: d.symbol, action: d.action, conviction: d.conviction, thesis: d.thesis.slice(0, 280), edge_bps: doc.ev.net_edge_bps, execution: doc.execution.status },
    { summary: `${d.symbol}: ${d.action.replace("_", " ")} (conviction ${d.conviction})`, cycle_id: i.cycleId, instrument: d.symbol },
  )
  if (risk) {
    ctx.bus.emit(
      "risk.checked",
      { decision_id: doc._id, instrument: d.symbol, approved: risk.approved, resized: risk.resized, reasons: risk.reasons.slice(0, 6), qty: risk.approved ? risk.qty : null, notional_usd: risk.approved ? roundTo(risk.notionalUsd, 2) : null },
      {
        summary: risk.approved ? `Risk approved ${d.symbol}${risk.resized ? " (resized)" : ""}` : `Risk rejected ${d.symbol}: ${risk.reasons[0] ?? "rule failed"}`,
        level: risk.approved ? "info" : "warn",
        cycle_id: i.cycleId,
        instrument: d.symbol,
      },
    )
  }
  return doc
}
