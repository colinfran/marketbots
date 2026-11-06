import { randomUUID } from "node:crypto"
import { errorMessage } from "@mb/engine-kit/log"
import { sleep } from "@mb/engine-kit/util/async"
import type { AlpacaPosition, Bar } from "@mb/stock-core/alpaca"
import type { DecisionDoc, PositionPlanDoc } from "@mb/stock-core/db"
import type { RiskCheck } from "@mb/stock-core/events"
import type { Decision } from "@mb/stock-core/report"
import { weeklyCloseVs200 } from "@mb/core/indicators"
import { addDays, marketTime, minutesBetween } from "@mb/stock-core/time"
import { snapshotPrice } from "../market/indicators"
import { SCAN_UNIVERSE_KEY, type ScanUniverse } from "../market/scan-universe"
import type { EngineContext } from "./context"
import { coreCandidates, coreRegime, coreStats, coreTrendBroken, GEARED_NAME, longTermLeaders, type CorePick, type CoreStats } from "./core-rules"
import { cancelSymbolOrders, placeStopOrder } from "./execute"
import { clientId, saveOrders, waitForFill } from "./orders"
import { computeRiskState } from "./risk"
import { isSessionOpen, type Session } from "./session"

/**
 * The trend core's runner (its rules: ./core-rules). Once a trading day:
 *
 *   before it acts   the day's plan from completed daily bars of the scan universe's most traded
 *                    stocks (core.universe_size) and SPY: the regime, the ranked picks, and the
 *                    core positions whose trend broke. Kept in `cache` (core:plan), so a restart
 *                    reuses it.
 *   30 min in        it sells core positions whose trend broke, then fills the free core slots
 *                    (core.max_positions) with the strongest picks it doesn't hold, skipping a stock
 *                    sold within core.reentry_hours or with negative news at review severity within
 *                    core.news_veto_hours. A buy risks core.risk_per_trade_pct of equity at its
 *                    stop (a market order, then a plain GTC stop: no target), within the position
 *                    cap and deployable cash.
 *
 * The long-term book runs in the same pass, before the trend core's entries so it takes its share
 * first (long_term.*): SPY and QQQ at their shares of equity, held with no stop, and
 * long_term.leaders stocks at long_term.leader_pct each, the strongest on 12-month momentum
 * above their 200-day average, with a stop trailing long_term.leader_trail_pct below the price.
 * Any of them is sold after a week closing below its 200-day average (Friday's close against the
 * average then); a leader also when the first plan of a month no longer ranks it among the top
 * three times as many as it holds. Buys need that week's close above the average. Its positions
 * are plans with book "long_term" and don't count toward risk.max_open_positions.
 *
 * Its positions are plans with book "core": maintenance trails their stops and protects them,
 * and the overnight rules keep them. It waits while an agent episode runs, and opens nothing while
 * the drawdown breaker pauses entries, the engine is paused or the day's loss limit blocks buys.
 * core.enabled turns it off. Every attempt is a `decisions` document (trigger_kind "core").
 */

const MIN = 60_000
const HOUR = 60 * MIN
/** It acts this long after the open, once the opening swings settle… */
const ENTRY_DELAY_MIN = 30
/** …and not later than this before the close (a late restart waits for the next day). */
const LATE_MIN = 30
const BATCH = 200
/** Where the day's plan is kept in `cache`. */
export const CORE_PLAN_KEY = "core:plan"
const RETRY_MS = 30 * MIN
const INVALIDATION = "The trailing stop, or a close below the 50-day average."
const LONG_TERM_INVALIDATION = "A week closing below its 200-day average (a leader also: its trailing stop, or dropping out of the top at a month's refresh)."

/** The long-term book's part of the day's plan. */
export type LongTermPlan = {
  /** Each base ETF's last weekly close against its 200-day average (null: not enough history). */
  base: { symbol: string; above: boolean | null; detail: string }[]
  /** Leaders, strongest first: three times as many as it holds, for replacements. */
  leaders: { symbol: string; signal: string }[]
  /** Held leaders whose last weekly close was below their 200-day average. */
  broken: string[]
  /** The month's first plan: held leaders no longer among `leaders` are replaced. */
  refresh: boolean
}

