import { weeklyCloseVs200 } from "@mb/core/indicators"
import type { DecisionDoc, PositionDoc } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import type { NormalizedCryptoDecision } from "@mb/crypto-core/report"
import { correlationMatrix } from "../risk/correlation"
import type { CryptoCandidate } from "../strategies/types"
import type { Candle } from "../venues/kraken/rest"
import type { EngineContext } from "./context"
import { processDecision } from "./decide"

/**
 * The long-term book (docs/CRYPTO.md, "The long-term book"): BTC and ETH held for the long term,
 * through short-term swings, at long_term.btc_pct and eth_pct of equity. Once an hour, 3 minutes
 * after the hourly candle closes, for each:
 *
 *   held by the book, and the last completed week (Monday 00:00 UTC) closed below its 200-day
 *   average: sold;
 *   not held, and that week closed above it: bought to its share of equity (no stop, no target).
 *
 * So a sale waits for a weekly close below the 200-day average, and a buy-back for one above it.
 * Its trades go through the risk engine with every account gate and the per-asset, exposure and
 * cash caps, and are `decisions` documents (trigger_kind "long_term", model "rules"). It opens
 * nothing while the drawdown breaker pauses entries, and waits while an agent episode runs.
 * strategies.long_term.enabled turns it off.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const SETTLE_MS = 3 * 60_000
const HORIZON_HOURS = 2_160

export const LONG_TERM_MODEL = "rules"
export const LONG_TERM_VERSION = "long-term-v1"

/** Monday 00:00 UTC of the week `t` falls in. */
export const weekStartUtc = (t: number) => {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY
}

const decisionFor = (symbol: string, action: "buy" | "close", thesis: string): NormalizedCryptoDecision => ({
  symbol,
  action,
  conviction: 100,
  uncertainty: "medium",
  p_target_first: null,
  stop_loss: null,
  take_profit: null,
  horizon_hours: HORIZON_HOURS,
  size_pct_of_max: null,
  reduce_pct: null,
  priced_in: "unknown",
  thesis,
  bull_evidence: [],
  bear_evidence: [],
  risks: [],
  invalidation: "A week closing below its 200-day average.",
  notes: [],
  defaulted: false,
})

export class CryptoLongTerm {
  private lastHour = -1

  constructor(
    private readonly ctx: EngineContext,
    /** Why new entries are paused (the agent's drawdown breaker), or null. */
    private readonly entriesPaused: () => string | null,
    /** An agent episode is deciding: the book waits for it. */
    private readonly busy: () => boolean,
    /** Completed daily candles of a pair (the candle cache). */
    private readonly daily: (symbol: string) => Promise<Candle[]> = (symbol) => ctx.candles.get(symbol, 1440),
  ) {}

  /** The book's holdings and their shares of equity. */
  targets(): { symbol: string; pct: number }[] {
    const lt = this.ctx.settings.current.long_term
    return [
      { symbol: "BTC/USD", pct: lt.btc_pct },
      { symbol: "ETH/USD", pct: lt.eth_pct },
    ].filter((x) => x.pct > 0 && this.ctx.hub.universe.includes(x.symbol))
  }

  /** Called every minute; acts once an hour. */
  async tick(now = new Date()) {
    if (!this.ctx.settings.current.strategies.long_term.enabled || this.busy()) return
    const t = now.getTime()
    const hour = Math.floor(t / HOUR)
    if (hour === this.lastHour || t - hour * HOUR < SETTLE_MS) return
    this.lastHour = hour
    const notes: string[] = []
    try {
      const open = await this.ctx.ledger.openPositions()
      const cycleId = `long_term:${now.toISOString().slice(0, 13)}`
      for (const { symbol, pct } of this.targets()) {
        const trend = weeklyCloseVs200((await this.daily(symbol)).map((c) => ({ t: c.t, close: c.close })), weekStartUtc(t))
        if (!trend) {
          notes.push(`${symbol}: not 200 days of history`)
          continue
        }
        const vs = `last week closed at ${roundTo(trend.close, 2)}, ${roundTo((trend.close / trend.sma200 - 1) * 100, 2)}% vs its 200-day average ${roundTo(trend.sma200, 2)}`
        const position = open.find((p) => p.symbol === symbol) ?? null
        if (position?.strategy_id === "long_term") {
          if (!trend.above) notes.push(await this.sell(cycleId, position, `${symbol}'s long-term trend broke: ${vs}.`))
        } else if (position) notes.push(`${symbol}: held by ${position.strategy_id ?? "an earlier trade"}`)
        else if (trend.above) notes.push(await this.buy(cycleId, symbol, pct, `Long-term book: ${symbol} at ${pct}% of equity, held while its weekly close stays above its 200-day average: ${vs}.`))
      }
    } finally {
      this.ctx.setCycleState("idle")
    }
    if (notes.length) this.ctx.log.info("long-term book", { notes })
  }

  private async buy(cycleId: string, symbol: string, pct: number, thesis: string): Promise<string> {
    const paused = this.entriesPaused()
    if (paused) return `${symbol}: not bought (${paused})`
    const g = this.ctx.gate()
    if (g.runStatus !== "running" || g.killSwitch || !g.venueOnline || !g.reconciled) return `${symbol}: not bought (the engine's gate refuses entries)`
    const candidate: CryptoCandidate = { instrument: symbol, symbol, strategy: "long_term", score: 100, signal: thesis, features: {}, stop_hint: 0, target_hint: 0 }
    const doc = await this.decide(cycleId, decisionFor(symbol, "buy", thesis), candidate, null, { targetPct: pct })
    return `${symbol}: buy ${doc.execution.status}${doc.risk?.approved === false ? ` (${doc.risk.reasons[0] ?? "refused"})` : ""}`
  }

  private async sell(cycleId: string, position: PositionDoc, thesis: string): Promise<string> {
    const doc = await this.decide(cycleId, decisionFor(position.symbol, "close", thesis), null, position)
    if (doc.execution.filled_qty > 0) {
      await this.ctx.alerts.success(`Long-term book sold ${position.symbol}`, `[paper] ${thesis}`, { path: `/decisions/${doc._id}`, key: `long-term-exit|${doc._id}` }).catch(() => undefined)
    }
    return `${position.symbol}: sell ${doc.execution.status}`
  }

  private decide(cycleId: string, decision: NormalizedCryptoDecision, candidate: CryptoCandidate | null, position: PositionDoc | null, longTerm?: { targetPct: number }): Promise<DecisionDoc> {
    return processDecision(this.ctx, {
      cycleId,
      researchId: null,
      decision,
      candidate,
      position,
      features: null,
      takerBps: this.ctx.feeBps(),
      matrix: correlationMatrix(new Map()),
      decisionModel: LONG_TERM_MODEL,
      triggerKind: "long_term",
      promptVersion: LONG_TERM_VERSION,
      rules: true,
      longTerm,
    })
  }
}
