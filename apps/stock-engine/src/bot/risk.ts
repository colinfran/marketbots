import type { AlpacaAccount } from "@mb/stock-core/alpaca"
import type { RiskState } from "@mb/stock-core/context"
import type { Settings } from "@mb/stock-core/settings"
import { round } from "../market/indicators"

export type { RiskState }

/**
 * Deterministic risk state. Grok is told these numbers, and the execution engine enforces them
 * no matter what Grok asks for.
 */

export const computeRiskState = (account: AlpacaAccount, openPositions: number, tradesToday: number, settings: Settings): RiskState => {
  const r = settings.risk
  const startingCapital = settings.account.starting_capital
  const equity = Number(account.equity)
  const cash = Number(account.cash)
  const startOfDay = Number(account.last_equity) || equity
  const dayPnl = equity - startOfDay
  const dayPnlPct = startOfDay > 0 ? (dayPnl / startOfDay) * 100 : 0

  const circuitBreaker = dayPnlPct <= -r.max_daily_loss_pct
  const killSwitch = dayPnlPct <= -r.flatten_loss_pct
  const profitLock = dayPnlPct >= r.profit_lock_pct
  const maxPositionPct = profitLock ? r.max_position_pct / 2 : r.max_position_pct
  const tradesRemaining = Math.max(0, r.max_trades_per_day - tradesToday)
  // Cash only: never touch margin buying power.
  const deployable = Math.max(0, Math.min(cash, equity) - (equity * r.cash_reserve_pct) / 100)

  const notes: string[] = []
  if (killSwitch) notes.push(`KILL SWITCH: day P&L ${dayPnlPct.toFixed(2)}% <= -${r.flatten_loss_pct}%. Everything is being liquidated.`)
  else if (circuitBreaker) notes.push(`CIRCUIT BREAKER: day P&L ${dayPnlPct.toFixed(2)}% <= -${r.max_daily_loss_pct}%. No new buys today; only manage/exit positions.`)
  if (profitLock) notes.push(`PROFIT LOCK: up ${dayPnlPct.toFixed(2)}% today. New positions are capped at ${maxPositionPct}% of equity; protect the green day (tighten stops, take profits).`)
  if (tradesRemaining === 0) notes.push("Daily trade limit reached: no new orders except risk-reducing exits.")
  if (openPositions >= r.max_open_positions) notes.push(`Max open positions (${r.max_open_positions}) reached: sell a stock before buying another.`)

  return {
    equity: round(equity)!,
    cash: round(cash)!,
    start_of_day_equity: round(startOfDay)!,
    day_pnl: round(dayPnl)!,
    day_pnl_pct: round(dayPnlPct)!,
    total_return_pct: round(((equity - startingCapital) / startingCapital) * 100)!,
    deployable_cash: round(deployable)!,
    max_position_pct: maxPositionPct,
    max_position_usd: round((equity * maxPositionPct) / 100)!,
    open_positions: openPositions,
    max_open_positions: r.max_open_positions,
    trades_today: tradesToday,
    trades_remaining: tradesRemaining,
    circuit_breaker: circuitBreaker,
    profit_lock: profitLock,
    kill_switch: killSwitch,
    new_buys_allowed: !circuitBreaker && !killSwitch && tradesRemaining > 0 && openPositions < r.max_open_positions,
    notes,
  }
}
