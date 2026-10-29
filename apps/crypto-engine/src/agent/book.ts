import { ShadowBook } from "@mb/agent/shadow"
import { checkEntry, entryRoomUsd, type EnvelopeHistory } from "@mb/agent/envelope"
import type { ShadowPositionDoc } from "@mb/core/agent"
import { utcDay } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import type { HistoryStore } from "@mb/history/store"
import type { WireCategory } from "@mb/crypto-core/wire"
import type { EngineContext } from "../orchestrator/context"
import type { AccountState, Gate } from "../risk/engine"
import { formatPrice, roundPrice } from "../venues/kraken/pairs"

/**
 * What the crypto agent works with: the engine's context, its shadow book and the history store.
 * The shadow book fills at the paper wallet's own fee and slippage, so its results compare with
 * the timed cycles' book.
 */

export type CryptoAgentDeps = {
  ctx: EngineContext
  shadow: ShadowBook
  history: HistoryStore<WireCategory> | null
}

export const createShadowBook = (ctx: EngineContext) =>
  new ShadowBook(ctx.col, {
    startingUsd: () => ctx.settings.current.agent.shadow_starting_usd,
    costs: () => ({ feeBps: ctx.feeBps(), slippageBps: ctx.settings.current.kraken.paper_slippage_bps }),
    bus: ctx.bus,
    day: (d) => utcDay(d),
    roundPrice: (symbol, price) => {
      const pair = ctx.hub.pairs.get(symbol)
      return pair ? roundPrice(pair, price) : roundTo(price, 6)
    },
  })

export const mid = (ctx: EngineContext) => (symbol: string) => ctx.hub.quote(symbol)?.mid ?? null

/** The risk engine's gate for the shadow book: the engine's run state and the venue; the paper wallet's reconciliation is the live book's business. */
export const shadowGate = (ctx: EngineContext): Gate => ({ ...ctx.gate(), reconciled: true })

/** The shadow book as the risk engine sees an account. */
export const shadowRiskState = async (d: CryptoAgentDeps, now = new Date()): Promise<{ state: AccountState; history: EnvelopeHistory; open: ShadowPositionDoc[] }> => {
  const account = await d.shadow.account(mid(d.ctx))
  const [open, history, tradesToday] = await Promise.all([
    d.shadow.open(),
    d.shadow.envelopeHistory(account.equity_usd),
    d.ctx.col.shadowFills.countDocuments({ at: { $gte: new Date(`${utcDay(now)}T00:00:00.000Z`) }, $or: [{ side: "buy" }, { episode_id: { $ne: null } }] }),
  ])
  return {
    state: {
      equityUsd: account.equity_usd,
      cashUsd: account.cash_usd,
      dayStartEquityUsd: account.day_start_equity_usd,
      peakEquityUsd: account.peak_equity_usd,
      positions: open.map((p) => ({ instrument: p.symbol, symbol: p.symbol, valueUsd: p.qty * (mid(d.ctx)(p.symbol) ?? p.mark_price ?? p.entry_price), strategyId: (p.strategy as AccountState["positions"][number]["strategyId"]) ?? null })),
      tradesToday,
      lastExitAt: history.lastExit,
    },
    history,
    open,
  }
}

const price = (d: CryptoAgentDeps, symbol: string, p: number | null) => {
  if (p === null) return "n/a"
  const pair = d.ctx.hub.pairs.get(symbol)
  return pair ? formatPrice(pair, p) : String(roundTo(p, 6))
}

/** YOUR BOOK and LIMITS: the brief's account part, also the `book` tool's answer. */
export const bookText = async (d: CryptoAgentDeps, now = new Date()) => {
  const s = d.ctx.settings.current
  const k = s.kraken
  const { state, history, open } = await shadowRiskState(d, now)
  const account = await d.shadow.account(mid(d.ctx))
  const lines = open.map((p) => {
    const m = mid(d.ctx)(p.symbol)
    const pnl = m ? ((m / p.entry_price - 1) * 100).toFixed(2) : "n/a"
    const hours = ((now.getTime() - p.opened_at.getTime()) / 3_600_000).toFixed(1)
    return `- ${p.symbol}: ${p.qty} at ${price(d, p.symbol, p.entry_price)}, now ${price(d, p.symbol, m)} (${pnl}%), stop ${price(d, p.symbol, p.stop_price)}, target ${price(d, p.symbol, p.take_profit_price)}, held ${hours} h of an expected ${p.horizon ?? "?"} h, ${p.strategy ?? "no strategy"}, conviction ${p.conviction}. Thesis: ${p.thesis} Invalidation: ${p.invalidation}`
  })
  const gate = shadowGate(d.ctx)
  const blocked = [
    gate.runStatus !== "running" ? `the engine is ${gate.runStatus}` : null,
    gate.killSwitch ? "the kill switch is engaged" : null,
    gate.venueOnline ? null : "Kraken data or the paper wallet is unavailable",
  ].filter(Boolean)
  const env = s.agent.envelope
  const envelope = checkEntry("", history, env, now.getTime())
  const room = entryRoomUsd(Number.POSITIVE_INFINITY, history, env, now.getTime())
  const maxPosition = (state.equityUsd * k.max_position_pct) / 100
  return [
    `YOUR BOOK (shadow; started with $${account.starting_usd.toLocaleString("en-US")})`,
    `cash $${account.cash_usd.toFixed(2)} · equity $${account.equity_usd.toFixed(2)} (${account.return_pct >= 0 ? "+" : ""}${account.return_pct}%) · realized $${account.realized_pnl_usd.toFixed(2)} · ${account.open_positions} open, ${account.closed_positions} closed`,
    ...(lines.length ? lines : ["- no open positions"]),
    "",
    "LIMITS (enforced by code)",
    `- New entries: ${blocked.length ? `blocked (${blocked.join("; ")})` : envelope.approved ? "allowed" : `blocked by your envelope (${envelope.reason})`}.`,
    `- Your envelope: ${history.entries.length}/${env.entries_per_day} entries in 24 h, ${history.entries.filter((e) => now.getTime() - e.at < 3_600_000).length}/${env.entries_per_hour} in the last hour, ${history.openPositions}/${env.max_open_positions} open; $${room.toFixed(0)} more can be committed this hour; an entry is ${env.size_pct}% of what the risk checks allow; one action per pair per ${env.symbol_action_minutes} min; no re-entry for ${env.reentry_after_stop_hours} h after a stop-out or ${env.flip_hours} h after an exit.`,
    `- Risk checks: lose at most ${k.risk_per_trade_pct}% of equity at the stop; at most ${k.max_position_pct}% of equity in one position ($${maxPosition.toFixed(0)}); reward:risk ≥ ${k.min_reward_risk}; edge after costs ≥ ${k.min_edge_bps} bps; conviction ≥ ${k.min_conviction}; stop ${k.min_stop_pct}-${k.max_stop_pct}% below the price; spread ≤ ${k.max_spread_bps} bps; positions held at least ${k.min_hold_minutes} min before you can close them.`,
    `- Costs: taker fee ${d.ctx.feeBps()} bps a side plus ${k.paper_slippage_bps} bps slippage, and the spread.`,
  ].join("\n")
}