export type CorePlan = { day: string; built_at: Date; regime: { on: boolean; detail: string }; picks: CorePick[]; broken: string[]; longTerm?: LongTermPlan }

const LONG_TERM_BASE = ["SPY", "QQQ"] as const
const BASE_PCT = { SPY: "spy_pct", QQQ: "qqq_pct" } as const

/** Monday 00:00 New York time of the week `day` falls in: the plan's weekly close is the last bar before it. */
const weekStartNy = (day: string) => {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay()
  return marketTime(addDays(day, -((dow + 6) % 7)), "00:00").getTime()
}

type Outcome = Pick<DecisionDoc, "status" | "reason"> & Partial<Pick<DecisionDoc, "price" | "qty" | "notional" | "stop_loss" | "order_ids" | "checks">>

const isStock = (p: AlpacaPosition) => (p.asset_class ?? "us_equity") === "us_equity"
const floor2 = (n: number) => Math.floor(n * 100) / 100
const round2 = (n: number) => Math.round(n * 100) / 100

const request = (symbol: string, action: "buy" | "sell", rationale: string, fields: Partial<Decision> = {}): Decision => ({
  symbol,
  action,
  allocation_pct: null,
  sell_pct: null,
  stop_loss: null,
  take_profit: null,
  horizon: "multi_day",
  setup: "momentum",
  conviction: 10,
  rationale,
  evidence: [],
  invalidation: INVALIDATION,
  structure_id: null,
  option: null,
  ...fields,
})

export class StockCore {
  private plan: CorePlan | null = null
  private building = false
  private retryAt = 0
  private actedDay = ""
  /** While it is placing orders: maintenance waits, so it never protects shares the core is protecting. */
  acting = false

  constructor(
    private readonly ctx: EngineContext,
    private readonly d: {
      session: () => Session | null
      /** Why new entries are paused (the agent's drawdown breaker), or null. */
      entriesPaused: () => string | null
      /** An agent episode is deciding: the core waits for it. */
      busy: () => boolean
      /** Between bar requests (tests: 0). */
      pauseMs?: number
    },
  ) {}

  /** The day's plan, once built (the engine's status, tests). */
  get today(): CorePlan | null {
    return this.plan
  }

  /** Called every minute: the day's plan, then once in the session its exits and entries. */
  async tick(now = new Date()) {
    if (!this.ctx.settings.current.core.enabled) return
    const session = this.d.session()
    if (!session?.is_trading_day || !session.open || !session.close) return
    await this.ensurePlan(session.day, now)
    const plan = this.plan
    if (!plan || plan.day !== session.day || this.actedDay === session.day) return
    if (!isSessionOpen(session, now) || -minutesBetween(now, session.open) < ENTRY_DELAY_MIN || minutesBetween(now, session.close) < LATE_MIN) return
    if (this.d.busy()) return
    this.actedDay = session.day
    this.acting = true
    try {
      const notes = [...(await this.exits(plan, session)), ...(await this.longTerm(plan, session, now)), ...(await this.entries(plan, session, now))]
      if (notes.length) this.ctx.log.info("trend core", { day: session.day, notes })
    } finally {
      this.acting = false
    }
  }

  private async ensurePlan(day: string, now: Date) {
    if (this.plan?.day === day || this.building || now.getTime() < this.retryAt) return
    this.building = true
    try {
      const cached = await this.ctx.col.cache.findOne({ _id: CORE_PLAN_KEY })
      const stored = (cached?.data ?? null) as CorePlan | null
      if (stored?.day === day) {
        this.plan = stored
        return
      }
      const plan = await this.build(day, stored)
      this.plan = plan
      await this.ctx.col.cache.updateOne({ _id: CORE_PLAN_KEY }, { $set: { data: plan, fetched_at: now, expires_at: new Date(now.getTime() + 7 * 24 * HOUR) } }, { upsert: true })
      this.ctx.log.info("trend core plan", { day, regime: plan.regime.detail, picks: plan.picks.slice(0, 10).map((p) => p.symbol), broken: plan.broken })
    } catch (error) {
      this.retryAt = now.getTime() + RETRY_MS
      this.ctx.log.warn("trend core plan failed", { error: errorMessage(error) })
    } finally {
      this.building = false
    }
  }

