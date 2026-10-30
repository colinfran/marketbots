import { checkEntry, entryRoomUsd, type EnvelopeHistory } from "@mb/agent/envelope"
import type { HistoryStore } from "@mb/history/store"
import type { AlpacaAccount, AlpacaPosition } from "@mb/stock-core/alpaca"
import type { ChainContract, RiskState } from "@mb/stock-core/context"
import { formatTime, marketDay, marketTime, minutesBetween } from "@mb/stock-core/time"
import type { WireCategory } from "@mb/stock-core/wire"
import type { EngineContext } from "../bot/context"
import { isSessionOpen, type Session } from "../bot/session"

/**
 * What the stock agent works with: the engine's context, the session, live prices (the broker's
 * stream, else the news engine's price layers) and the history store. It trades the paper account
 * (./live), read from the engine's latest account snapshot.
 */

export type StockAgentDeps = {
  ctx: EngineContext
  history: HistoryStore<WireCategory> | null
  session: () => Session | null
  /** The latest price no older than five minutes: the broker's stream, else the price layers. */
  price: (symbol: string) => number | null
  /** The broker's account and positions as the engine last read them (every 15 s); null before the first read. */
  snapshot: () => { account: AlpacaAccount; positions: AlpacaPosition[] } | null
  /** The option contracts each episode's option_menu calls offered (an entry must use them), by episode id. */
  offered: Map<string, Map<string, ChainContract>>
  /** The price at the agent's last decision on a held stock, for the price-move wake-ups. */
  reviews: Map<string, { price: number; at: Date }>
}

/** The price a buy would pay (the ask) and a sale would get (the bid), falling back to the last price. */
export const sidePrices = (d: Pick<StockAgentDeps, "ctx" | "price">, symbol: string) => {
  const live = d.ctx.prices.get(symbol)
  const last = d.price(symbol)
  if (last === null) return null
  return { last, ask: live?.ask && live.ask >= last * 0.98 ? live.ask : last, bid: live?.bid && live.bid <= last * 1.02 ? live.bid : last }
}

export type SessionWindow = { open: boolean; entries: boolean; closing: boolean; reason: string }

/** Whether the agent may trade now: the regular session, buys past the opening buffer; `closing` is the closing window. */
export const sessionWindow = (d: Pick<StockAgentDeps, "ctx" | "session">, now = new Date()): SessionWindow => {
  const s = d.session()
  const sch = d.ctx.settings.current.schedule
  if (!s || !isSessionOpen(s, now)) return { open: false, entries: false, closing: false, reason: "outside the regular session" }
  if (-minutesBetween(now, s.open!) < sch.open_buffer_minutes) return { open: true, entries: false, closing: false, reason: `inside the opening buffer (until ${formatTime(new Date(s.open!.getTime() + sch.open_buffer_minutes * 60_000))})` }
  const closing = minutesBetween(now, s.close!) <= sch.close_window_minutes
  return { open: true, entries: true, closing, reason: closing ? "the closing window" : "the regular session" }
}

/** Midnight in New York on the trading day a moment falls in. */
export const dayStart = (now: Date) => marketTime(marketDay(now), "00:00")

/** The market's state and the limits code enforces. `blocked` lists why buys can't happen at all. */
export const limitsText = (d: Pick<StockAgentDeps, "ctx" | "session">, { risk, history, blocked }: { risk: RiskState; history: EnvelopeHistory; blocked: string[] }, now = new Date()) => {
  const r = d.ctx.settings.current.risk
  const window = sessionWindow(d, now)
  const env = d.ctx.settings.current.agent.envelope
  const envelope = checkEntry("", history, env, now.getTime())
  const room = entryRoomUsd(Number.POSITIVE_INFINITY, history, env, now.getTime())
  return [
    "LIMITS (enforced by code)",
    `- Market: ${window.reason}. New buys: ${blocked.length ? `blocked (${blocked.join("; ")})` : envelope.approved ? "allowed" : `blocked by your envelope (${envelope.reason})`}.`,
    `- Your envelope: ${history.entries.length}/${env.entries_per_day} entries in 24 h, ${history.entries.filter((e) => now.getTime() - e.at < 3_600_000).length}/${env.entries_per_hour} in the last hour, ${history.openPositions}/${env.max_open_positions} open; $${room.toFixed(0)} more can be committed this hour; an entry is ${env.size_pct}% of what the risk checks allow; one action per ticker per ${env.symbol_action_minutes} min; no re-entry for ${env.reentry_after_stop_hours} h after a stop-out or ${env.flip_hours} h after an exit.`,
    `- Risk checks: at most ${risk.max_position_pct}% of equity per position ($${risk.max_position_usd}); ${risk.open_positions}/${risk.max_open_positions} positions; conviction ≥ ${r.min_conviction}/10 (≥ 8 for an overnight buy in the closing window, and none intraday then); price ≥ $${r.min_price}; stop ${r.min_stop_pct}-${r.max_stop_pct}% below the price (default ${r.default_stop_pct}%); reward:risk ≥ ${r.min_reward_risk}; no rebuy within ${r.rebuy_cooldown_minutes} min of a sale; $${risk.deployable_cash} deployable cash.`,
  ]
}

