import { checkEntry, entryRoomUsd, type EnvelopeHistory } from "@mb/agent/envelope"
import { ShadowBook } from "@mb/agent/shadow"
import type { ShadowPositionDoc } from "@mb/core/agent"
import type { HistoryStore } from "@mb/history/store"
import type { AlpacaAccount } from "@mb/stock-core/alpaca"
import type { RiskState } from "@mb/stock-core/context"
import { roundTo } from "@mb/stock-core/math"
import { formatTime, marketDay, marketTime, minutesBetween } from "@mb/stock-core/time"
import type { WireCategory } from "@mb/stock-core/wire"
import type { EngineContext } from "../bot/context"
import { computeRiskState } from "../bot/risk"
import { isSessionOpen, type Session } from "../bot/session"

/**
 * What the stock agent works with: the engine's context, the session, live prices (the broker's
 * stream, else the news engine's price layers), its shadow book and the history store.
 *
 * The shadow book fills at the quote's ask or bid (the last price where there is no quote) plus
 * SHADOW_SLIPPAGE_BPS, commission-free like Alpaca. Whole shares only.
 */

export const SHADOW_SLIPPAGE_BPS = 5

export type StockAgentDeps = {
  ctx: EngineContext
  shadow: ShadowBook
  history: HistoryStore<WireCategory> | null
  session: () => Session | null
  /** The latest price no older than five minutes: the broker's stream, else the price layers. */
  price: (symbol: string) => number | null
}

export const createShadowBook = (ctx: EngineContext) =>
  new ShadowBook(ctx.col, {
    startingUsd: () => ctx.settings.current.agent.shadow_starting_usd,
    costs: () => ({ feeBps: 0, slippageBps: SHADOW_SLIPPAGE_BPS }),
    bus: ctx.bus,
    day: (d) => marketDay(d),
    roundPrice: (_s, p) => roundTo(p, 2),
  })

/** The price a buy would pay (the ask) and a sale would get (the bid), falling back to the last price. */
export const sidePrices = (d: StockAgentDeps, symbol: string) => {
  const live = d.ctx.prices.get(symbol)
  const last = d.price(symbol)
  if (last === null) return null
  return { last, ask: live?.ask && live.ask >= last * 0.98 ? live.ask : last, bid: live?.bid && live.bid <= last * 1.02 ? live.bid : last }
}

export type SessionWindow = { open: boolean; entries: boolean; closing: boolean; reason: string }

/** Whether the agent may trade now: the regular session, past the opening buffer; the closing window is the cycle's close phase. */
export const sessionWindow = (d: StockAgentDeps, now = new Date()): SessionWindow => {
  const s = d.session()
  const sch = d.ctx.settings.current.schedule
  if (!s || !isSessionOpen(s, now)) return { open: false, entries: false, closing: false, reason: "outside the regular session" }
  if (-minutesBetween(now, s.open!) < sch.open_buffer_minutes) return { open: true, entries: false, closing: false, reason: `inside the opening buffer (until ${formatTime(new Date(s.open!.getTime() + sch.open_buffer_minutes * 60_000))})` }
  const closing = minutesBetween(now, s.close!) <= sch.close_window_minutes
  return { open: true, entries: true, closing, reason: closing ? "the closing window" : "the regular session" }
}

/** The shadow book as the cycle's risk rules see an account (computeRiskState, from the book's own equity and cash). */
export const shadowRiskState = async (d: StockAgentDeps, now = new Date()): Promise<{ risk: RiskState; history: EnvelopeHistory; open: ShadowPositionDoc[] }> => {
  const account = await d.shadow.account(d.price)
  const [open, history, tradesToday] = await Promise.all([
    d.shadow.open(),
    d.shadow.envelopeHistory(account.equity_usd),
    d.ctx.col.shadowFills.countDocuments({ at: { $gte: dayStart(now) }, $or: [{ side: "buy" }, { episode_id: { $ne: null } }] }),
  ])
  // computeRiskState reads only these three fields of the broker's account.
  const pseudo = { equity: String(account.equity_usd), cash: String(account.cash_usd), last_equity: String(account.day_start_equity_usd) } as AlpacaAccount
  const settings = { ...d.ctx.settings.current, account: { starting_capital: account.starting_usd } }
  return { risk: computeRiskState(pseudo, open.length, tradesToday, settings), history, open }
}