  /** The day's plan from completed daily bars (up to midnight New York time on `day`). */
  private async build(day: string, previous: CorePlan | null): Promise<CorePlan> {
    const s = this.ctx.settings.current
    const universe = (await this.ctx.col.cache.findOne({ _id: SCAN_UNIVERSE_KEY }))?.data as ScanUniverse | undefined
    const ranked = universe?.symbols ?? []
    if (!ranked.length) throw new Error("no scan universe yet")
    const books = await this.ctx.col.plans.find({ book: { $in: ["core", "long_term"] } }, { projection: { _id: 1, book: 1 } }).toArray()
    const held = books.filter((p) => p.book === "core").map((p) => p._id)
    const longHeld = books.filter((p) => p.book === "long_term").map((p) => p._id)
    const names = new Map((await this.ctx.alpaca.listAssets()).map((a) => [a.symbol, a.name]))
    const pool = ranked.slice(0, s.core.universe_size).filter((symbol) => !GEARED_NAME.test(names.get(symbol) ?? ""))
    const symbols = [...new Set([...LONG_TERM_BASE, ...pool, ...held, ...longHeld])]
    const end = marketTime(day, "00:00")
    const start = new Date(end.getTime() - 400 * 24 * HOUR)
    const bars: Record<string, Bar[]> = {}
    for (let i = 0; i < symbols.length; i += BATCH) {
      Object.assign(bars, await this.ctx.alpaca.getBars(symbols.slice(i, i + BATCH), "1Day", start, end, { feed: "sip" }))
      if (i + BATCH < symbols.length) await sleep(this.d.pauseMs ?? 1_500, this.ctx.signal)
    }
    const stats = new Map(symbols.flatMap((symbol) => {
      const st = coreStats(symbol, bars[symbol] ?? [])
      return st ? [[symbol, st] as const] : []
    }))
    const weekStart = weekStartNy(day)
    const weekly = (symbol: string) => weeklyCloseVs200((bars[symbol] ?? []).map((b) => ({ t: Date.parse(b.t), close: b.c })), weekStart)
    const leaders = longTermLeaders(pool.flatMap((symbol) => stats.get(symbol) ?? []), s).slice(0, Math.max(10, s.long_term.leaders * 3))
    const longTerm: LongTermPlan = {
      base: LONG_TERM_BASE.map((symbol) => {
        const w = weekly(symbol)
        return { symbol, above: w ? w.above : null, detail: w ? `last week closed at ${w.close.toFixed(2)}, ${((w.close / w.sma200 - 1) * 100).toFixed(2)}% vs its 200-day average ${w.sma200.toFixed(2)}` : "not 200 sessions of history" }
      }),
      leaders: leaders.map((l: CoreStats) => ({ symbol: l.symbol, signal: `Long-term leader: 12-month return ${l.ret12_1Pct!.toFixed(1)}% (skipping the last month), ${((l.close / l.sma200 - 1) * 100).toFixed(1)}% above its 200-day average` })),
      broken: longHeld.filter((symbol) => !LONG_TERM_BASE.includes(symbol as (typeof LONG_TERM_BASE)[number]) && weekly(symbol)?.above === false),
      refresh: !previous || previous.day.slice(0, 7) !== day.slice(0, 7),
    }
    return {
      day,
      built_at: new Date(),
      longTerm,
      regime: coreRegime(stats.get("SPY") ?? null),
      picks: coreCandidates(pool.flatMap((symbol) => stats.get(symbol) ?? []), s).slice(0, Math.max(10, s.core.max_positions * 4)),
      broken: held.filter((symbol) => {
        const st = stats.get(symbol)
        return !!st && coreTrendBroken(st)
      }),
    }
  }

