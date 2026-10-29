import { checkEntry } from "@mb/agent/envelope"
import type { Wake } from "@mb/agent/queue"
import { MARKET_SUBJECT, type Observation } from "@mb/core/agent"
import type { RegimeSnapshot } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { errorMessage } from "@mb/engine-kit/log"
import { upcomingMacro } from "@mb/wire/calendar"
import { classifyRegime, featuresForPrompt, type Features } from "../market/features"
import { loadFeatures, viableSetup } from "../orchestrator/crypto-cycle"
import { roundTripCostBps } from "../risk/sizing"
import { screenCrypto } from "../strategies/registry"
import { bookText, mid, type CryptoAgentDeps } from "./book"

/**
 * What wakes the crypto agent besides news (docs/plans/LOCAL-AI.md §8.1), checked by code:
 *
 *   every 3 s    the shadow book's stops and targets against the live bid; a fill is a P2
 *   every 15 s   marks, and a held pair moving `schedule.trigger_move_atr` 1 h ATRs since your last
 *                review (down: P0, up: P2), again at every further ATR
 *   every 10 min features, the regime and the screens: a viable setup on a pair not in the book is
 *                a P1, asked about again only once it can have changed (2 h; daily trend 24 h),
 *                and not at all while the envelope refuses entries
 *   each minute  a scheduled release 15 minutes out is a P2 about the market
 *   sweep        a P2 review of the book and the market every `agent.sweep_minutes`
 *
 * News comes from the wire policy's observe hook (engine.ts).
 */

const SCREEN_MS = 10 * 60_000
const MARK_MS = 15_000
const EXITS_MS = 3_000
const CALENDAR_LEAD_MS = 15 * 60_000
const REASK_MS = { daily_trend: 24 * 3_600_000, other: 2 * 3_600_000 }
/** The most setups one wake-up lists. */
const MAX_SETUPS = 5

export class CryptoMarketView {
  regime: RegimeSnapshot | null = null
  features = new Map<string, Features>()
  at = 0

  constructor(private readonly d: CryptoAgentDeps) {}

  async refresh() {
    const { features } = await loadFeatures(this.d.ctx, this.d.ctx.hub.universe)
    if (!features.length) return
    this.features = new Map(features.map((f) => [f.symbol, f]))
    this.regime = classifyRegime(features)
    this.at = Date.now()
  }
}

export class CryptoObserver {
  private last = { screen: 0, mark: 0, exits: 0, sweep: Date.now(), calendar: 0 }
  private readonly setups = new Map<string, number>()
  private readonly calendar = new Set<string>()
  private readonly moves = new Map<string, string>()

  constructor(
    private readonly d: CryptoAgentDeps,
    private readonly market: CryptoMarketView,
    private readonly observe: (o: Observation) => void,
  ) {}

  async tick(now: Date) {
    const t = now.getTime()
    if (t - this.last.exits >= EXITS_MS) {
      this.last.exits = t
      await this.exits(now)
    }
    if (t - this.last.mark >= MARK_MS) {
      this.last.mark = t
      await this.d.shadow.mark(mid(this.d.ctx))
      await this.priceMoves(now)
    }
    if (t - this.last.screen >= SCREEN_MS) {
      this.last.screen = t
      await this.screens(now).catch((e) => this.d.ctx.log.warn("agent screens failed", { error: errorMessage(e) }))
    }
    if (t - this.last.calendar >= 60_000) {
      this.last.calendar = t
      this.calendarEvents(now)
    }
    const sweepMs = this.d.ctx.settings.current.agent.sweep_minutes * 60_000
    if (t - this.last.sweep >= sweepMs) {
      this.last.sweep = t
      this.observe({ id: `sweep:${t}`, subject: MARKET_SUBJECT, kind: "sweep", priority: 2, salience: 30, summary: "Periodic review: your book, the market, and anything nothing else woke you for.", refs: {}, at: now })
    }
  }

  /** Stops and targets at the price a sale would get: the bid, while the quote is fresh. */
  private async exits(now: Date) {
    const maxAge = this.d.ctx.settings.current.kraken.max_quote_age_seconds
    const fills = await this.d.shadow.checkExits((s) => {
      const q = this.d.ctx.hub.quote(s)
      return q && q.ageS <= maxAge ? q.bid : null
    })
    for (const f of fills) {
      this.observe({
        id: `fill:${f._id}`,
        subject: f.symbol,
        kind: "fill",
        priority: 2,
        salience: 60,
        summary: `Your shadow ${f.symbol} position hit its ${f.reason === "stop_loss" ? "stop" : "target"}: sold ${f.qty} at ${roundTo(f.price, 6)}, ${f.realized_pnl_usd! >= 0 ? "+" : "-"}$${Math.abs(f.realized_pnl_usd ?? 0).toFixed(2)}.`,
        refs: { position_id: f.position_id },
        at: now,
      })
    }
  }

