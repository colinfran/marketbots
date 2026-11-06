import type { DecisionDoc, PositionDoc } from "@mb/crypto-core/db"
import type { NormalizedCryptoDecision } from "@mb/crypto-core/report"
import { errorMessage } from "@mb/engine-kit/log"
import type { Features } from "../market/features"
import { correlationMatrix } from "../risk/correlation"
import { coreCandidates, coreRegime, coreTrendBroken } from "../strategies/core"
import type { CryptoCandidate } from "../strategies/types"
import type { EngineContext } from "./context"
import { loadFeatures, processDecision } from "./decide"

/**
 * The trend core's runner (its rules: ../strategies/core). It trades by itself, through the same
 * risk engine, executor and ledger as the agent, and records a `decisions` document for every
 * entry and exit (trigger_kind "core", model "rules"):
 *
 *   each hour    3 minutes after the hourly candle closes: while BTC is above its 50-day average,
 *                fill the free core slots with the strongest qualifying pairs not held, skipping a
 *                pair the core left within core.reentry_hours or with negative news at review
 *                severity within core.news_veto_hours;
 *   each day     in that hour after the daily close (00:03 UTC): close core positions whose trend
 *                broke (below the 50-day average).
 *
 * The trailing stop (the protection loop) is its other exit. It waits while an agent episode runs,
 * and opens nothing while the agent's entries are paused by the drawdown breaker or the engine's
 * gate refuses entries. strategies.core.enabled turns it off.
 */

const HOUR = 3_600_000
/** Kraken can take a moment to close a candle. */
const SETTLE_MS = 3 * 60_000
/** Scored after this many hours, like an agent decision's horizon. */
const HORIZON_HOURS = 720
/** No attempt while less cash than this share of equity is free: the risk engine would only refuse it. */
const MIN_FREE_CASH = 0.02

export const CORE_MODEL = "rules"
export const CORE_VERSION = "trend-core-v1"

const decisionFor = (symbol: string, action: "buy" | "close", thesis: string, stop: number | null): NormalizedCryptoDecision => ({
  symbol,
  action,
  conviction: 100,
  uncertainty: "medium",
  p_target_first: null,
  stop_loss: stop,
  take_profit: null,
  horizon_hours: HORIZON_HOURS,
  size_pct_of_max: null,
  reduce_pct: null,
  priced_in: "unknown",
  thesis,
  bull_evidence: [],
  bear_evidence: [],
  risks: [],
  invalidation: "The trailing stop, or the price below its 50-day average at the daily close.",
  notes: [],
  defaulted: false,
})

export class CryptoCore {
  private lastHour = -1
  private lastExitDay = ""

  constructor(
    private readonly ctx: EngineContext,
    /** Why new entries are paused (the agent's drawdown breaker), or null. */
    private readonly entriesPaused: () => string | null,
    /** An agent episode is deciding: the core waits for it. */
    private readonly busy: () => boolean,
    /** The universe's features (the screens' own, from the candle cache). */
    private readonly load: (symbols: string[]) => Promise<Features[]> = async (symbols) => (await loadFeatures(ctx, symbols)).features,
  ) {}

  /** Called every minute; acts once an hour. */
  async tick(now = new Date()) {
    const s = this.ctx.settings.current
    if (!s.strategies.core.enabled || this.busy()) return
    const t = now.getTime()
    const hour = Math.floor(t / HOUR)
    if (hour === this.lastHour || t - hour * HOUR < SETTLE_MS) return
    this.lastHour = hour
    const day = now.toISOString().slice(0, 10)
    const exitsDue = now.getUTCHours() === 0 && day !== this.lastExitDay
    if (exitsDue) this.lastExitDay = day
    try {
      const features = await this.load(this.ctx.hub.universe)
      const byPair = new Map(features.map((f) => [f.symbol, f]))
      const matrix = correlationMatrix(new Map(features.map((f) => [f.symbol, f.closes_1h])))
      const cycleId = `core:${now.toISOString().slice(0, 13)}`
      const notes: string[] = []
      if (exitsDue) notes.push(...(await this.exits(cycleId, byPair, matrix)))
      notes.push(...(await this.entries(cycleId, features, byPair, matrix, now)))
      if (notes.length) this.ctx.log.info("trend core", { notes })
    } finally {
      this.ctx.setCycleState("idle")
    }
  }