/** Midnight in New York on the trading day a moment falls in. */
const dayStart = (now: Date) => marketTime(marketDay(now), "00:00")

/** YOUR BOOK and LIMITS: the brief's account part, also the `book` tool's answer. */
export const bookText = async (d: StockAgentDeps, now = new Date()) => {
  const r = d.ctx.settings.current.risk
  const { risk, history, open } = await shadowRiskState(d, now)
  const account = await d.shadow.account(d.price)
  const window = sessionWindow(d, now)
  const lines = open.map((p) => {
    const m = d.price(p.symbol)
    const pnl = m ? ((m / p.entry_price - 1) * 100).toFixed(2) : "n/a"
    return `- ${p.symbol}: ${p.qty} shares at ${p.entry_price.toFixed(2)}, now ${m ?? "n/a"} (${pnl}%), stop ${p.stop_price ?? "none"}, target ${p.take_profit_price ?? "none"}, ${p.horizon ?? "?"} horizon, opened ${formatTime(p.opened_at)}, conviction ${p.conviction}/10. Thesis: ${p.thesis} Invalidation: ${p.invalidation}`
  })
  const st = d.ctx.state.state
  const blocked = [st.kill_switch.engaged ? "the kill switch is engaged" : null, st.status !== "running" ? `trading is ${st.status}` : null, window.entries ? null : window.reason, risk.new_buys_allowed ? null : risk.notes.join(" ")].filter(Boolean)
  const env = d.ctx.settings.current.agent.envelope
  const envelope = checkEntry("", history, env, now.getTime())
  const room = entryRoomUsd(Number.POSITIVE_INFINITY, history, env, now.getTime())
  return [
    `YOUR BOOK (shadow; started with $${account.starting_usd.toLocaleString("en-US")})`,
    `cash $${account.cash_usd.toFixed(2)} · equity $${account.equity_usd.toFixed(2)} (${account.return_pct >= 0 ? "+" : ""}${account.return_pct}%) · today ${risk.day_pnl_pct >= 0 ? "+" : ""}${risk.day_pnl_pct}% · realized $${account.realized_pnl_usd.toFixed(2)} · ${account.open_positions} open, ${account.closed_positions} closed`,
    ...(lines.length ? lines : ["- no open positions"]),
    "",
    "LIMITS (enforced by code)",
    `- Market: ${window.reason}. New buys: ${blocked.length ? `blocked (${blocked.join("; ")})` : envelope.approved ? "allowed" : `blocked by your envelope (${envelope.reason})`}.`,
    `- Your envelope: ${history.entries.length}/${env.entries_per_day} entries in 24 h, ${history.entries.filter((e) => now.getTime() - e.at < 3_600_000).length}/${env.entries_per_hour} in the last hour, ${history.openPositions}/${env.max_open_positions} open; $${room.toFixed(0)} more can be committed this hour; an entry is ${env.size_pct}% of what the risk checks allow; one action per ticker per ${env.symbol_action_minutes} min; no re-entry for ${env.reentry_after_stop_hours} h after a stop-out or ${env.flip_hours} h after an exit.`,
    `- Risk checks: at most ${risk.max_position_pct}% of equity per position ($${risk.max_position_usd}); ${risk.open_positions}/${risk.max_open_positions} positions; conviction ≥ ${r.min_conviction}/10 (≥ 8 for an overnight buy in the closing window, and none intraday then); price ≥ $${r.min_price}; stop ${r.min_stop_pct}-${r.max_stop_pct}% below the price (default ${r.default_stop_pct}%); reward:risk ≥ ${r.min_reward_risk}; no rebuy within ${r.rebuy_cooldown_minutes} min of a sale; $${risk.deployable_cash} deployable cash.`,
    "- Intraday positions are closed by code in the last minutes of the session. Trades fill at the ask or bid plus 5 bps, commission-free.",
  ].join("\n")
}