  /** Sells the core positions whose trend broke. */
  private async exits(plan: CorePlan, session: Session): Promise<string[]> {
    if (!plan.broken.length) return []
    const [positions, plans] = await Promise.all([this.ctx.alpaca.getPositions(), this.ctx.col.plans.find({ book: "core" }).toArray()])
    const core = new Set(plans.map((p) => p._id))
    const notes: string[] = []
    for (const symbol of plan.broken) {
      const position = positions.find((p) => p.symbol === symbol && isStock(p) && p.side === "long")
      if (position && core.has(symbol)) notes.push(await this.sell(symbol, position, session, `Trend broke: ${symbol} closed below its 50-day average.`, "Trend core"))
    }
    return notes
  }

  private async sell(symbol: string, position: AlpacaPosition, session: Session, why: string, label: "Trend core" | "Long-term book"): Promise<string> {
    const id = randomUUID()
    let outcome: Outcome
    try {
      await cancelSymbolOrders(this.ctx.alpaca, symbol)
      const order = await this.ctx.alpaca.submitOrder({ symbol, qty: position.qty, side: "sell", type: "market", time_in_force: "day", client_order_id: clientId("core") })
      const filled = await waitForFill(this.ctx.alpaca, order)
      await saveOrders(this.ctx.col, [filled], { decisionId: id })
      await this.ctx.col.plans.deleteOne({ _id: symbol })
      const price = filled.filled_avg_price ? Number(filled.filled_avg_price) : Number(position.current_price)
      const qty = Number(position.qty)
      outcome = { status: "executed", reason: filled.status === "filled" ? `sold ${qty} shares` : `sell submitted (status ${filled.status})`, price, qty, notional: round2(qty * price), order_ids: [filled.id] }
      await this.ctx.alerts.success(`${label} sold ${symbol}`, `[paper] ${why}`, { path: `/markets/${symbol}`, key: `core-exit|${id}` }).catch(() => undefined)
    } catch (error) {
      // The plan stays: maintenance re-protects the shares at its stop.
      outcome = { status: "failed", reason: errorMessage(error).slice(0, 400) }
    }
    await this.record(id, session, request(symbol, "sell", why), outcome, label === "Long-term book" ? "long_term" : "core")
    return `${symbol}: ${label === "Long-term book" ? "long-term" : "trend broke,"} sell ${outcome.status}`
  }

