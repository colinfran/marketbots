import type { DecisionDoc, DecisionOutcome } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import type { Candle } from "../venues/kraken/rest"
import type { EngineContext } from "./context"

/**
 * Scores decisions once their horizon has passed, using closed 1h candles. This is how the system
 * learns whether the AI adds value, without letting it change anything automatically:
 *
 * - buys: did the target or the stop hit first, and what was the forward return after costs?
 * - no-trades on candidates: what would the trade have done? (missed opportunities vs. good skips)
 * - holds / reduces / closes: did staying in (or getting out) pay?
 *
 * Every decision also records the screen's baseline action, so AI-filtered results can be compared
 * with what the no-AI strategy would have done.
 */

const HOUR = 3_600_000

/** First level touched, scanning candles in order. If both are inside one candle, assume the stop (conservative). */
export const firstTouch = (candles: Candle[], stop: number | null, target: number | null): DecisionOutcome["hit"] => {
  if (stop === null && target === null) return null
  for (const c of candles) {
    const hitStop = stop !== null && c.low <= stop
    const hitTarget = target !== null && c.high >= target
    if (hitStop) return "stop"
    if (hitTarget) return "target"
  }
  return "neither"
}

export const scoreDecision = (d: DecisionDoc, window: Candle[], now = new Date()): DecisionOutcome => {
  const base = d.quant.price
  const last = window.at(-1)?.close ?? null
  const forward = base && last ? ((last / base - 1) * 100) : null
  const stop = d.sizing.stop_price ?? d.ai.stop_loss ?? (typeof d.quant.features.stop_hint === "number" ? d.quant.features.stop_hint : null)
  const target = d.sizing.take_profit_price ?? d.ai.take_profit ?? (typeof d.quant.features.target_hint === "number" ? d.quant.features.target_hint : null)
  const hit = firstTouch(window, stop, target)
  const costPct = (d.costs.round_trip_bps ?? (d.costs.fee_bps ?? 40) * 2) / 100
  let correct: boolean | null = null
  if (forward !== null) {
    if (d.action === "buy") correct = hit === "target" ? true : hit === "stop" ? false : forward > costPct
    else if (d.action === "no_trade" && !d.held) correct = hit === "target" ? false : hit === "stop" ? true : forward <= costPct
    else if (d.action === "hold") correct = hit === "stop" ? false : forward >= 0
    else if (d.action === "reduce" || d.action === "close") correct = forward < 0
  }
  return {
    evaluated_at: now,
    horizon_hours: d.ai.horizon_hours,
    price_at_decision: base,
    price_at_horizon: last,
    forward_return_pct: forward === null ? null : roundTo(forward, 3),
    hit,
    correct,
  }
}

export const evaluateOutcomes = async (ctx: EngineContext, now = Date.now()) => {
  const due = await ctx.col.decisions.find({ outcome: null, outcome_due_at: { $lte: new Date(now) } }).sort({ outcome_due_at: 1 }).limit(100).toArray()
  let scored = 0
  for (const d of due) {
    if (!ctx.hub.pairs.has(d.symbol)) continue
    // Kraken keeps 720 hourly candles (30 days); older decisions fall back to 4h candles.
    const ageHours = (now - d.created_at.getTime()) / HOUR
    const candles = await ctx.candles.get(d.symbol, ageHours < 700 ? 60 : 240).catch(() => null)
    if (!candles?.length) continue
    const start = d.created_at.getTime()
    const end = d.outcome_due_at.getTime()
    const window = candles.filter((c) => c.t >= start - 30 * 60_000 && c.t < end)
    if (!window.length) continue
    await ctx.col.decisions.updateOne({ _id: d._id }, { $set: { outcome: scoreDecision(d, window, new Date(now)) } })
    scored += 1
  }
  return scored
}
