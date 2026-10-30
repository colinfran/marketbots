import { checkEntry, entryRoomUsd } from "@mb/agent/envelope"
import type { EpisodeInfo } from "@mb/agent/runtime"
import type { AgentAction } from "@mb/core/agent"
import { normalizeCryptoAgentDecisions, type CryptoAgentAnswer, type NormalizedCryptoAgentDecision } from "@mb/crypto-core/agent"
import { loadFeatures } from "../orchestrator/decide"
import { correlatedWith, correlationMatrix } from "../risk/correlation"
import { evaluateCryptoEntry, evaluateExit } from "../risk/engine"
import { cryptoEdge, cryptoSize, roundTripCostBps, slippageBps, walkBook } from "../risk/sizing"
import { boundedStop } from "../strategies/types"
import { minimumViolation, roundPrice, roundQty } from "../venues/kraken/pairs"
import { agentStop, isLive, shadowGate, shadowRiskState, type CryptoAgentDeps } from "./book"
import { actLive } from "./live"

/**
 * The crypto agent's decisions (docs/plans/LOCAL-AI.md §8.4, §9). At level auto they trade the
 * paper account (./live). Otherwise they go into the shadow book: normalized with the cycle's own
 * rules, then exits first, holds, and entries by conviction. An entry passes the envelope's rate
 * limits, is sized like a cycle's (risk per trade, max position, the AI's share of the max), cut to
 * the envelope's share and the hour's commitment budget, and then goes through the same risk engine
 * as a cycle's buy, against the shadow book's own account. Exits obey only the minimum hold; they
 * are never rate-limited.
 */

const ORDER: Record<NormalizedCryptoAgentDecision["action"], number> = { close: 0, reduce: 1, hold: 2, buy: 3, no_trade: 4 }

const action = (d: NormalizedCryptoAgentDecision, outcome: AgentAction["outcome"], detail: string | null): AgentAction => ({ symbol: d.symbol, action: d.action, conviction: d.conviction, outcome, detail })

export const actOnCryptoAnswer = async (d: CryptoAgentDeps, answer: CryptoAgentAnswer, episode: Pick<EpisodeInfo, "id" | "urls" | "wake" | "entriesPaused">): Promise<AgentAction[]> => {
  if (isLive(d)) return actLive(d, answer, episode)
  const { ctx, shadow } = d
  const settings = ctx.settings.current
  const k = settings.kraken
  const held = new Map((await shadow.open()).map((p) => [p.symbol, p]))
  const { decisions, dropped } = normalizeCryptoAgentDecisions(answer.decisions, { universe: new Set(ctx.hub.universe), held: new Set(held.keys()), sourceUrls: episode.urls })
  const out: AgentAction[] = dropped.map((why) => ({ symbol: why.split(":")[0], action: "unknown", conviction: 0, outcome: "rejected", detail: why }))
  for (const dec of [...decisions].sort((a, b) => ORDER[a.action] - ORDER[b.action] || b.conviction - a.conviction)) {
    const position = held.get(dec.symbol) ?? null
    const q = ctx.hub.quote(dec.symbol)
    if (dec.action === "no_trade") {
      out.push(action(dec, "not_applicable", "no trade"))
      continue
    }
    if (dec.action === "hold" && position) {
      // A new stop must sit below the bid and above the old one; a new target above the ask.
      const stop = dec.stop_loss !== null && q && dec.stop_loss < q.bid ? dec.stop_loss : null
      const target = dec.take_profit !== null && q && dec.take_profit > q.ask ? dec.take_profit : null
      const r = await shadow.update(position, { stop, target, reviewedPrice: q?.mid ?? position.mark_price })
      out.push(action(dec, r.raised || target !== null ? "updated" : "held", r.raised ? `stop raised ${position.stop_price} → ${r.stop}` : target !== null ? `target ${target}` : "unchanged"))
      continue
    }
    if ((dec.action === "reduce" || dec.action === "close") && position) {
      const exit = evaluateExit({ reason: "ai", openedAt: position.opened_at.getTime(), venueOnline: ctx.hub.tradingOnline, minHoldMinutes: k.min_hold_minutes })
      if (!exit.approved) {
        out.push(action(dec, "rejected", exit.reasons.join("; ")))
        continue
      }
      if (!q) {
        out.push(action(dec, "rejected", "no live quote"))
        continue
      }
      const pair = ctx.hub.pairs.get(dec.symbol)
      const qty = dec.action === "close" ? position.qty : pair ? roundQty(pair, (position.qty * (dec.reduce_pct ?? 50)) / 100) : 0
      const fill = qty > 0 ? await shadow.sell(position, { qty, reference: q.bid, reason: dec.action === "close" ? "exit" : "reduce", episodeId: episode.id }) : null
      if (fill && dec.action === "reduce") await shadow.update({ ...position, qty: position.qty - qty }, { reviewedPrice: q.mid })
      out.push(fill ? action(dec, "filled", `sold ${fill.qty} at ${fill.price}`) : action(dec, "rejected", "the reduction rounds to nothing"))
      continue
    }
    if (dec.action === "buy") out.push(await buy(d, dec, episode.id))
  }
  return out
}