  /** Closes every core position whose trend broke. */
  private async exits(cycleId: string, byPair: Map<string, Features>, matrix: ReturnType<typeof correlationMatrix>): Promise<string[]> {
    const notes: string[] = []
    for (const p of (await this.ctx.ledger.openPositions()).filter((x) => x.strategy_id === "core")) {
      const f = byPair.get(p.symbol)
      if (!f || !coreTrendBroken(f)) continue
      const thesis = `Trend broke: ${p.symbol} at ${f.price} closed the day below its 50-day average ${f.sma50_1d}.`
      const doc = await this.decide(cycleId, decisionFor(p.symbol, "close", thesis, null), null, p, f, matrix)
      notes.push(`${p.symbol}: trend broke, close ${doc.execution.status}`)
      if (doc.execution.filled_qty > 0) {
        await this.ctx.alerts.success(`Trend core sold ${p.symbol}`, `[paper] ${thesis}`, { path: `/decisions/${doc._id}`, key: `core-exit|${doc._id}` }).catch(() => undefined)
      }
    }
    return notes
  }

  /** Fills the free core slots with the strongest qualifying pairs. */
  private async entries(cycleId: string, features: Features[], byPair: Map<string, Features>, matrix: ReturnType<typeof correlationMatrix>, now: Date): Promise<string[]> {
    const s = this.ctx.settings.current
    const regime = coreRegime(byPair.get("BTC/USD"))
    if (!regime.on) return [`no entries: ${regime.detail}`]
    const paused = this.entriesPaused()
    if (paused) return [`no entries: ${paused}`]
    const g = this.ctx.gate()
    if (g.runStatus !== "running" || g.killSwitch || !g.venueOnline || !g.reconciled) return []
    const open = await this.ctx.ledger.openPositions()
    let slots = s.core.max_positions - open.filter((p) => p.strategy_id === "core").length
    if (slots <= 0) return []
    const state = await this.ctx.ledger.riskState(now.getTime())
    if (!state || state.cashUsd < state.equityUsd * MIN_FREE_CASH) return []
    const held = new Set(open.map((p) => p.symbol))
    const [left, vetoed] = await Promise.all([this.recentlyLeft(now), this.vetoed(now)])
    const fresh = features.filter((f) => f.quote_age_s <= s.kraken.max_quote_age_seconds)
    const notes: string[] = []
    for (const c of coreCandidates(fresh, s)) {
      if (slots <= 0) break
      if (held.has(c.symbol)) continue
      if (left.has(c.symbol)) {
        notes.push(`${c.symbol}: left within ${s.core.reentry_hours} h`)
        continue
      }
      if (vetoed.has(c.symbol)) {
        notes.push(`${c.symbol}: vetoed by negative news`)
        continue
      }
      const doc = await this.decide(cycleId, decisionFor(c.symbol, "buy", c.signal, c.stop_hint), c, null, byPair.get(c.symbol) ?? null, matrix)
      notes.push(`${c.symbol}: buy ${doc.execution.status}${doc.risk?.approved === false ? ` (${doc.risk.reasons[0] ?? "refused"})` : ""}`)
      if (doc.execution.filled_qty > 0) {
        slots -= 1
        held.add(c.symbol)
      }
    }
    return notes
  }

  private decide(cycleId: string, decision: NormalizedCryptoDecision, candidate: CryptoCandidate | null, position: PositionDoc | null, features: Features | null, matrix: ReturnType<typeof correlationMatrix>): Promise<DecisionDoc> {
    return processDecision(this.ctx, {
      cycleId,
      researchId: null,
      decision,
      candidate,
      position,
      features,
      takerBps: this.ctx.feeBps(),
      matrix,
      decisionModel: CORE_MODEL,
      triggerKind: "core",
      promptVersion: CORE_VERSION,
      rules: true,
    })
  }

  /** Pairs the core left (any exit) within core.reentry_hours. */
  private async recentlyLeft(now: Date): Promise<Set<string>> {
    const since = new Date(now.getTime() - this.ctx.settings.current.core.reentry_hours * HOUR)
    const closed = await this.ctx.col.positions.find({ strategy_id: "core", status: "closed", closed_at: { $gte: since } }, { projection: { symbol: 1 } }).toArray()
    return new Set(closed.map((p) => p.symbol))
  }

  /** Pairs with negative news at review severity or above within core.news_veto_hours. */
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