  private async priceMoves(now: Date) {
    const s = this.d.ctx.settings.current
    for (const p of await this.d.shadow.open()) {
      const m = mid(this.d.ctx)(p.symbol)
      const atr = this.market.features.get(p.symbol)?.atr_1h
      const ref = p.last_review_price ?? p.entry_price
      if (!m || !atr) continue
      const atrs = Math.abs(m - ref) / atr
      if (atrs < s.schedule.trigger_move_atr) continue
      // Once per review and whole ATR: a further ATR wakes it again.
      const key = `${p.last_reviewed_at?.getTime() ?? 0}:${Math.floor(atrs)}`
      if (this.moves.get(p._id) === key) continue
      this.moves.set(p._id, key)
      const down = m < ref
      this.observe({
        id: `move:${p._id}:${key}`,
        subject: p.symbol,
        kind: "price",
        priority: down ? 0 : 2,
        salience: Math.min(100, Math.round(50 + 10 * atrs)),
        summary: `${p.symbol}, which you hold, moved ${((m / ref - 1) * 100).toFixed(2)}% (${atrs.toFixed(1)} 1 h ATRs) since your last review at ${ref}; stop ${p.stop_price ?? "none"}.`,
        refs: { position_id: p._id },
        at: now,
      })
    }
  }

  /**
   * The screens' viable setups, best first, as one market-wide wake-up: the agent compares them
   * and picks, instead of being asked about each on its own. None while the envelope refuses entries.
   */
  private async screens(now: Date) {
    await this.market.refresh()
    const s = this.d.ctx.settings.current
    if (!this.market.regime) return
    const held = new Set((await this.d.shadow.open()).map((p) => p.symbol))
    const account = await this.d.shadow.account(mid(this.d.ctx))
    if (!checkEntry("", await this.d.shadow.envelopeHistory(account.equity_usd), s.agent.envelope, now.getTime()).approved) return
    const fresh = [...this.market.features.values()].filter((f) => f.quote_age_s <= s.kraken.max_quote_age_seconds)
    const viable = screenCrypto({ regime: this.market.regime, features: fresh, held, settings: s }).filter((c) => {
      const f = this.market.features.get(c.symbol)!
      const roundTrip = roundTripCostBps({ takerFeeBps: this.d.ctx.feeBps(), spreadBps: f.spread_bps, entrySlippageBps: 3, exitSlippageBps: 3 })
      if (!viableSetup(c, f.price, roundTrip, s.kraken)) return false
      return now.getTime() - (this.setups.get(`${c.symbol} ${c.strategy}`) ?? 0) >= (c.strategy === "daily_trend" ? REASK_MS.daily_trend : REASK_MS.other)
    })
    for (const c of viable.sort((a, b) => b.score - a.score).slice(0, MAX_SETUPS)) {
      const key = `${c.symbol} ${c.strategy}`
      this.setups.set(key, now.getTime())
      this.observe({
        id: `setup:${key}:${now.getTime()}`,
        subject: MARKET_SUBJECT,
        kind: "setup",
        priority: 1,
        salience: c.score,
        summary: `${c.symbol} ${c.strategy.replace("_", " ")} setup (score ${c.score}): ${c.signal} Levels from the screen: stop ${roundTo(c.stop_hint, 6)}, target ${roundTo(c.target_hint, 6)}.`,
        refs: { symbol: c.symbol },
        at: now,
      })
    }
  }

  private calendarEvents(now: Date) {
    for (const e of upcomingMacro(now, 1)) {
      const key = `${e.kind}:${e.at.toISOString()}`
      if (e.at.getTime() - now.getTime() > CALENDAR_LEAD_MS || this.calendar.has(key)) continue
      this.calendar.add(key)
      this.observe({ id: `calendar:${key}`, subject: MARKET_SUBJECT, kind: "calendar", priority: 2, salience: 55, summary: `${e.title} at ${e.at.toISOString().slice(11, 16)}Z, in ${Math.round((e.at.getTime() - now.getTime()) / 60_000)} min.`, refs: {}, at: now })
    }
  }
}

/** The bot's part of the brief: the book and its limits, the market, the subject. */
export const cryptoBrief = async (d: CryptoAgentDeps, market: CryptoMarketView, wake: Wake) => {
  if (Date.now() - market.at > SCREEN_MS) await market.refresh().catch(() => undefined)
  const r = market.regime
  const universe = d.ctx.hub.universe.map((s) => {
    const q = d.ctx.hub.quote(s)
    return q ? `${s} ${q.mid} (${q.changePct === null ? "n/a" : `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%`} 24 h)` : `${s} no quote`
  })
  const sections = [
    await bookText(d),
    `MARKET\n- regime ${r?.label ?? "unknown"}; BTC daily trend ${r?.btc_trend ?? "n/a"}; BTC 30 d volatility ${r?.btc_vol_pct ?? "n/a"}%${r?.notes.length ? `; ${r.notes.join("; ")}` : ""}\n- universe (the only pairs you may buy): ${universe.join(", ")}`,
  ]
  // The pair that woke the agent, or each pair of a market-wide wake-up's setups.
  const subjects = [wake.subject, ...wake.observations.map((o) => o.refs.symbol)].filter((s): s is string => !!s && d.ctx.hub.universe.includes(s))
  for (const symbol of [...new Set(subjects)]) {
    const f = market.features.get(symbol)
    const q = d.ctx.hub.quote(symbol)
    const shown = f ? Object.entries(featuresForPrompt(f)).filter(([k]) => /^(ret_|trend_|rsi14|atr_pct|bb_pct|breakout|vol_30d|volume_ratio|move_z)/.test(k)) : []
    sections.push(
      `SUBJECT ${symbol}\n- ${q ? `bid ${q.bid}, ask ${q.ask}, spread ${q.spreadBps.toFixed(1)} bps` : "no live quote"}\n- ${shown.length ? shown.map(([k, v]) => `${k} ${typeof v === "number" ? roundTo(v, 4) : v}`).join(", ") : "no features yet: use the features tool"}`,
    )
  }
  return { text: sections.join("\n\n"), urls: [] }
}
