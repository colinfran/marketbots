import { errorMessage } from "@mb/engine-kit/log"
import type { AlpacaOrder, Bar, Snapshot } from "@mb/stock-core/alpaca"
import type { ChainContract, Instrument, MarketContext, OptionChainContext, OptionsContext, Quote } from "@mb/stock-core/context"
import { roundTo } from "@mb/stock-core/math"
import { daysToExpiry, describeContract, OPTION_MULTIPLIER } from "@mb/stock-core/options"
import type { Phase } from "@mb/stock-core/settings"
import { addDays, formatTime, marketClock, marketDay, marketTime, minutesBetween } from "@mb/stock-core/time"
import type { TradingContext } from "../bot/context"
import { coreHeld, tradingCapPct, tradingExposure } from "../bot/books"
import { loadRealizedFills } from "../bot/orders"
import { computeRiskState } from "../bot/risk"
import type { Session } from "../bot/session"
import { dailyTechnicals, intradayTechnicals, pctChange, round, snapshotPrice } from "./indicators"
import { loadChain } from "./options-chain"

export type { MarketContext, Quote, Instrument }

/**
 * Builds the factual snapshot handed to the AI on every cycle. All prices, positions and cash come
 * from Alpaca (ground truth); web/X research is layered on top separately. The full object is
 * stored with each report so every decision can be audited against exactly what the bot saw.
 */

const TICKER = /^[A-Z]{1,5}$/

const toQuote = (symbol: string, snap: Snapshot | undefined, day: string): Quote | null => {
  if (!snap) return null
  const price = snapshotPrice(snap) ?? snap.dailyBar?.c ?? null
  const barIsToday = snap.dailyBar ? marketDay(new Date(snap.dailyBar.t)) === day : false
  const today = barIsToday ? snap.dailyBar : undefined
  const prevClose = barIsToday ? (snap.prevDailyBar?.c ?? null) : (snap.dailyBar?.c ?? null)
  return {
    symbol,
    price: round(price),
    change_pct: pctChange(prevClose, price),
    prev_close: round(prevClose),
    open: round(today?.o),
    high: round(today?.h),
    low: round(today?.l),
    day_vwap: round(today?.vw),
    iex_volume: today?.v ?? null,
    last_trade_et: snap.latestTrade ? formatTime(snap.latestTrade.t) : null,
  }
}

const newsLookbackHours: Record<Phase, number> = { premarket: 16, intraday: 3, close: 3, postmarket: 6 }

/** Calendar days of daily bars a cycle loads: a year of sessions plus slack for holidays. */
export const DAILY_LOOKBACK_DAYS = 380

export type BuiltContext = {
  context: MarketContext
  /** Every contract offered to the AI, by symbol (entries must come from here). */
  chains: Map<string, ChainContract>
}

