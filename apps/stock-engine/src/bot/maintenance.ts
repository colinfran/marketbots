import type { AlpacaPosition } from "@mb/stock-core/alpaca"
import { bookOf, type PositionPlanDoc } from "@mb/stock-core/db"
import { marketDay, minutesBetween } from "@mb/stock-core/time"
import { errorMessage } from "@mb/engine-kit/log"
import { placeCoreStop } from "../core-book/execute"
import { initialCoreStop } from "../core-book/rules"
import type { TradingContext } from "./context"
import { cancelSymbolOrders, heldExitBounds, placeExitOrders, resolveExits } from "./execute"
import { liquidateOptions, reconcileOptions } from "./options"
import { clientId, loadRealizedFills, syncOrders } from "./orders"
import { computeRiskState } from "./risk"
import { isSessionOpen, type Session } from "./session"

/**
 * Cheap, AI-free upkeep the engine runs every minute:
 * - sync orders from Alpaca (records stop/target fills the trade stream may have missed)
 * - the daily loss limit: liquidate everything if the day's loss breaches flatten_loss_pct
 * - make sure every stock position has protective exit orders
 * - overnight rules as a fallback if the closing cycle never ran
 * - compare the options books with the broker
 * - housekeeping (plans for closed positions)
 */

const isStock = (p: AlpacaPosition) => (p.asset_class ?? "us_equity") === "us_equity"

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const flatten = async (ctx: TradingContext, positions: AlpacaPosition[], why = ""): Promise<string[]> => {
  const notes: string[] = []
  for (const { symbol, qty } of positions) {
    try {
      await cancelSymbolOrders(ctx.alpaca, symbol)
      const order = await ctx.alpaca.submitOrder({ symbol, qty, side: "sell", type: "market", time_in_force: "day", client_order_id: clientId("flat") })
      ctx.bus.emit(
        "order.submitted",
        { order_id: order.id, symbol, side: "sell", type: "market", qty: Number(qty), limit_price: null, purpose: why ? `liquidation${why}` : "liquidation", asset_class: "us_equity" },
        { summary: `Selling ${qty} ${symbol}${why}`, instrument: symbol },
      )
      await ctx.col.plans.deleteOne({ _id: symbol })
      notes.push(`flattened ${symbol}${why}`)
    } catch (error) {
      notes.push(`failed to flatten ${symbol}: ${errorMessage(error)}`)
      await ctx.alerts.send("error", `Failed to sell ${symbol}`, errorMessage(error), { path: `/markets/${symbol}` })
    }
  }
  return notes
}

/** Sells every stock position (cancelling its exits first). */
export const flattenStocks = async (ctx: TradingContext, why = "") => flatten(ctx, (await ctx.alpaca.getPositions()).filter((p) => isStock(p) && p.side === "long"), why)

/**
 * Places OCO exits on any whole-share stock position that has no open sell orders, at its plan's
 * levels (or defaults). A position already at or through its plan's stop is sold instead: that's a
 * stop-out, and protecting it would mean a lower stop.
 */
export const ensureProtection = async (ctx: TradingContext): Promise<string[]> => {
  const { alpaca, col, settings, bus, alerts } = ctx
  const r = settings.current.risk
  const [positions, openOrders, plans] = await Promise.all([alpaca.getPositions(), alpaca.listOrders({ status: "open", limit: 200 }), col.plans.find().toArray()])
  const protectedSymbols = new Set(openOrders.filter((o) => o.side === "sell").map((o) => o.symbol))
  const planBySymbol = new Map(plans.map((p) => [p._id, p]))
  const notes: string[] = []

  for (const position of positions) {
    if (!isStock(position) || position.side !== "long" || protectedSymbols.has(position.symbol)) continue
    const qty = Math.floor(Number(position.qty_available || position.qty))
    if (qty < 1) continue
    const price = Number(position.current_price)
    const plan = planBySymbol.get(position.symbol)
    if (plan && bookOf(plan) === "core") {
      notes.push(...(await protectCore(ctx, position, qty, plan)))
      continue
    }
    const exits = resolveExits(price, plan?.stop_loss ?? null, plan?.take_profit ?? null, r, heldExitBounds(r))
    if (plan?.stop_loss != null && exits.stop < plan.stop_loss - 0.005) {
      bus.emit("protection.triggered", { symbol: position.symbol, kind: "unprotected_stop", price, structure_id: null }, { summary: `${position.symbol} is through its ${plan.stop_loss} stop with no exit orders; selling`, level: "warn", instrument: position.symbol })
      const sold = await flatten(ctx, [position], ` (price ${price} reached its ${plan.stop_loss} stop with no exit orders)`)
      notes.push(...sold)
      if (sold[0].startsWith("flattened")) {
        await alerts.send("warning", `${position.symbol} sold: its stop was hit while unprotected`, sold[0], { path: `/markets/${position.symbol}` })
      }
      continue
    }
    try {
      await placeExitOrders(ctx, position.symbol, qty, exits.stop, exits.target, plan?.decision_id ?? null)
      await col.plans.updateOne(
        { _id: position.symbol },
        {
          $set: { stop_loss: exits.stop, take_profit: exits.target, updated_at: new Date() },
          $setOnInsert: {
            decision_id: null,
            horizon: "overnight",
            setup: "other",
            thesis: "Adopted position with no plan on record.",
            invalidation: "Stop-loss hit.",
            opened_at: new Date(),
          },
        },
        { upsert: true },
      )
      notes.push(`protected ${position.symbol}: stop ${exits.stop}, target ${exits.target}`)
    } catch (error) {
      notes.push(`could not protect ${position.symbol}: ${errorMessage(error)}`)
      await alerts.send("error", `${position.symbol} has no stop-loss`, `Placing protective exit orders failed: ${errorMessage(error)}`, {
        fields: { Shares: qty, Stop: exits.stop, Target: exits.target },
        path: `/markets/${position.symbol}`,
      })
    }
  }
  return notes
}

