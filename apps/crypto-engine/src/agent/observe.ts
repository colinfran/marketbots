import { checkEntry } from "@mb/agent/envelope"
import type { Wake } from "@mb/agent/queue"
import { briefNews } from "@mb/agent/wire-tools"
import { MARKET_SUBJECT, type Observation } from "@mb/core/agent"
import type { RegimeSnapshot } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { errorMessage } from "@mb/engine-kit/log"
import { upcomingMacro } from "@mb/wire/calendar"
import { classifyRegime, featuresForPrompt, type Features } from "../market/features"
import { loadFeatures, viableSetup } from "../orchestrator/decide"
import { roundTripCostBps } from "../risk/sizing"
import { screenCrypto } from "../strategies/registry"
import { mid, type CryptoAgentDeps } from "./book"
import { cryptoWireDeps } from "./tools"
import { bookText, envelopeHistory, heldPositions } from "./view"

/**
 * What wakes the crypto agent besides news (docs/plans/LOCAL-AI.md §8.1), checked by code as the
 * data arrives:
 *
 *   every 3 s    a held pair moving `schedule.trigger_move_atr` 1 h ATRs since your last review
 *                (down: P0, up: P2), again at every further ATR; a stop or target the engine's
 *                protection loop hits is a P2 (onPositionClosed)
 *   bar close    once a minute's bars arrive from Kraken: features, the regime and the screens on
 *                the live quotes, with an interval's candles fetched afresh just after it closes
 *                (1 h, 4 h, daily). The best viable setups on pairs not in the book wake the agent
 *                together, as one P1; a setup is asked about again only once it can have changed
 *                (2 h; daily trend 24 h), and none comes while the envelope refuses entries. While
 *                no bars arrive (the feed is down), the screens still run every 10 minutes.
 *   each minute  a scheduled release 15 minutes out is a P2 about the market
 *   quiet time   a P2 review of the book and the market once nothing has woken the agent for
 *                `agent.sweep_minutes`
 *
 * News comes from the wire policy's observe hook (engine.ts).
 */