  /**
   * The long-term book: sells what broke (a week closing below its 200-day average; a leader out of
   * the top at the month's first plan), then buys its base ETFs and leaders up to their shares.
   */
  private async longTerm(plan: CorePlan, session: Session, now: Date): Promise<string[]> {
    const s = this.ctx.settings.current
    const lt = plan.longTerm
    if (!lt || !s.long_term.enabled) return []
    const { alpaca, col } = this.ctx
    const [positions, plans] = await Promise.all([alpaca.getPositions(), col.plans.find({ book: "long_term" }).toArray()])
    const held = new Map(positions.filter((p) => isStock(p) && p.side === "long").map((p) => [p.symbol, p]))
    const isBase = (symbol: string) => LONG_TERM_BASE.includes(symbol as (typeof LONG_TERM_BASE)[number])
    const top = new Set(lt.leaders.map((l) => l.symbol))
    const notes: string[] = []
    for (const p of plans) {
      const position = held.get(p._id)
      if (!position) continue
      const base = lt.base.find((b) => b.symbol === p._id)
      const why = base
        ? base.above === false
          ? `${p._id}'s long-term trend broke: ${base.detail}.`
          : null
        : lt.broken.includes(p._id)
          ? `${p._id} closed the week below its 200-day average.`
          : lt.refresh && !top.has(p._id)
            ? `${p._id} is no longer among the strongest on 12-month momentum (the month's refresh).`
            : null
      if (!why) continue
      notes.push(await this.sell(p._id, position, session, why, "Long-term book"))
      held.delete(p._id)
    }
    const paused = this.d.entriesPaused()
    if (paused) return [...notes, `long-term: no buys (${paused})`]
    const st = this.ctx.state.state
    if (st.kill_switch.engaged || st.status !== "running") return notes
    const [account, tradesToday] = await Promise.all([
      alpaca.getAccount(),
      col.decisions.countDocuments({ trading_day: session.day, status: "executed", action: { $in: ["buy", "sell", "buy_option", "close_option"] } }),
    ])
    const risk = computeRiskState(account, 0, tradesToday, s)
    if (risk.kill_switch || risk.circuit_breaker || risk.trades_remaining <= 0) return [...notes, `long-term: no buys (${risk.notes.join(" ")})`]
    let cash = risk.deployable_cash
    const wanted: { symbol: string; pct: number; signal: string; stopPct: number | null }[] = []
    for (const b of lt.base) {
      const pct = s.long_term[BASE_PCT[b.symbol as (typeof LONG_TERM_BASE)[number]]]
      if (pct > 0 && b.above && !held.has(b.symbol)) wanted.push({ symbol: b.symbol, pct, signal: `Long-term book: ${b.symbol} at ${pct}% of equity, held while its weekly close stays above its 200-day average: ${b.detail}.`, stopPct: null })
    }
    const heldLeaders = plans.filter((p) => held.has(p._id) && !isBase(p._id)).length
    let slots = s.long_term.leaders - heldLeaders
    if (slots > 0) {
      const [sold, vetoed] = await Promise.all([this.recentlySold(now), this.vetoed(now)])
      for (const l of lt.leaders) {
        if (slots <= 0) break
        if (held.has(l.symbol) || sold.has(l.symbol) || vetoed.has(l.symbol)) continue
        wanted.push({ symbol: l.symbol, pct: s.long_term.leader_pct, signal: l.signal, stopPct: s.long_term.leader_trail_pct })
        slots -= 1
      }
    }
    if (!wanted.length) return notes
    const snapshots = await alpaca.getSnapshots(wanted.map((w) => w.symbol)).catch(() => ({}) as Awaited<ReturnType<typeof alpaca.getSnapshots>>)
    for (const w of wanted) {
      const price = snapshotPrice(snapshots[w.symbol])
      const qty = price ? Math.floor(Math.min((risk.equity * w.pct) / 100, cash) / price) : 0
      if (!price || qty < 1) {
        notes.push(`${w.symbol}: long-term buy skipped (${price ? `${round2(cash)} of deployable cash buys less than 1 share` : "no price"})`)
        continue
      }
      const checks: RiskCheck[] = [
        { name: "long_term", ok: true, detail: w.signal },
        { name: "size", ok: true, detail: `${qty} shares (${round2(qty * price)}): ${w.pct}% of equity${w.stopPct ? `, stop trailing ${w.stopPct}% below` : ", no stop"} (${round2(cash)} deployable)` },
      ]
      const bought = await this.buy({ symbol: w.symbol, signal: w.signal, book: "long_term", stopPct: w.stopPct, trailPct: w.stopPct }, qty, price, session, checks)
      notes.push(`${w.symbol}: long-term buy ${bought.status}`)
      cash -= bought.cost
    }
    return notes
  }