const buy = async (d: CryptoAgentDeps, dec: NormalizedCryptoAgentDecision, episodeId: string): Promise<AgentAction> => {
  const { ctx, shadow } = d
  const settings = ctx.settings.current
  const k = settings.kraken
  const q = ctx.hub.quote(dec.symbol)
  const pair = ctx.hub.pairs.get(dec.symbol)
  if (!q?.book || !pair) return action(dec, "rejected", "no live order book")
  const now = Date.now()
  const { state, history, open } = await shadowRiskState(d)
  const envelope = checkEntry(dec.symbol, history, settings.agent.envelope, now)
  if (!envelope.approved) return action(dec, "blocked", `envelope: ${envelope.reason}`)

  const { features } = await loadFeatures(ctx, [...new Set([dec.symbol, ...open.map((p) => p.symbol)])])
  const f = features.find((x) => x.symbol === dec.symbol)
  const stop = agentStop(q.mid, dec.stop_loss, boundedStop(q.mid, 2 * (f?.atr_1h ?? q.mid * 0.015), settings), k)
  const target = dec.take_profit !== null && dec.take_profit > q.mid ? dec.take_profit : q.mid + 2.5 * (q.mid - stop)
  const limit = roundPrice(pair, q.ask * (1 + k.max_slippage_bps / 10_000))
  const size = cryptoSize({ equity: state.equityUsd, price: q.ask, stop, riskPct: k.risk_per_trade_pct, maxPositionPct: k.max_position_pct, sizePctOfMax: dec.size_pct_of_max ?? 50 })
  const room = entryRoomUsd(size.notional, history, settings.agent.envelope, now)
  if (room <= 0) return action(dec, "blocked", "envelope: this hour's commitment budget is used up")
  const qty = roundQty(pair, room / limit)
  const walkIn = walkBook(q.book.asks, qty, limit, "buy")
  const walkOut = walkBook(q.book.bids, qty, null, "sell")
  const inSlip = walkIn.avgPrice ? slippageBps(walkIn.avgPrice, q.mid, "buy") - q.spreadBps / 2 : k.max_slippage_bps
  const outSlip = walkOut.avgPrice ? slippageBps(walkOut.avgPrice, q.mid, "sell") - q.spreadBps / 2 : k.max_slippage_bps
  const roundTrip = roundTripCostBps({ takerFeeBps: ctx.feeBps(), spreadBps: q.spreadBps, entrySlippageBps: inSlip, exitSlippageBps: outSlip })
  const edge = cryptoEdge({ price: q.mid, stop, target, pAi: dec.p_target_first, shrink: settings.ai.probability_shrink, roundTripBps: roundTrip })
  const matrix = correlationMatrix(new Map(features.map((x) => [x.symbol, x.closes_1h])))
  const risk = evaluateCryptoEntry(
    {
      symbol: dec.symbol,
      strategyId: dec.strategy ?? "discretionary",
      mid: q.mid,
      spreadBps: q.spreadBps,
      quoteAgeS: q.ageS,
      qty,
      limitPrice: limit,
      stopPrice: stop,
      takeProfitPrice: target,
      conviction: dec.conviction,
      netEdgeBps: edge?.netEdgeBps ?? Number.NEGATIVE_INFINITY,
      rewardRisk: edge?.rewardRisk ?? 0,
      correlatedHeld: correlatedWith(dec.symbol, open.map((p) => p.symbol), matrix, k.correlation_threshold),
      takerFeeBps: ctx.feeBps(),
      roundQty: (x) => roundQty(pair, x),
      minViolation: (x, p) => minimumViolation(pair, x, p),
    },
    state,
    shadowGate(ctx),
    settings,
  )
  if (!risk.approved) return action(dec, "rejected", risk.reasons.slice(0, 3).join("; ") || "risk check failed")
  const r = await shadow.buy({
    symbol: dec.symbol,
    qty: risk.qty,
    reference: q.ask,
    episodeId,
    stop: roundPrice(pair, stop),
    target: roundPrice(pair, target),
    horizon: String(dec.horizon_hours),
    strategy: dec.strategy,
    thesis: dec.thesis,
    invalidation: dec.invalidation,
    conviction: dec.conviction,
  })
  if (!r.ok) return action(dec, "rejected", r.reason)
  return action(dec, "filled", `bought ${r.fill.qty} at ${roundPrice(pair, r.fill.price)} ($${(r.fill.qty * r.fill.price).toFixed(2)}), stop ${roundPrice(pair, stop)}, target ${roundPrice(pair, target)}, net edge ${edge?.netEdgeBps.toFixed(0) ?? "?"} bps`)
}
