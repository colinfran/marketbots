import { checkEntry, entryRoomUsd } from "@mb/agent/envelope"
import type { EpisodeInfo } from "@mb/agent/runtime"
import type { AgentAction } from "@mb/core/agent"
import { normalizeStockAgentDecisions, type StockAgentAnswer, type StockAgentDecision } from "@mb/stock-core/agent"
import { evaluateStockBuy, heldExitBounds, ratchetStop, resolveExits } from "../bot/execute"
import { sessionWindow, shadowRiskState, sidePrices, type StockAgentDeps } from "./book"

/**
 * The stock agent's decisions into the shadow book (docs/plans/LOCAL-AI.md §8.4, §8.7, §9):
 * normalized with the cycle's rules, then sales first, exit changes, holds, and buys by conviction.
 * A buy happens only in the regular session after the opening buffer (the closing window is the
 * cycle's close phase), passes the envelope's rate limits, then the cycle's own buy rules
 * (evaluateStockBuy) against the shadow book's account, and is cut to the envelope's share. Sales
 * fill only while the market is open; they and exit changes are never rate-limited. Stops only
 * move up.
 */

const ORDER: Record<StockAgentDecision["action"], number> = { sell: 0, adjust_exits: 1, hold: 2, buy: 3 }

const action = (d: StockAgentDecision, outcome: AgentAction["outcome"], detail: string | null): AgentAction => ({ symbol: d.symbol, action: d.action, conviction: d.conviction, outcome, detail })

export const actOnStockAnswer = async (d: StockAgentDeps, answer: StockAgentAnswer, episode: Pick<EpisodeInfo, "id">, known: (symbol: string) => boolean): Promise<AgentAction[]> => {
  const { ctx, shadow } = d
  const r = ctx.settings.current.risk
  const held = new Map((await shadow.open()).map((p) => [p.symbol, p]))
  const { decisions, dropped } = normalizeStockAgentDecisions(answer.decisions, { known: (s) => held.has(s) || known(s) })
  const out: AgentAction[] = dropped.map((why) => ({ symbol: why.split(":")[0], action: "unknown", conviction: 0, outcome: "rejected", detail: why }))
  const window = sessionWindow(d)
  for (const dec of [...decisions].sort((a, b) => ORDER[a.action] - ORDER[b.action] || b.conviction - a.conviction)) {
    const position = held.get(dec.symbol) ?? null
    const prices = sidePrices(d, dec.symbol)
    if (dec.action === "hold") {
      if (!position) {
        out.push(action(dec, "not_applicable", "not held"))
        continue
      }
      await shadow.update(position, { reviewedPrice: prices?.last ?? position.mark_price })
      out.push(action(dec, "held", null))
      continue
    }
    if (dec.action === "adjust_exits") {
      if (!position) {
        out.push(action(dec, "rejected", "not currently held"))
        continue
      }
      if (!prices) {
        out.push(action(dec, "rejected", "no current price"))
        continue
      }
      const exits = resolveExits(prices.last, ratchetStop(dec.stop_loss, { stop_loss: position.stop_price }), dec.take_profit ?? position.take_profit_price, r, heldExitBounds(r))
      if (position.stop_price !== null && exits.stop < position.stop_price - 0.005) {
        out.push(action(dec, "rejected", `stop would move down from ${position.stop_price} to ${exits.stop}; stops only move up`))
        continue
      }
      const u = await shadow.update(position, { stop: exits.stop, target: exits.target, reviewedPrice: prices.last })
      out.push(action(dec, "updated", [`stop ${u.stop}, target ${u.target}`, ...exits.notes].join("; ")))
      continue
    }
    if (dec.action === "sell") {
      if (!position) {
        out.push(action(dec, "rejected", "not currently held"))
        continue
      }
      if (!window.open || !prices) {
        out.push(action(dec, "rejected", window.open ? "no current price" : "the market is closed: sales fill only in the regular session"))
        continue
      }
      const pct = dec.sell_pct ?? 100
      const qty = pct >= 99.5 ? position.qty : Math.max(1, Math.floor((position.qty * pct) / 100))
      const fill = await shadow.sell(position, { qty, reference: prices.bid, reason: qty >= position.qty ? "exit" : "reduce", episodeId: episode.id })
      if (fill && qty < position.qty) await shadow.update({ ...position, qty: position.qty - qty }, { reviewedPrice: prices.last })
      out.push(fill ? action(dec, "filled", `sold ${fill.qty} at ${fill.price.toFixed(2)}`) : action(dec, "rejected", "nothing to sell"))
      continue
    }
    out.push(await buy(d, dec, episode.id, position !== null))
  }
  return out
}

const buy = async (d: StockAgentDeps, dec: StockAgentDecision, episodeId: string, isHeld: boolean): Promise<AgentAction> => {
  const { ctx, shadow } = d
  const settings = ctx.settings.current
  const window = sessionWindow(d)
  if (!window.entries) return action(dec, "blocked", `buys only in the regular session after the opening buffer (now: ${window.reason})`)
  const prices = sidePrices(d, dec.symbol)
  const now = Date.now()
  const { risk, history, open } = await shadowRiskState(d)
  const envelope = checkEntry(dec.symbol, history, settings.agent.envelope, now)
  if (!envelope.approved) return action(dec, "blocked", `envelope: ${envelope.reason}`)
  const lastExit = history.lastExit.get(dec.symbol)
  const evaluation = evaluateStockBuy({
    decision: dec,
    phase: window.closing ? "close" : "intraday",
    risk,
    settings,
    entriesBlocked: null,
    held: isHeld,
    openCount: open.length,
    newBuys: 0,
    tradesLeft: risk.trades_remaining,
    recentlySold: lastExit !== undefined && now - lastExit < settings.risk.rebuy_cooldown_minutes * 60_000,
    asset: await ctx.alpaca.getAsset(dec.symbol).catch(() => null),
    price: prices?.last ?? null,
    cash: risk.deployable_cash,
  })
  if (!evaluation.approved || !evaluation.exits || !prices) return action(dec, "rejected", evaluation.reason ?? "rejected")
  const room = entryRoomUsd(evaluation.qty * prices.ask, history, settings.agent.envelope, now)
  const qty = Math.floor(room / prices.ask)
  if (qty < 1) return action(dec, "blocked", `envelope: $${room.toFixed(0)} of room buys less than one share at ${prices.ask}`)
  const r = await shadow.buy({
    symbol: dec.symbol,
    qty,
    reference: prices.ask,
    episodeId,
    stop: evaluation.exits.stop,
    target: evaluation.exits.target,
    horizon: dec.horizon,
    strategy: dec.setup,
    thesis: dec.rationale,
    invalidation: dec.invalidation,
    conviction: dec.conviction,
  })
  if (!r.ok) return action(dec, "rejected", r.reason)
  return action(dec, "filled", [`bought ${qty} at ${r.fill.price.toFixed(2)} ($${(qty * r.fill.price).toFixed(2)}), stop ${evaluation.exits.stop}, target ${evaluation.exits.target}`, ...evaluation.exits.notes].join("; "))
}
