import type { RiskCheck } from "@mb/crypto-core/db"
import type { Settings } from "@mb/crypto-core/settings"
import type { StrategyId } from "@mb/crypto-core/strategies"

/**
 * The deterministic risk engine. Every order the AI proposes passes through here; nothing the AI
 * outputs can skip or loosen these checks, and the AI has no way to change the settings they read.
 *
 * Entries are checked in two stages:
 *   1. gates: anything failing here rejects the trade (halted, stale data, no edge, …)
 *   2. caps: size limits (position, asset, total, correlated, strategy, cash) RESIZE the order
 *      down; it's rejected only if nothing is left or the result falls below venue minimums.
 * Exits are risk-reducing, so they're allowed even when paused, halted or unreconciled.
 *
 * All functions are pure: same inputs, same answer. Every check is returned for the audit trail.
 */

export type Gate = {
  runStatus: "running" | "paused" | "halted"
  killSwitch: boolean
  /** Kraken market data is live and the paper wallet is reachable. */
  venueOnline: boolean
  /** The last reconciliation of the books with the paper wallet was clean. */
  reconciled: boolean
}

export type HeldPosition = {
  instrument: string
  symbol: string
  valueUsd: number
  strategyId: StrategyId | null
}

export type AccountState = {
  equityUsd: number
  cashUsd: number
  dayStartEquityUsd: number
  peakEquityUsd: number
  positions: HeldPosition[]
  tradesToday: number
  /** Most recent exit time per instrument, for re-entry cooldowns. */
  lastExitAt: ReadonlyMap<string, number>
}

export type RiskResult = {
  approved: boolean
  resized: boolean
  qty: number
  notionalUsd: number
  checks: RiskCheck[]
  reasons: string[]
}

class Checks {
  readonly list: RiskCheck[] = []
  check(name: string, ok: boolean, detail: string) {
    this.list.push({ name, ok, detail })
    return ok
  }
  get failed() {
    return this.list.filter((c) => !c.ok)
  }
}

const pct = (v: number) => `${v.toFixed(2)}%`

export const dayPnlPct = (a: AccountState) => (a.dayStartEquityUsd > 0 ? (a.equityUsd / a.dayStartEquityUsd - 1) * 100 : 0)
export const drawdownPct = (a: AccountState) => (a.peakEquityUsd > 0 ? (a.equityUsd / a.peakEquityUsd - 1) * 100 : 0)

/** Gates shared by every new entry on any venue. */
const entryGates = (c: Checks, gate: Gate, account: AccountState, portfolio: Settings["portfolio"]) => {
  c.check("engine_running", gate.runStatus === "running", `engine is ${gate.runStatus}`)
  c.check("kill_switch_off", !gate.killSwitch, gate.killSwitch ? "kill switch engaged" : "off")
  c.check("venue_online", gate.venueOnline, gate.venueOnline ? "online" : "Kraken data or paper wallet unavailable")
  c.check("reconciled", gate.reconciled, gate.reconciled ? "books match the paper wallet" : "books don't match the paper wallet; resolve before new entries")
  const day = dayPnlPct(account)
  c.check("daily_loss", day > -portfolio.max_daily_loss_pct, `day P&L ${pct(day)} vs limit -${portfolio.max_daily_loss_pct}%`)
  const dd = drawdownPct(account)
  c.check("drawdown", dd > -portfolio.max_drawdown_pct, `drawdown ${pct(dd)} vs limit -${portfolio.max_drawdown_pct}%`)
}

/** Applies a cap: returns the allowed notional and records whether the cap bound. */
const cap = (c: Checks, name: string, requested: number, room: number, detail: string) => {
  const allowed = Math.max(0, Math.min(requested, room))
  c.check(name, room > 0, room > 0 ? `${detail}; room $${room.toFixed(2)}` : `${detail}; no room left`)
  return allowed
}

export type CryptoEntry = {
  symbol: string
  strategyId: StrategyId
  mid: number
  spreadBps: number
  quoteAgeS: number
  qty: number
  limitPrice: number
  stopPrice: number
  takeProfitPrice: number
  conviction: number
  netEdgeBps: number
  rewardRisk: number
  /** Held symbols correlated with this one (see risk/correlation). */
  correlatedHeld: string[]
  takerFeeBps: number
  /** Rounds a quantity to the venue's lot size. */
  roundQty: (qty: number) => number
  /** Venue minimum-size violation for a quantity, or null. */
  minViolation: (qty: number, price: number) => string | null
}

