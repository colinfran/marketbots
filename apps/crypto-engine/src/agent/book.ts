import { checkEntry, entryRoomUsd, type EnvelopeHistory } from "@mb/agent/envelope"
import { roundTo } from "@mb/crypto-core/math"
import type { Settings } from "@mb/crypto-core/settings"
import type { HistoryStore } from "@mb/history/store"
import type { WireCategory } from "@mb/crypto-core/wire"
import type { EngineContext } from "../orchestrator/context"
import { formatPrice } from "../venues/kraken/pairs"

/** What the crypto agent works with: the engine's context (the paper account is its book) and the history store. */

export type CryptoAgentDeps = {
  ctx: EngineContext
  history: HistoryStore<WireCategory> | null
}

export const mid = (ctx: EngineContext) => (symbol: string) => ctx.hub.quote(symbol)?.mid ?? null

/** How far inside the allowed stop range a clamped stop lands, as a share of the range's edge, so rounding and a moving mid can't push it back out. */
const STOP_MARGIN = 0.02

/**
 * The agent's stop for an entry: its own when it is below the price and within the allowed range;
 * moved just inside the range when it is outside it (the model often lands a hair past an edge);
 * `fallback` when it gave none or one at or above the price.
 */
export const agentStop = (mid: number, stop: number | null, fallback: number, k: Pick<Settings["kraken"], "min_stop_pct" | "max_stop_pct">) => {
  if (stop === null || stop >= mid) return fallback
  const pct = ((mid - stop) / mid) * 100
  if (pct > k.max_stop_pct) return mid * (1 - (k.max_stop_pct * (1 - STOP_MARGIN)) / 100)
  if (pct < k.min_stop_pct) return mid * (1 - (k.min_stop_pct * (1 + STOP_MARGIN)) / 100)
  return stop
}

export const price = (d: Pick<CryptoAgentDeps, "ctx">, symbol: string, p: number | null) => {
  if (p === null) return "n/a"
  const pair = d.ctx.hub.pairs.get(symbol)
  return pair ? formatPrice(pair, p) : String(roundTo(p, 6))
}

/** LIMITS: what code enforces right now. `blocked` lists why entries can't happen at all. */
export const limitsText = (d: Pick<CryptoAgentDeps, "ctx">, { equityUsd, history, blocked }: { equityUsd: number; history: EnvelopeHistory; blocked: string[] }, now = new Date()) => {
  const k = d.ctx.settings.current.kraken
  const env = d.ctx.settings.current.agent.envelope
  const envelope = checkEntry("", history, env, now.getTime())
  const room = entryRoomUsd(Number.POSITIVE_INFINITY, history, env, now.getTime())
  const maxPosition = (equityUsd * k.max_position_pct) / 100
  return [
    "LIMITS (enforced by code)",
    `- New entries: ${blocked.length ? `blocked (${blocked.join("; ")})` : envelope.approved ? "allowed" : `blocked by your envelope (${envelope.reason})`}.`,
    `- Your envelope: ${history.entries.length}/${env.entries_per_day} entries in 24 h, ${history.entries.filter((e) => now.getTime() - e.at < 3_600_000).length}/${env.entries_per_hour} in the last hour, ${history.openPositions}/${env.max_open_positions} open; $${room.toFixed(0)} more can be committed this hour; an entry is ${env.size_pct}% of what the risk checks allow; one action per pair per ${env.symbol_action_minutes} min; no re-entry for ${env.reentry_after_stop_hours} h after a stop-out or ${env.flip_hours} h after an exit.`,
    `- Risk checks: lose at most ${k.risk_per_trade_pct}% of equity at the stop; at most ${k.max_position_pct}% of equity in one position ($${maxPosition.toFixed(0)}); reward:risk ≥ ${k.min_reward_risk}; edge after costs ≥ ${k.min_edge_bps} bps; conviction ≥ ${k.min_conviction}; stop ${k.min_stop_pct}-${k.max_stop_pct}% below the price; spread ≤ ${k.max_spread_bps} bps; positions held at least ${k.min_hold_minutes} min before you can close them.`,
    `- Costs: taker fee ${d.ctx.feeBps()} bps a side plus ${k.paper_slippage_bps} bps slippage, and the spread.`,
  ]
}