export const buildContext = async (
  ctx: TradingContext,
  phase: Phase,
  session: Session,
  {
    requested = [],
    now = new Date(),
    scope = "full",
  }: {
    requested?: string[]
    now?: Date
    /** "event": the news engine's focused cycle. Held and requested symbols only (no movers, watchlist or broker news) and option chains for the requested symbols only. */
    scope?: "full" | "event"
  } = {},
): Promise<BuiltContext> => {
  const { alpaca, col, log } = ctx
  const settings = ctx.settings.current
  const r = settings.risk
  const day = session.day
  const event = scope === "event"
  const safe = async <T>(promise: Promise<T>, fallback: T, what: string): Promise<T> => {
    try {
      return await promise
    } catch (error) {
      log.warn("optional context source failed", { source: what, error: errorMessage(error) })
      return fallback
    }
  }

  const [account, allPositions, openOrders, plans, todayReports, recentStats, pastReviews, todayDecisions, fills, tradesToday, optionDocs] = await Promise.all([
    alpaca.getAccount(),
    alpaca.getPositions(),
    alpaca.listOrders({ status: "open", limit: 200, nested: false }),
    col.plans.find().toArray(),
    col.reports.find({ trading_day: day }, { projection: { context: 0, research: 0 } }).sort({ created_at: -1 }).toArray(),
    col.dailyStats.find({ trading_day: { $lt: day } }).sort({ trading_day: -1 }).limit(30).toArray(),
    col.reports.find({ phase: "postmarket", trading_day: { $lt: day } }, { projection: { trading_day: 1, "report.lessons": 1 } }).sort({ created_at: -1 }).limit(5).toArray(),
    col.decisions.find({ trading_day: day }).sort({ created_at: 1 }).limit(60).toArray(),
    // All fills, so FIFO matches today's sells against earlier buys.
    loadRealizedFills(col),
    col.decisions.countDocuments({ trading_day: day, status: "executed", action: { $in: ["buy", "sell", "buy_option", "close_option"] } }),
    col.optionPositions.find({ status: { $in: ["open", "closing"] } }).sort({ opened_at: 1 }).toArray(),
  ])
  // While the core book is on, its holdings are the weekly review's: shown read-only, never in `positions`.
  const core = coreHeld(plans, settings)
  const stocks = allPositions.filter((p) => (p.asset_class ?? "us_equity") === "us_equity")
  const positions = stocks.filter((p) => !core.has(p.symbol))
  const coreLines = stocks.filter((p) => core.has(p.symbol))
  const todayFills = fills.filter((f) => marketDay(f.at) === day)

  const briefing = todayReports.find((rep) => rep.phase === "premarket") ?? null
  const latest = todayReports[0] ?? null
  const planBySymbol = new Map(plans.map((p) => [p._id, p]))

  const [moversRaw, activesRaw] = event
    ? [{ gainers: [], losers: [] }, { most_actives: [] }]
    : await Promise.all([safe(alpaca.getMovers(25), { gainers: [], losers: [] }, "movers"), safe(alpaca.getMostActives(25), { most_actives: [] }, "most actives")])
  const tradeableMover = (m: { symbol: string; price: number }) => TICKER.test(m.symbol) && m.price >= r.min_price
  const gainers = moversRaw.gainers.filter(tradeableMover).slice(0, 8)
  const losers = moversRaw.losers.filter(tradeableMover).slice(0, 5)
  const actives = activesRaw.most_actives.filter((a) => TICKER.test(a.symbol)).slice(0, 15)

  const positionSymbols = positions.map((p) => p.symbol)
  const optionUnderlyings = [...new Set(optionDocs.map((d) => d.underlying))]
  const watchItems = [...(latest?.report.watchlist ?? []), ...(briefing?.report.watchlist ?? [])].sort((a, b) => b.conviction - a.conviction)
  const watchSymbols = event ? [] : [...new Set(watchItems.map((w) => w.symbol))].slice(0, 15)
  const moverSymbols = [...gainers, ...losers].map((m) => m.symbol).slice(0, 8)

  const tags = new Map<string, Set<string>>()
  const tag = (symbol: string, label: string) => tags.set(symbol, (tags.get(symbol) ?? new Set()).add(label))
  requested.forEach((s) => tag(s, "requested"))
  positionSymbols.forEach((s) => tag(s, "held"))
  optionUnderlyings.forEach((s) => tag(s, "options_held"))
  watchSymbols.forEach((s) => tag(s, "watchlist"))
  moverSymbols.forEach((s) => tag(s, "top_mover"))
  const instrumentSymbols = [...tags.keys()]

  const snapshots = await alpaca.getSnapshots([...settings.universe.benchmarks, ...instrumentSymbols, ...actives.map((a) => a.symbol)])

  const sessionStarted = !!session.open && session.open <= now
  const barSymbols = [...new Set([...instrumentSymbols, "SPY", "QQQ"])]
  const [intradayBars, dailyBars] = await Promise.all([
    sessionStarted && phase !== "premarket"
      ? safe(alpaca.getBars(barSymbols, "5Min", session.open!, session.close && session.close < now ? session.close : now), {} as Record<string, Bar[]>, "intraday bars")
      : Promise.resolve({} as Record<string, Bar[]>),
    // 380 calendar days ≈ 262 sessions: the 200-day average and the 52-week high as well as the 20- and 50-day levels.
    safe(alpaca.getBars(barSymbols, "1Day", marketTime(addDays(day, -DAILY_LOOKBACK_DAYS), "00:00"), marketTime(day, "00:00")), {} as Record<string, Bar[]>, "daily bars"),
  ])

  const newsSince = new Date(now.getTime() - newsLookbackHours[phase] * 3_600_000)
  // Event cycles get the wire dossier instead.
  const [symbolNews, marketNews] = event ? [[], []] : await Promise.all([
    safe(alpaca.getNews([...requested, ...positionSymbols, ...optionUnderlyings, ...watchSymbols].slice(0, 30), newsSince, 30), [], "symbol news"),
    safe(alpaca.getNews(null, newsSince, 15), [], "market news"),
  ])
  const news = [...new Map([...symbolNews, ...marketNews].map((n) => [n.id, n])).values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 35)
    .map((n) => ({ at_et: formatTime(n.created_at), symbols: n.symbols.slice(0, 6), headline: n.headline, source: n.source, url: n.url }))

  const instrument = (symbol: string): Instrument => {
    const quote = toQuote(symbol, snapshots[symbol], day)
    return {
      symbol,
      tags: [...(tags.get(symbol) ?? [])],
      quote,
      intraday: intradayTechnicals(intradayBars[symbol] ?? []),
      daily: dailyTechnicals(dailyBars[symbol] ?? [], quote?.price ?? null),
    }
  }

  const risk = computeRiskState(account, positions.length, tradesToday, settings, { tradingExposure: tradingExposure(positions, optionDocs) })
  const exitOrderSymbols = new Set(openOrders.filter((o: AlpacaOrder) => o.side === "sell").map((o) => o.symbol))

  // ─── Options ────────────────────────────────────────────────────────────
  const o = settings.options
  const premiumOpen = optionDocs.reduce((sum, d) => sum + (d.mark ? d.mark.value * OPTION_MULTIPLIER * d.qty : (d.cost_usd ?? 0)), 0)
  const premiumRoom = (risk.equity * o.max_total_premium_pct) / 100 - premiumOpen
  const optionsNotes: string[] = []
  const chains: OptionChainContext[] = []
  const offered = new Map<string, ChainContract>()
  const wantChains = o.enabled && (phase === "intraday" || phase === "close")
  if (wantChains) {
    const underlyings = [...new Set(event ? requested : [...requested, ...watchSymbols, ...positionSymbols, "SPY", "QQQ"])]
      .filter((s) => {
        const p = snapshotPrice(snapshots[s])
        return p !== null && p >= r.min_price
      })
      .slice(0, o.max_underlyings_per_cycle)
    for (const u of underlyings) {
      const chain = await safe(loadChain(alpaca, u, snapshotPrice(snapshots[u])!, day, o), null, `option chain ${u}`)
      if (!chain || !chain.contracts.length) continue
      chains.push(chain)
      for (const c of chain.contracts) offered.set(c.symbol, c)
    }
    if (!chains.length) optionsNotes.push("No liquid contracts passed the filters this cycle: no new options positions.")
  } else if (o.enabled) optionsNotes.push(`Option chains are only loaded intraday and in the closing cycle.`)
  else optionsNotes.push("Options trading is disabled.")
  const optionsAllowed = o.enabled && !risk.circuit_breaker && !risk.kill_switch && optionDocs.length < o.max_open_positions && premiumRoom > 0 && risk.trades_remaining > 0
  if (o.enabled && optionDocs.length >= o.max_open_positions) optionsNotes.push(`Max options positions (${o.max_open_positions}) reached: close one before opening another.`)
  if (o.enabled && premiumRoom <= 0) optionsNotes.push(`Options premium is at the ${o.max_total_premium_pct}% of equity cap.`)
  const perTradePct = risk.profit_lock ? o.max_premium_per_trade_pct / 2 : o.max_premium_per_trade_pct

  const options: OptionsContext = {
    enabled: o.enabled,
    new_positions_allowed: optionsAllowed,
    premium_open_usd: roundTo(premiumOpen, 2),
    premium_open_pct: risk.equity > 0 ? roundTo((premiumOpen / risk.equity) * 100, 2) : 0,
    max_total_premium_pct: o.max_total_premium_pct,
    max_premium_per_trade_pct: perTradePct,
    max_premium_per_trade_usd: roundTo(Math.max(0, Math.min((risk.equity * perTradePct) / 100, premiumRoom)), 2),
    open_positions: optionDocs.length,
    max_open_positions: o.max_open_positions,
    min_conviction: o.min_conviction,
    allow_spreads: o.allow_spreads,
    dte_range: [o.min_dte, o.max_dte],
    delta_range: [o.min_delta, o.max_delta],
    default_stop_loss_pct: o.default_stop_loss_pct,
    default_take_profit_pct: o.default_take_profit_pct,
    positions: optionDocs.map((d) => ({
      id: d._id,
      underlying: d.underlying,
      strategy: d.strategy,
      legs: d.legs.map((l) => `${l.side === "long" ? "long" : "short"} ${describeContract(l.symbol)} (${l.symbol})`),
      contracts: d.qty,
      paid: d.entry_price,
      value: d.mark?.value ?? null,
      pnl_usd: d.mark?.pnl_usd ?? null,
      pnl_pct: d.mark?.pnl_pct ?? null,
      dte: daysToExpiry(d.expiration, day),
      underlying_price: d.mark?.underlying_price ?? snapshotPrice(snapshots[d.underlying]),
      stop_loss_pct: d.stop_loss_pct,
      take_profit_pct: d.take_profit_pct,
      underlying_stop: d.underlying_stop,
      underlying_target: d.underlying_target,
      thesis: d.thesis,
      opened_at_et: formatTime(d.opened_at),
    })),
    chains,
    notes: optionsNotes,
  }

  const totalDays = recentStats.length
  const context: MarketContext = {
    generated_at: now.toISOString(),
    now_et: marketClock(now),
    trading_day: day,
    phase,
    session: {
      open_et: session.open_et,
      close_et: session.close_et,
      is_open: !!session.open && !!session.close && session.open <= now && now < session.close,
      early_close: session.early_close,
      minutes_to_open: session.open ? Math.round(minutesBetween(now, session.open)) : null,
      minutes_to_close: session.close ? Math.round(minutesBetween(now, session.close)) : null,
    },
    risk: {
      ...risk,
      min_conviction: r.min_conviction,
      max_new_buys_this_cycle: r.max_new_buys_per_cycle,
      rebuy_cooldown_minutes: r.rebuy_cooldown_minutes,
    },
    positions: positions.map((p) => {
      const plan = planBySymbol.get(p.symbol)
      return {
        symbol: p.symbol,
        qty: Number(p.qty),
        avg_entry: round(Number(p.avg_entry_price))!,
        price: round(Number(p.current_price))!,
        market_value: round(Number(p.market_value))!,
        unrealized_pl: round(Number(p.unrealized_pl))!,
        unrealized_pl_pct: round(Number(p.unrealized_plpc) * 100)!,
        today_pl_pct: round(Number(p.unrealized_intraday_plpc) * 100)!,
        stop_loss: plan?.stop_loss ?? null,
        take_profit: plan?.take_profit ?? null,
        horizon: plan?.horizon ?? null,
        thesis: plan?.thesis ?? null,
        invalidation: plan?.invalidation ?? null,
        opened_at_et: plan ? formatTime(plan.opened_at) : null,
        opened_on: plan ? marketDay(plan.opened_at) : null,
        has_exit_orders: exitOrderSymbols.has(p.symbol),
      }
    }),
    ...(settings.core.enabled
      ? {
          core: {
            target_pct: settings.core.target_pct,
            value: round(coreLines.reduce((s, p) => s + Number(p.market_value), 0))!,
            pct: risk.equity > 0 ? round((coreLines.reduce((s, p) => s + Number(p.market_value), 0) / risk.equity) * 100)! : 0,
            trading_cap_pct: tradingCapPct(settings),
            holdings: coreLines.map((p) => ({
              symbol: p.symbol,
              qty: Number(p.qty),
              market_value: round(Number(p.market_value))!,
              weight_pct: risk.equity > 0 ? round((Number(p.market_value) / risk.equity) * 100)! : 0,
              unrealized_pl_pct: round(Number(p.unrealized_plpc) * 100)!,
              stop: planBySymbol.get(p.symbol)?.stop_loss ?? null,
              theme: planBySymbol.get(p.symbol)?.theme ?? null,
            })),
          },
        }
      : {}),
    open_orders: openOrders.map((ord) => ({
      symbol: ord.symbol,
      side: ord.side,
      type: ord.type,
      qty: ord.qty ? Number(ord.qty) : null,
      limit_price: ord.limit_price ? Number(ord.limit_price) : null,
      stop_price: ord.stop_price ? Number(ord.stop_price) : null,
      status: ord.status,
    })),
    benchmarks: settings.universe.benchmarks.map((s) => toQuote(s, snapshots[s], day)).filter((q): q is Quote => q !== null),
    instruments: instrumentSymbols.map(instrument),
    movers: {
      gainers: gainers.map((m) => ({ symbol: m.symbol, price: m.price, change_pct: round(m.percent_change)! })),
      losers: losers.map((m) => ({ symbol: m.symbol, price: m.price, change_pct: round(m.percent_change)! })),
      most_active: actives
        .map((a) => {
          const q = toQuote(a.symbol, snapshots[a.symbol], day)
          return { symbol: a.symbol, price: q?.price ?? null, change_pct: q?.change_pct ?? null, iex_volume: a.volume }
        })
        .filter((a) => a.price !== null && a.price >= r.min_price)
        .slice(0, 10),
    },
    news,
    options,
    briefing: briefing
      ? {
          headline: briefing.report.headline,
          summary: briefing.report.summary,
          stance: briefing.report.market.stance,
          watchlist: briefing.report.watchlist.map((w) => ({ symbol: w.symbol, setup: w.setup, trigger: w.trigger, stop_loss: w.stop_loss, take_profit: w.take_profit, conviction: w.conviction })),
        }
      : null,
    previous_cycle: latest ? { at_et: formatTime(latest.created_at), phase: latest.phase, headline: latest.report.headline, next_focus: latest.report.next_focus } : null,
    requested,
    today: {
      decisions: todayDecisions.map((d) => ({ at_et: formatTime(d.created_at), symbol: d.symbol, action: d.action, status: d.status, reason: d.reason })),
      fills: todayFills.map((f) => ({ at_et: formatTime(f.at), symbol: f.symbol, side: f.side, qty: f.qty, price: round(f.price)!, role: f.role, realized_pnl: f.realized_pnl })),
      realized_pnl: round(todayFills.reduce((sum, f) => sum + (f.realized_pnl ?? 0), 0))!,
    },
    memory: {
      recent_days: recentStats.slice(0, 5).map((s) => ({
        day: s.trading_day,
        pnl: s.pnl,
        pnl_pct: s.pnl_pct,
        spy_pct: s.spy_pct ?? null,
        lessons: pastReviews.find((rev) => rev.trading_day === s.trading_day)?.report.lessons ?? [],
      })),
      profitable_days: recentStats.filter((s) => s.pnl > 0).length,
      total_days: totalDays,
    },
  }
  return { context, chains: offered }
}