/**
 * A core holding with no resting sell order gets its plain GTC stop back, at its plan's level (or
 * the initial core stop when it has none): no take-profit, and no trading-stop bounds. At or
 * through its stop, it's sold instead, like a trading position.
 */
const protectCore = async (ctx: TradingContext, position: AlpacaPosition, qty: number, plan: PositionPlanDoc): Promise<string[]> => {
  const { symbol } = position
  const price = Number(position.current_price)
  const stop = plan.stop_loss ?? initialCoreStop(Number(position.avg_entry_price), price, ctx.settings.current.core.stop_pct)
  if (price <= stop) {
    ctx.bus.emit("protection.triggered", { symbol, kind: "unprotected_stop", price, structure_id: null }, { summary: `${symbol} (core) is through its ${stop} stop with no stop order; selling`, level: "warn", instrument: symbol })
    const sold = await flatten(ctx, [position], ` (core: price ${price} reached its ${stop} stop with no stop order)`)
    if (sold[0].startsWith("flattened")) await ctx.alerts.send("warning", `${symbol} sold: its core stop was hit while unprotected`, sold[0], { path: "/core" })
    return sold
  }
  try {
    await placeCoreStop(ctx, symbol, qty, stop, plan.decision_id)
    if (plan.stop_loss === null) await ctx.col.plans.updateOne({ _id: symbol }, { $set: { stop_loss: stop, updated_at: new Date() } })
    return [`protected ${symbol} (core): stop ${stop}`]
  } catch (error) {
    await ctx.alerts.send("error", `${symbol} (core) has no stop`, `Placing its stop failed: ${errorMessage(error)}`, { fields: { Shares: qty, Stop: stop }, path: "/core" })
    return [`could not protect ${symbol} (core): ${errorMessage(error)}`]
  }
}

/**
 * The overnight rules for stocks, enforced in code after the closing cycle (and when it fails or
 * never runs):
 * - sell every position whose plan still says "intraday" (the closing cycle keeps one only by
 *   switching it to an overnight horizon with adjust_exits)
 * - then, if what's left is over max_overnight_pct of equity, sell the weakest positions until it fits
 * Options positions are multi-day by design and are governed by their own limits.
 */
export const enforceOvernightRules = async (ctx: TradingContext): Promise<string[]> => {
  const { alpaca, col, settings } = ctx
  const [account, positions, plans] = await Promise.all([alpaca.getAccount(), alpaca.getPositions(), col.plans.find({ horizon: "intraday" }).toArray()])
  const intraday = new Set(plans.map((p) => p._id))
  const longs = positions.filter((p) => isStock(p) && p.side === "long")
  const kept = longs.filter((p) => !intraday.has(p.symbol))

  const maxPct = settings.current.risk.max_overnight_pct
  const cap = (Number(account.equity) * maxPct) / 100
  let exposure = kept.reduce((sum, p) => sum + Number(p.market_value), 0)
  const overCap: AlpacaPosition[] = []
  for (const p of [...kept].sort((a, b) => Number(a.unrealized_plpc) - Number(b.unrealized_plpc))) {
    if (exposure <= cap) break
    overCap.push(p)
    exposure -= Number(p.market_value)
  }
  return [...(await flatten(ctx, longs.filter((p) => intraday.has(p.symbol)))), ...(await flatten(ctx, overCap, ` (over the ${maxPct}% overnight cap)`))]
}

/**
 * The regular upkeep. `closeCycleDone` tells it whether today's closing cycle succeeded, so the
 * overnight fallback only runs when it didn't.
 */