const FALLBACK_SCREEN_MS = 10 * 60_000
/** A minute's bars arrive over a few seconds: the screens wait this long after the first. */
const BAR_SETTLE_MS = 3_000
/** An interval's candles are fetched afresh for this long after it closes: Kraken can take a moment to close one. */
const CLOSE_REFRESH_MS = 2 * 60_000
const INTERVALS = [60, 240, 1440] as const
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
  private last = { screen: 0, exits: 0, sweep: Date.now(), calendar: 0 }
  /** The newest closed minute the hub has sent a bar for, when it first came, and the minute last screened. */
  private bars = { minute: 0, seenAt: 0, screened: 0 }
  private readonly setups = new Map<string, number>()
  private readonly calendar = new Set<string>()
  private readonly moves = new Map<string, string>()

  constructor(
    private readonly d: CryptoAgentDeps,
    private readonly market: CryptoMarketView,
    private readonly observe: (o: Observation) => void,
    /** When the agent's last episode finished (0: none yet), for the quiet-time review. */
    private readonly lastEpisodeAt: () => number = () => 0,
  ) {}

  /** A closed 1-minute bar of any universe pair (the hub's feed). */
  onBar(bar: { t: number }, at = Date.now()) {
    if (bar.t <= this.bars.minute) return
    this.bars.minute = bar.t
    this.bars.seenAt = at
  }

  async tick(now: Date) {
    const t = now.getTime()
    // Stops, targets and marks are the engine's (protection, marks); the agent watches the moves.
    if (t - this.last.exits >= EXITS_MS) {
      this.last.exits = t
      await this.priceMoves(now)
    }
    const barClosed = this.bars.minute > this.bars.screened && t - this.bars.seenAt >= BAR_SETTLE_MS
    if (barClosed || t - this.last.screen >= FALLBACK_SCREEN_MS) {
      this.last.screen = t
      this.bars.screened = this.bars.minute
      await this.screens(now).catch((e) => this.d.ctx.log.warn("agent screens failed", { error: errorMessage(e) }))
    }
    if (t - this.last.calendar >= 60_000) {
      this.last.calendar = t
      this.calendarEvents(now)
    }
    const sweepMs = this.d.ctx.settings.current.agent.sweep_minutes * 60_000
    const quietSince = Math.max(this.last.sweep, this.lastEpisodeAt())
    if (t - quietSince >= sweepMs) {
      this.last.sweep = t
      this.observe({
        id: `sweep:${t}`,
        subject: MARKET_SUBJECT,
        kind: "sweep",
        priority: 2,
        salience: 30,
        summary: `Quiet-time review: nothing has woken you for ${Math.round((t - quietSince) / 60_000)} min. Check your book, the market, and anything nothing else woke you for.`,
        refs: {},
        at: now,
      })
    }
  }

  private async priceMoves(now: Date) {
    const s = this.d.ctx.settings.current
    for (const p of await heldPositions(this.d)) {
      const m = mid(this.d.ctx)(p.symbol)
      const atr = this.market.features.get(p.symbol)?.atr_1h
      const ref = p.reviewPrice ?? p.entry
      if (!m || !atr) continue
      const atrs = Math.abs(m - ref) / atr
      if (atrs < s.schedule.trigger_move_atr) continue
      // Once per review and whole ATR: a further ATR wakes it again.
      const key = `${p.reviewedAt?.getTime() ?? 0}:${Math.floor(atrs)}`
      if (this.moves.get(p.id) === key) continue
      this.moves.set(p.id, key)
      const down = m < ref
      this.observe({
        id: `move:${p.id}:${key}`,
        subject: p.symbol,
        kind: "price",
        priority: down ? 0 : 2,
        salience: Math.min(100, Math.round(50 + 10 * atrs)),
        summary: `${p.symbol}, which you hold, moved ${((m / ref - 1) * 100).toFixed(2)}% (${atrs.toFixed(1)} 1 h ATRs) since your last review at ${ref}; stop ${p.stop ?? "none"}.`,
        refs: { position_id: p.id },
        at: now,
      })
    }
  }

  /** Level auto: a position the engine closed at its stop or target (the protection loop) is worth a look at what's left. */
  onPositionClosed(e: { position_id: string; instrument: string; realized_pnl_usd: number; return_pct: number | null; exit_reason: string }, now = new Date()) {
    if (e.exit_reason !== "stop_loss" && e.exit_reason !== "take_profit") return
    this.observe({
      id: `fill:${e.position_id}`,
      subject: e.instrument,
      kind: "fill",
      priority: 2,
      salience: 60,
      summary: `Your ${e.instrument} position hit its ${e.exit_reason === "stop_loss" ? "stop" : "target"}: ${e.realized_pnl_usd >= 0 ? "+" : "-"}$${Math.abs(e.realized_pnl_usd).toFixed(2)}${e.return_pct !== null ? ` (${e.return_pct >= 0 ? "+" : ""}${e.return_pct.toFixed(2)}%)` : ""}.`,
      refs: { position_id: e.position_id },
      at: now,
    })
  }

  /**
   * The screens' viable setups, best first, as one market-wide wake-up: the agent compares them
   * and picks, instead of being asked about each on its own. None while the envelope refuses entries.
   */
  private async screens(now: Date) {
    for (const interval of INTERVALS) {
      const ms = interval * 60_000
      if (now.getTime() - Math.floor(now.getTime() / ms) * ms < CLOSE_REFRESH_MS) this.d.ctx.candles.expire(interval)
    }
    await this.market.refresh()
    const s = this.d.ctx.settings.current
    if (!this.market.regime) return
    const held = new Set((await heldPositions(this.d)).map((p) => p.symbol))
    if (!checkEntry("", await envelopeHistory(this.d, now.getTime()), s.agent.envelope, now.getTime()).approved) return
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

/** The bot's part of the brief: the book and its limits, the market, each subject with its latest news (whose URLs count as seen). */
export const cryptoBrief = async (d: CryptoAgentDeps, market: CryptoMarketView, wake: Wake) => {
  if (Date.now() - market.at > FALLBACK_SCREEN_MS) await market.refresh().catch(() => undefined)
  const r = market.regime
  const universe = d.ctx.hub.universe.map((s) => {
    const q = d.ctx.hub.quote(s)
    return q ? `${s} ${q.mid} (${q.changePct === null ? "n/a" : `${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(1)}%`} 24 h)` : `${s} no quote`
  })
  const sections = [
    await bookText(d),
    `MARKET\n- regime ${r?.label ?? "unknown"}; BTC daily trend ${r?.btc_trend ?? "n/a"}; BTC 30 d volatility ${r?.btc_vol_pct ?? "n/a"}%${r?.notes.length ? `; ${r.notes.join("; ")}` : ""}\n- universe (the only pairs you may buy): ${universe.join(", ")}`,
  ]
  // The pair that woke the agent, or each pair of a market-wide wake-up's setups, with what our feeds
  // say about it: a move's catalyst, or that nothing explains it, is in front of the agent either way.
  const subjects = [wake.subject, ...wake.observations.map((o) => o.refs.symbol)].filter((s): s is string => !!s && d.ctx.hub.universe.includes(s))
  const urls: string[] = []
  const wire = cryptoWireDeps(d)
  for (const symbol of [...new Set(subjects)]) {
    const f = market.features.get(symbol)
    const q = d.ctx.hub.quote(symbol)
    const shown = f ? Object.entries(featuresForPrompt(f)).filter(([k]) => /^(ret_|trend_|rsi14|atr_pct|bb_pct|breakout|vol_30d|volume_ratio|move_z)/.test(k)) : []
    const news = await briefNews(wire, symbol)
    urls.push(...news.urls)
    sections.push(
      `SUBJECT ${symbol}\n- ${q ? `bid ${q.bid}, ask ${q.ask}, spread ${q.spreadBps.toFixed(1)} bps` : "no live quote"}\n- ${shown.length ? shown.map(([k, v]) => `${k} ${typeof v === "number" ? roundTo(v, 4) : v}`).join(", ") : "no features yet: use the features tool"}\n${news.text}`,
    )
  }
  return { text: sections.join("\n\n"), urls }
}
