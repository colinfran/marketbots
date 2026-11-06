import type { AlpacaPosition } from "@mb/stock-core/alpaca"
import type { PositionPlanDoc } from "@mb/stock-core/db"
import { marketDay, minutesBetween } from "@mb/stock-core/time"
import { errorMessage } from "@mb/engine-kit/log"
import type { TradingContext } from "./context"
import { cancelSymbolOrders, heldExitBounds, protect, resolveExits } from "./execute"
import { liquidateOptions, reconcileOptions } from "./options"
import { clientId, loadRealizedFills, syncOrders } from "./orders"
import { computeRiskState } from "./risk"
import { isSessionOpen, type Session } from "./session"

/**
 * Cheap, AI-free upkeep the engine runs every minute:
 * - sync orders from Alpaca (records stop/target fills the trade stream may have missed)
 * - the daily loss limit: liquidate everything if the day's loss breaches flatten_loss_pct
 * - make sure every stock position has protective exit orders
 * - overnight rules in the last minutes of the session
 * - compare the options books with the broker
 * - housekeeping (plans for closed positions)
 */

const isStock = (p: AlpacaPosition) => (p.asset_class ?? "us_equity") === "us_equity"
const round2 = (n: number) => Math.round(n * 100) / 100

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
    // The long-term book's base holdings have no stop: a weekly close below the 200-day average sells them.
    if (plan?.book === "long_term" && plan.stop_loss === null) continue
    // A plan with a stop and no target (the trend core's) gets a plain stop: it rides its trend.
    const stopOnly = !!plan && plan.stop_loss !== null && plan.take_profit === null
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
      await protect(ctx, position.symbol, qty, exits.stop, stopOnly ? null : exits.target, plan?.decision_id ?? null)
      await col.plans.updateOne(
        { _id: position.symbol },
        {
          $set: { stop_loss: exits.stop, take_profit: stopOnly ? null : exits.target, updated_at: new Date() },
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
      notes.push(`protected ${position.symbol}: stop ${exits.stop}${stopOnly ? ", no target" : `, target ${exits.target}`}`)
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
 * The overnight rule for stocks, enforced in code in the last minutes of the session: sell every
 * position whose plan still says "intraday" (the agent keeps one only by switching it to an
 * overnight horizon with adjust_exits). Swing positions stay, protected by their resting stops.
 * Options positions are multi-day by design and are governed by their own limits. (Until 2026-11-06
 * a cap on what was carried overnight also sold the weakest swing positions.)
 */
export const enforceOvernightRules = async (ctx: TradingContext): Promise<string[]> => {
  const { alpaca, col } = ctx
  const [positions, plans] = await Promise.all([alpaca.getPositions(), col.plans.find().toArray()])
  const intraday = new Set(plans.filter((p) => p.horizon === "intraday").map((p) => p._id))
  return flatten(ctx, positions.filter((p) => isStock(p) && p.side === "long" && intraday.has(p.symbol)))
}

/** A trailing stop moves only in steps of at least this share of the price: each step replaces the resting exit orders. */
const TRAIL_STEP = 0.005

/**
 * The trailed stop for a held stock at `price`, or null while it doesn't move: its trail is the
 * entry's stop distance (`trail_usd`; for plans from before it, the distance from the entry to a
 * stop still below it), and it starts once the price is that far above the entry, so a winner keeps
 * running and gives back at most that much of its gain. Stops only move up.
 */
export const trailedStop = (plan: Pick<PositionPlanDoc, "stop_loss" | "trail_usd" | "trail_pct">, entry: number, price: number): { stop: number; trail: number } | null => {
  const current = plan.stop_loss
  // A long-term leader's stop trails a fixed share of the price from the start.
  if (plan.trail_pct) {
    const stop = Math.floor(price * (1 - plan.trail_pct / 100) * 100) / 100
    return current !== null && stop >= current + Math.max(0.01, price * TRAIL_STEP) ? { stop, trail: round2(price - stop) } : null
  }
  const trail = plan.trail_usd ?? (current !== null && current < entry ? entry - current : null)
  if (trail === null || !(trail > 0) || price < entry + trail) return null
  const stop = Math.floor((price - trail) * 100) / 100
  if (current !== null && stop < current + Math.max(0.01, price * TRAIL_STEP)) return null
  return { stop, trail }
}

/** Raises winners' stops behind the price: the resting exits are replaced with the higher stop (and the plan's target, if it has one). */
export const trailStops = async (ctx: TradingContext, positions: AlpacaPosition[]): Promise<string[]> => {
  const plans = new Map((await ctx.col.plans.find().toArray()).map((p) => [p._id, p]))
  const notes: string[] = []
  for (const position of positions) {
    if (!isStock(position) || position.side !== "long") continue
    const plan = plans.get(position.symbol)
    const qty = Math.floor(Number(position.qty))
    if (!plan || qty < 1) continue
    const next = trailedStop(plan, Number(position.avg_entry_price), Number(position.current_price))
    if (!next) continue
    try {
      // If placing the new exits fails, ensureProtection re-protects the shares at the plan's old levels in this same pass.
      await cancelSymbolOrders(ctx.alpaca, position.symbol)
      await protect(ctx, position.symbol, qty, next.stop, plan.take_profit, plan.decision_id)
      await ctx.col.plans.updateOne({ _id: position.symbol }, { $set: { stop_loss: next.stop, ...(plan.trail_pct ? {} : { trail_usd: next.trail }), updated_at: new Date() } })
      notes.push(`trailed ${position.symbol}: stop ${plan.stop_loss} → ${next.stop}`)
    } catch (error) {
      notes.push(`could not trail ${position.symbol}: ${errorMessage(error)}`)
    }
  }
  return notes
}

/** The regular upkeep. In the last minutes of the session the overnight rules are how the day ends. */
export const maintain = async (ctx: TradingContext, session: Session, { now = new Date() }: { now?: Date } = {}): Promise<string[]> => {
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

  if (minutesBetween(now, session.close!) <= 7) {
    const flattened = await enforceOvernightRules(ctx)
    notes.push(...flattened)
    if (flattened.length) await alerts.send("info", "Overnight rules: sold the day's intraday positions", flattened.join("\n"), { path: `/journal/${session.day}` })
  }

  notes.push(...(await trailStops(ctx, positions)))
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

/**
 * Writes the day's performance record (the journal's day). Options P&L counts like any other fill.
 * The engine writes it once a day, after the close (Engine.recordDay).
 */
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