export const maintain = async (ctx: TradingContext, session: Session, { now = new Date(), closeCycleDone }: { now?: Date; closeCycleDone: () => Promise<boolean> }): Promise<string[]> => {
  const { alpaca, col, settings, alerts } = ctx
  const notes: string[] = []

  await syncOrders(col, alpaca)
  if (!isSessionOpen(session, now)) return notes

  const [account, positions] = await Promise.all([alpaca.getAccount(), alpaca.getPositions()])
  const stocks = positions.filter(isStock)
  const risk = computeRiskState(account, stocks.length, 0, settings.current)

  if (risk.kill_switch && positions.length > 0) {
    const optionNotes = await liquidateOptions(ctx, "kill_switch")
    const stockNotes = await flattenStocks(ctx, " (daily loss limit)")
    notes.push(`DAILY LOSS LIMIT: day P&L ${risk.day_pnl_pct}% breached -${settings.current.risk.flatten_loss_pct}%; liquidated everything`, ...optionNotes, ...stockNotes)
    await alerts.send(
      "critical",
      "Daily loss limit: liquidated all positions",
      `Day P&L hit ${risk.day_pnl_pct}% (limit -${settings.current.risk.flatten_loss_pct}%). Every position was sold and buying is blocked for the rest of the day.`,
      { fields: { Equity: money(risk.equity), "Day P&L": money(risk.day_pnl), Positions: positions.length }, path: `/journal/${session.day}` },
    )
    return notes
  }

  const minutesToClose = minutesBetween(now, session.close!)
  if (minutesToClose <= 7 && !(await closeCycleDone())) {
    const flattened = await enforceOvernightRules(ctx)
    notes.push(...flattened)
    if (flattened.length) {
      await alerts.send("warning", "Closing cycle didn't run: sold intraday positions as a fallback", flattened.join("\n"), { path: `/journal/${session.day}` })
    }
  }

  notes.push(...(await ensureProtection(ctx)))
  notes.push(...(await reconcileOptions(ctx, positions, now)))

  // Forget plans for positions that were closed by a stop/target fill (grace period for pending buys).
  const heldSymbols = stocks.map((p) => p.symbol)
  await col.plans.deleteMany({ _id: { $nin: heldSymbols }, updated_at: { $lt: new Date(now.getTime() - 10 * 60_000) } })

  return notes
}

/** SPY's % change on `day`, the benchmark the bot has to beat. null if the broker has no bar for that day. */
const spyChangePct = async (ctx: TradingContext, day: string): Promise<number | null> => {
  const snap = (await ctx.alpaca.getSnapshots(["SPY"])).SPY
  const bar = snap?.dailyBar
  const prev = snap?.prevDailyBar?.c
  if (!bar || !prev || marketDay(new Date(bar.t)) !== day) return null
  return Math.round(((bar.c - prev) / prev) * 10_000) / 100
}

/** Writes the day's performance record (called by the postmarket cycle). Options P&L counts like any other fill. */
export const recordDailyStats = async (ctx: TradingContext, day: string = marketDay()) => {
  const { alpaca, col, settings, log, bus } = ctx
  const [account, fills, spyPct] = await Promise.all([
    alpaca.getAccount(),
    loadRealizedFills(col),
    spyChangePct(ctx, day).catch((error) => {
      log.warn("SPY benchmark unavailable", { error: errorMessage(error) })
      return null
    }),
  ])
  const today = fills.filter((f) => marketDay(f.at) === day)
  const closed = today.filter((f) => f.realized_pnl !== null)
  const realized = closed.reduce((sum, f) => sum + (f.realized_pnl ?? 0), 0)
  const sorted = [...closed].sort((a, b) => (a.realized_pnl ?? 0) - (b.realized_pnl ?? 0))
  const label = (f: (typeof closed)[number]) => f.underlying ?? f.symbol
  const equity = Number(account.equity)
  const start = Number(account.last_equity) || equity
  const startingCapital = settings.current.account.starting_capital
  const round2 = (n: number) => Math.round(n * 100) / 100
  const pnl = round2(equity - start)
  const pnlPct = start ? round2(((equity - start) / start) * 100) : 0

  await col.dailyStats.updateOne(
    { _id: day },
    {
      $set: {
        trading_day: day,
        start_equity: round2(start),
        end_equity: round2(equity),
        pnl,
        pnl_pct: pnlPct,
        total_return_pct: round2(((equity - startingCapital) / startingCapital) * 100),
        spy_pct: spyPct,
        orders_filled: today.length,
        buys: today.filter((f) => f.side === "buy").length,
        sells: today.filter((f) => f.side === "sell").length,
        realized_pnl: round2(realized),
        wins: closed.filter((f) => (f.realized_pnl ?? 0) > 0).length,
        losses: closed.filter((f) => (f.realized_pnl ?? 0) < 0).length,
        best: sorted.length ? { symbol: label(sorted[sorted.length - 1]), pnl: sorted[sorted.length - 1].realized_pnl! } : null,
        worst: sorted.length ? { symbol: label(sorted[0]), pnl: sorted[0].realized_pnl! } : null,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  )
  bus.emit("daily.stats", { day, pnl, pnl_pct: pnlPct, spy_pct: spyPct }, { summary: `Day closed ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)} (${pnlPct}%)${spyPct !== null ? ` vs SPY ${spyPct}%` : ""}` })
}