  /** Fills the free core slots with the strongest picks it may buy. */
  private async entries(plan: CorePlan, session: Session, now: Date): Promise<string[]> {
    const s = this.ctx.settings.current
    if (!plan.regime.on) return [`no entries: ${plan.regime.detail}`]
    const paused = this.d.entriesPaused()
    if (paused) return [`no entries: ${paused}`]
    const st = this.ctx.state.state
    if (st.kill_switch.engaged || st.status !== "running") return []
    const { alpaca, col } = this.ctx
    const [account, positions, plans, tradesToday] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      col.plans.find({ book: { $in: ["core", "long_term"] } }, { projection: { _id: 1, book: 1 } }).toArray(),
      col.decisions.countDocuments({ trading_day: session.day, status: "executed", action: { $in: ["buy", "sell", "buy_option", "close_option"] } }),
    ])
    const stocks = positions.filter((p) => isStock(p) && p.side === "long")
    const held = new Set(stocks.map((p) => p.symbol))
    const longTerm = new Set(plans.filter((p) => p.book === "long_term").map((p) => p._id))
    const trading = stocks.filter((p) => !longTerm.has(p.symbol)).length
    const risk = computeRiskState(account, trading, tradesToday, s)
    if (!risk.new_buys_allowed) return [`no entries: ${risk.notes.join(" ") || "buys are blocked"}`]
    let slots = Math.min(s.core.max_positions - plans.filter((p) => p.book === "core" && held.has(p._id)).length, s.risk.max_open_positions - trading)
    if (slots <= 0) return []
    const [sold, vetoed] = await Promise.all([this.recentlySold(now), this.vetoed(now)])
    const notes: string[] = []
    const candidates = plan.picks.filter((p) => {
      if (held.has(p.symbol)) return false
      if (sold.has(p.symbol)) notes.push(`${p.symbol}: sold within ${s.core.reentry_hours} h`)
      else if (vetoed.has(p.symbol)) notes.push(`${p.symbol}: vetoed by negative news`)
      return !sold.has(p.symbol) && !vetoed.has(p.symbol)
    })
    const tried = candidates.slice(0, slots * 3)
    if (!tried.length) return notes
    const snapshots = await alpaca.getSnapshots(tried.map((p) => p.symbol)).catch(() => ({}) as Awaited<ReturnType<typeof alpaca.getSnapshots>>)
    let cash = risk.deployable_cash
    for (const pick of tried) {
      if (slots <= 0) break
      const price = snapshotPrice(snapshots[pick.symbol])
      if (!price) {
        notes.push(`${pick.symbol}: no price`)
        continue
      }
      const stop = floor2(price * (1 - pick.stop_pct / 100))
      const riskUsd = (risk.equity * s.core.risk_per_trade_pct) / 100
      const qty = Math.floor(Math.min(riskUsd / (price - stop), (risk.equity * risk.max_position_pct) / 100 / price, cash / price))
      if (qty < 1) {
        notes.push(`${pick.symbol}: $${round2(cash)} of deployable cash buys less than 1 share at $${price}`)
        continue
      }
      const asset = await alpaca.getAsset(pick.symbol).catch(() => null)
      if (!asset?.tradable || asset.status !== "active") {
        notes.push(`${pick.symbol}: not tradable`)
        continue
      }
      const checks: RiskCheck[] = [
        { name: "regime", ok: true, detail: plan.regime.detail },
        { name: "rules_entry", ok: true, detail: pick.signal },
        { name: "size", ok: true, detail: `${qty} shares ($${round2(qty * price)}): risks ${s.core.risk_per_trade_pct}% of equity at a ${pick.stop_pct}% stop (max ${risk.max_position_pct}% per position, $${round2(cash)} deployable)` },
      ]
      const bought = await this.buy({ symbol: pick.symbol, signal: pick.signal, book: "core", stopPct: pick.stop_pct, trailPct: null }, qty, price, session, checks)
      notes.push(`${pick.symbol}: buy ${bought.status}`)
      if (bought.cost > 0) {
        slots -= 1
        cash -= bought.cost
        held.add(pick.symbol)
      }
    }
    return notes
  }

  /**
   * A market buy, then its plan and, with a stop, a plain GTC stop (no target). The trend core's
   * stop then trails at its entry distance (trail_usd), a long-term leader's at trailPct; a
   * long-term base holding has no stop.
   */
  private async buy(
    pick: { symbol: string; signal: string; book: "core" | "long_term"; stopPct: number | null; trailPct: number | null },
    qty: number,
    price: number,
    session: Session,
    checks: RiskCheck[],
  ): Promise<{ status: DecisionDoc["status"]; cost: number }> {
    const { alpaca, col } = this.ctx
    const id = randomUUID()
    let outcome: Outcome
    let cost = 0
    try {
      const order = await alpaca.submitOrder({ symbol: pick.symbol, qty: String(qty), side: "buy", type: "market", time_in_force: "day", client_order_id: clientId("core") })
      const filled = await waitForFill(alpaca, order)
      await saveOrders(col, [filled], { decisionId: id })
      const got = Math.floor(Number(filled.filled_qty))
      if (got < 1) {
        await alpaca.cancelOrder(filled.id).catch(() => undefined)
        outcome = { status: "failed", reason: `buy ${filled.status}, nothing filled`, checks, order_ids: [filled.id] }
      } else {
        const fill = filled.filled_avg_price ? Number(filled.filled_avg_price) : price
        const stop = pick.stopPct === null ? null : floor2(fill * (1 - pick.stopPct / 100))
        // The plan first: if the stop order fails, maintenance protects the shares at the plan's stop.
        await col.plans.updateOne(
          { _id: pick.symbol },
          {
            $set: {
              decision_id: id,
              stop_loss: stop,
              take_profit: null,
              trail_usd: pick.book === "core" && stop !== null ? round2(fill - stop) : null,
              trail_pct: pick.trailPct,
              horizon: "multi_day",
              setup: "momentum",
              thesis: pick.signal,
              invalidation: pick.book === "core" ? INVALIDATION : LONG_TERM_INVALIDATION,
              book: pick.book,
              updated_at: new Date(),
            } satisfies Partial<PositionPlanDoc>,
            $setOnInsert: { opened_at: new Date() },
          },
          { upsert: true },
        )
        const stopOrder = stop === null ? null : await placeStopOrder(this.ctx, pick.symbol, got, stop, id)
        cost = got * fill
        const exits = stop === null ? "no stop or target: sold after a week closing below its 200-day average" : `stop ${stop}, no target`
        outcome = { status: "executed", reason: `bought ${got} shares; ${exits}`, checks, price: fill, qty: got, notional: round2(cost), stop_loss: stop, order_ids: stopOrder ? [filled.id, stopOrder.id] : [filled.id] }
      }
    } catch (error) {
      outcome = { status: "failed", reason: errorMessage(error).slice(0, 400), checks }
    }
    await this.record(id, session, request(pick.symbol, "buy", pick.signal, { stop_loss: outcome.stop_loss ?? null }), outcome, pick.book)
    return { status: outcome.status, cost }
  }

  private async record(id: string, session: Session, req: Decision, o: Outcome, book: "core" | "long_term") {
    const doc: DecisionDoc = {
      _id: id,
      cycle_id: `${book}:${session.day}`,
      report_id: `${book}:${session.day}`,
      phase: "intraday",
      trading_day: session.day,
      created_at: new Date(),
      symbol: req.symbol,
      instrument: "stock",
      action: req.action,
      trigger_kind: book,
      request: req,
      status: o.status,
      reason: o.reason,
      checks: o.checks ?? [],
      price: o.price ?? null,
      qty: o.qty ?? null,
      notional: o.notional ?? null,
      stop_loss: o.stop_loss ?? null,
      take_profit: null,
      order_ids: o.order_ids ?? [],
      option: null,
    }
    await this.ctx.col.decisions.insertOne(doc)
    this.ctx.bus.emit(
      "decision.result",
      { decision_id: id, symbol: req.symbol, action: req.action, status: o.status, reason: o.reason },
      { summary: `${book === "core" ? "Trend core" : "Long-term book"} ${req.action} ${req.symbol}: ${o.status}${o.reason ? ` (${o.reason})` : ""}`, level: o.status === "failed" ? "warn" : "info", instrument: req.symbol },
    )
  }

  /** Stocks sold (by anyone: a stop, the agent, the core) within core.reentry_hours. */
  private async recentlySold(now: Date): Promise<Set<string>> {
    const since = new Date(now.getTime() - this.ctx.settings.current.core.reentry_hours * HOUR)
    const sales = await this.ctx.col.orders.find({ side: "sell", asset_class: "us_equity", filled_at: { $gte: since } }, { projection: { symbol: 1 } }).toArray()
    return new Set(sales.map((o) => o.symbol))
  }

  /** Stocks with negative news at review severity or above within core.news_veto_hours. */
  private async vetoed(now: Date): Promise<Set<string>> {
    const s = this.ctx.settings.current
    if (s.core.news_veto_hours <= 0) return new Set()
    const since = new Date(now.getTime() - s.core.news_veto_hours * HOUR)
    const items = await this.ctx.col.wireItems
      .find({ first_seen_at: { $gte: since }, polarity: -1, severity: { $gte: s.wire.thresholds.review } }, { projection: { symbols: 1 } })
      .toArray()
      .catch((e) => {
        this.ctx.log.warn("trend core: news veto unavailable", { error: errorMessage(e) })
        return []
      })
    return new Set(items.flatMap((i) => i.symbols))
  }
}