export const evaluateCryptoEntry = (p: CryptoEntry, account: AccountState, gate: Gate, settings: Settings, now = Date.now()): RiskResult => {
  const k = settings.kraken
  const c = new Checks()
  entryGates(c, gate, account, settings.portfolio)
  c.check("fresh_quote", p.quoteAgeS <= k.max_quote_age_seconds, `quote ${p.quoteAgeS.toFixed(1)}s old (max ${k.max_quote_age_seconds}s)`)
  c.check("spread", p.spreadBps <= k.max_spread_bps, `spread ${p.spreadBps.toFixed(1)} bps (max ${k.max_spread_bps})`)
  c.check("strategy_enabled", settings.strategies[p.strategyId].enabled, `${p.strategyId} ${settings.strategies[p.strategyId].enabled ? "enabled" : "disabled"}`)
  c.check("not_held", !account.positions.some((h) => h.symbol === p.symbol), "no existing position (adding is disabled)")
  c.check(
    "max_positions",
    account.positions.length < k.max_concurrent_positions,
    `${account.positions.length}/${k.max_concurrent_positions} positions open`,
  )
  c.check("trades_per_day", account.tradesToday < k.max_trades_per_day, `${account.tradesToday}/${k.max_trades_per_day} trades today`)
  const lastExit = account.lastExitAt.get(p.symbol)
  const cooldownLeft = lastExit ? k.reentry_cooldown_minutes - (now - lastExit) / 60_000 : 0
  c.check("reentry_cooldown", cooldownLeft <= 0, cooldownLeft > 0 ? `exited ${p.symbol} recently; ${Math.ceil(cooldownLeft)} min of cooldown left` : "no recent exit")
  c.check("conviction", p.conviction >= k.min_conviction, `conviction ${p.conviction} (min ${k.min_conviction})`)
  c.check("edge_after_costs", p.netEdgeBps >= k.min_edge_bps, `expected net edge ${p.netEdgeBps.toFixed(1)} bps (min ${k.min_edge_bps})`)
  c.check("reward_risk", p.rewardRisk >= k.min_reward_risk, `reward:risk ${p.rewardRisk.toFixed(2)} (min ${k.min_reward_risk})`)
  const stopPct = ((p.mid - p.stopPrice) / p.mid) * 100
  c.check(
    "stop_distance",
    p.stopPrice < p.mid && stopPct >= k.min_stop_pct && stopPct <= k.max_stop_pct,
    `stop ${p.stopPrice} is ${pct(stopPct)} below (allowed ${k.min_stop_pct}-${k.max_stop_pct}%)`,
  )
  c.check("target_above", p.takeProfitPrice > p.mid, `target ${p.takeProfitPrice} vs price ${p.mid}`)
  const limitDevBps = ((p.limitPrice - p.mid) / p.mid) * 10_000
  c.check("limit_price_sane", limitDevBps >= 0 && limitDevBps <= k.max_slippage_bps + p.spreadBps / 2 + 1, `limit ${limitDevBps.toFixed(1)} bps above mid`)

  if (c.failed.length) return { approved: false, resized: false, qty: 0, notionalUsd: 0, checks: c.list, reasons: c.failed.map((f) => f.detail) }

  // ── caps (resize) ──
  const eq = account.equityUsd
  const requested = p.qty * p.limitPrice
  const exposure = account.positions.reduce((s, h) => s + h.valueUsd, 0)
  const correlated = account.positions.filter((h) => p.correlatedHeld.includes(h.symbol)).reduce((s, h) => s + h.valueUsd, 0)
  const strategyExposure = account.positions.filter((h) => h.strategyId === p.strategyId).reduce((s, h) => s + h.valueUsd, 0)
  const feeFactor = 1 + p.takerFeeBps / 10_000
  let allowed = requested
  allowed = cap(c, "max_position", allowed, (eq * k.max_position_pct) / 100, `max position ${k.max_position_pct}% of equity`)
  allowed = cap(c, "asset_exposure", allowed, (eq * k.max_asset_exposure_pct) / 100, `max ${k.max_asset_exposure_pct}% per asset`)
  allowed = cap(c, "total_exposure", allowed, (eq * k.max_total_exposure_pct) / 100 - exposure, `total exposure ${pct((exposure / eq) * 100)} (max ${k.max_total_exposure_pct}%)`)
  allowed = cap(
    c,
    "correlated_exposure",
    allowed,
    (eq * k.max_correlated_exposure_pct) / 100 - correlated,
    `correlated with ${p.correlatedHeld.length ? p.correlatedHeld.join(", ") : "nothing held"} (${pct((correlated / eq) * 100)}, max ${k.max_correlated_exposure_pct}%)`,
  )
  allowed = cap(
    c,
    "strategy_exposure",
    allowed,
    (eq * settings.strategies[p.strategyId].max_exposure_pct) / 100 - strategyExposure,
    `${p.strategyId} exposure (max ${settings.strategies[p.strategyId].max_exposure_pct}%)`,
  )
  // Keep a small cash buffer so fees and price drift never overdraw the account.
  allowed = cap(c, "cash", allowed, (account.cashUsd * 0.995) / feeFactor, `cash $${account.cashUsd.toFixed(2)}`)

  const qty = p.roundQty(allowed / p.limitPrice)
  const minIssue = p.minViolation(qty, p.limitPrice)
  c.check("venue_minimum", minIssue === null, minIssue ?? "meets venue minimums")
  const resized = qty < p.qty - 1e-12
  if (c.failed.length) return { approved: false, resized, qty: 0, notionalUsd: 0, checks: c.list, reasons: c.failed.map((f) => f.detail) }
  return { approved: true, resized, qty, notionalUsd: qty * p.limitPrice, checks: c.list, reasons: resized ? [`resized from ${p.qty} to ${qty} by exposure limits`] : [] }
}

export type ExitReason = "ai" | "stop_loss" | "take_profit" | "kill_switch" | "drawdown" | "manual"

/**
 * Exits reduce risk, so they're allowed while paused or halted. The one restriction is churn
 * control: the AI can't discretionarily close a position younger than `min_hold_minutes`.
 * Deterministic exits (stops, kill switch, manual) are never blocked.
 */
export const evaluateExit = ({
  reason,
  openedAt,
  venueOnline,
  minHoldMinutes,
  now = Date.now(),
}: {
  reason: ExitReason
  openedAt: number
  venueOnline: boolean
  minHoldMinutes: number
  now?: number
}): { approved: boolean; checks: RiskCheck[]; reasons: string[] } => {
  const c = new Checks()
  c.check("venue_online", venueOnline, venueOnline ? "online" : "venue offline")
  if (reason === "ai") {
    const ageMin = (now - openedAt) / 60_000
    c.check("min_hold", ageMin >= minHoldMinutes, `position is ${Math.floor(ageMin)} min old (AI exits allowed after ${minHoldMinutes} min)`)
  }
  return { approved: c.failed.length === 0, checks: c.list, reasons: c.failed.map((f) => f.detail) }
}
