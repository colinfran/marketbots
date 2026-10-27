import type { DecisionDoc, SeedAllocation, SeedOrder } from "@mb/stock-core/db"
import type { Decision } from "@mb/stock-core/report"
import type { RiskSettings } from "@mb/stock-core/settings"
import { seedStopPct } from "../ai/prompts"

/**
 * Rules for the owner's one-time seed cycle. The seed is an ordinary intraday cycle whose prompt
 * asks only for long-term core buys; these functions then hold Grok's answer to that:
 *   - buys only (at most three, none of a held symbol), every one multi_day;
 *   - the buys' total notional at most the seed amount + 5% (allocation_pct is % of equity);
 *   - exit levels a core hold can live with (about a 7.5% stop and a far target).
 * Execution still goes through executeDecisions, so every normal risk check applies.
 */

export const SEED_MAX_BUYS = 3
/** Total seed notional may exceed the amount by this much (whole shares, rounding). */
export const SEED_TOLERANCE = 1.05
/** Target distance for a core hold whose target is missing or too close, in multiples of the stop distance. */
const SEED_TARGET_R = 2.5

const floor2 = (n: number) => Math.floor(n * 100) / 100
const round2 = (n: number) => Math.round(n * 100) / 100

export type SeedOutcome = { allocations: SeedAllocation[]; orders: SeedOrder[]; notes: string[]; rationale: string | null; executed: number }

/** Keeps only the seed's buys and caps their total at the amount + 5%. */
export const normalizeSeedDecisions = (decisions: Decision[], { held, equity, amountUsd }: { held: ReadonlySet<string>; equity: number; amountUsd: number }) => {
  const notes: string[] = []
  const buys: Decision[] = []
  for (const d of decisions) {
    if (d.action !== "buy") {
      notes.push(`${d.symbol}: "${d.action}" dropped (the seed cycle only buys)`)
      continue
    }
    if (held.has(d.symbol)) {
      notes.push(`${d.symbol}: already held; dropped`)
      continue
    }
    if (!d.allocation_pct || d.allocation_pct <= 0) {
      notes.push(`${d.symbol}: no allocation_pct; dropped`)
      continue
    }
    if (buys.length >= SEED_MAX_BUYS) {
      notes.push(`${d.symbol}: more than ${SEED_MAX_BUYS} buys; dropped`)
      continue
    }
    buys.push({ ...d, horizon: "multi_day" })
  }
  const allowedPct = equity > 0 ? ((amountUsd * SEED_TOLERANCE) / equity) * 100 : 0
  const total = buys.reduce((s, d) => s + (d.allocation_pct ?? 0), 0)
  if (total > allowedPct && total > 0) {
    notes.push(`allocations summed to ${round2(total)}% of equity; scaled to ${round2(allowedPct)}% (the seed amount + 5%)`)
    const scale = allowedPct / total
    for (const d of buys) d.allocation_pct = floor2((d.allocation_pct ?? 0) * scale)
  }
  return { decisions: buys, notes }
}

/**
 * Exit levels for a seed buy at `price`: Grok's stop when it sits inside the configured range,
 * else about 7.5% below; Grok's target when it clears the minimum reward:risk, else 2.5× the stop
 * distance above.
 */
export const seedExits = (d: Pick<Decision, "symbol" | "stop_loss" | "take_profit">, price: number, risk: Pick<RiskSettings, "min_stop_pct" | "max_stop_pct" | "min_reward_risk">) => {
  const notes: string[] = []
  const stopPct = d.stop_loss !== null ? ((price - d.stop_loss) / price) * 100 : null
  let stop = d.stop_loss
  if (stop === null || stopPct === null || stopPct < risk.min_stop_pct || stopPct > risk.max_stop_pct) {
    stop = floor2(price * (1 - seedStopPct(risk) / 100))
    notes.push(`${d.symbol}: stop ${d.stop_loss ?? "missing"} outside ${risk.min_stop_pct}–${risk.max_stop_pct}%; using ${stop}`)
  }
  let target = d.take_profit
  if (target === null || target <= price || (target - price) / (price - stop) < risk.min_reward_risk) {
    target = round2(price + SEED_TARGET_R * (price - stop))
    notes.push(`${d.symbol}: target ${d.take_profit ?? "missing"} too close for a core hold; using ${target}`)
  }
  return { stop_loss: stop, take_profit: target, notes }
}

/** What happened to each seed buy, for the seed run record. */
export const seedOrderOf = (doc: Pick<DecisionDoc, "_id" | "symbol" | "status" | "qty" | "notional" | "reason">): SeedOrder => ({
  symbol: doc.symbol,
  decision_id: doc._id,
  status: doc.status,
  qty: doc.qty,
  notional_usd: doc.notional,
  reason: doc.reason,
})
