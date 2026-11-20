import type { DecisionDoc } from "@mb/crypto-core/db"
import { MAX_HORIZON_HOURS, type NormalizedCryptoDecision } from "@mb/crypto-core/report"
import { correlationMatrix } from "../risk/correlation"
import type { CryptoCandidate } from "../strategies/types"
import type { EngineContext } from "./context"
import { processDecision } from "./decide"

/**
 * The long-term book (docs/CRYPTO.md, "The long-term book"): BTC, ETH and SOL held for months to
 * years, through drawdowns, at long_term.btc_pct, eth_pct and sol_pct of equity. Once an hour,
 * 3 minutes after the hourly candle closes, it buys the first of them it doesn't hold, at its share
 * of equity, with no stop and no target, once long_term.stagger_hours clock hours have passed since
 * its last buy: the entries are spread out, so no single moment sets every price.
 *
 * It never sells. There is no trend rule, no stop and no target, and the agent can't sell, reduce,
 * stop or target its holdings (agent/live.ts, orchestrator/decide.ts, orchestrator/protection.ts).
 * Only the owner sells one: set its share to 0 first, or the book buys it back.
 *
 * Its buys go through the risk engine with every account gate and the per-asset, exposure and cash
 * caps, and are `decisions` documents (trigger_kind "long_term", model "rules"). It buys nothing
 * while the drawdown breaker pauses entries, and waits while an agent episode runs.
 * strategies.long_term.enabled turns it off.
 */

const HOUR = 3_600_000
const SETTLE_MS = 3 * 60_000

export const LONG_TERM_MODEL = "rules"
export const LONG_TERM_VERSION = "long-term-v2"

const buyDecision = (symbol: string, thesis: string): NormalizedCryptoDecision => ({
  symbol,
  action: "buy",
  conviction: 100,
  uncertainty: "medium",
  p_target_first: null,
  stop_loss: null,
  take_profit: null,
  horizon_hours: MAX_HORIZON_HOURS,
  size_pct_of_max: null,
  reduce_pct: null,
  priced_in: "unknown",
  thesis,
  bull_evidence: [],
  bear_evidence: [],
  risks: [],
  invalidation: "None: held for months to years, through drawdowns; only the owner sells it.",
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
  ) {}

  /** The book's holdings and their shares of equity, in buying order. */
  targets(): { symbol: string; pct: number }[] {
    const lt = this.ctx.settings.current.long_term
    return [
      { symbol: "BTC/USD", pct: lt.btc_pct },
      { symbol: "ETH/USD", pct: lt.eth_pct },
      { symbol: "SOL/USD", pct: lt.sol_pct },
    ].filter((x) => x.pct > 0 && this.ctx.hub.universe.includes(x.symbol))
  }

  /** Clock hours until the book may buy again (0: now), counted from its last buy's hour. */
  private async hoursToNextBuy(hour: number): Promise<number> {
    const stagger = this.ctx.settings.current.long_term.stagger_hours
    if (stagger <= 0) return 0
    const last = await this.ctx.col.positions.findOne({ strategy_id: "long_term" }, { sort: { opened_at: -1 }, projection: { opened_at: 1 } })
    if (!last?.opened_at) return 0
    return Math.max(0, Math.floor(last.opened_at.getTime() / HOUR) + stagger - hour)
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
      const staggered = this.ctx.settings.current.long_term.stagger_hours > 0
      for (const { symbol, pct } of this.targets()) {
        const position = open.find((p) => p.symbol === symbol) ?? null
        if (position?.strategy_id === "long_term") continue
        if (position) {
          notes.push(`${symbol}: held by ${position.strategy_id ?? "an earlier trade"}`)
          continue
        }
        const wait = await this.hoursToNextBuy(hour)
        if (wait > 0) {
          notes.push(`${symbol}: next buy in ${wait} h (long_term.stagger_hours)`)
          break
        }
        const { note, filled } = await this.buy(cycleId, symbol, pct)
        notes.push(note)
        if (filled && staggered) break
      }
    } finally {
      this.ctx.setCycleState("idle")
    }
    if (notes.length) this.ctx.log.info("long-term book", { notes })
  }

  private async buy(cycleId: string, symbol: string, pct: number): Promise<{ note: string; filled: boolean }> {
    const paused = this.entriesPaused()
    if (paused) return { note: `${symbol}: not bought (${paused})`, filled: false }
    const g = this.ctx.gate()
    if (g.runStatus !== "running" || g.killSwitch || !g.venueOnline || !g.reconciled) return { note: `${symbol}: not bought (the engine's gate refuses entries)`, filled: false }
    const thesis = `Long-term book: ${symbol} at ${pct}% of equity, held for months to years through drawdowns, with no stop and no target; the bot never sells it.`
    const candidate: CryptoCandidate = { instrument: symbol, symbol, strategy: "long_term", score: 100, signal: thesis, features: {}, stop_hint: 0, target_hint: 0 }
    const doc = await this.decide(cycleId, buyDecision(symbol, thesis), candidate, { targetPct: pct })
    return {
      note: `${symbol}: buy ${doc.execution.status}${doc.risk?.approved === false ? ` (${doc.risk.reasons[0] ?? "refused"})` : ""}`,
      filled: doc.execution.filled_qty > 0,
    }
  }

  private decide(cycleId: string, decision: NormalizedCryptoDecision, candidate: CryptoCandidate, longTerm: { targetPct: number }): Promise<DecisionDoc> {
    return processDecision(this.ctx, {
      cycleId,
      researchId: null,
      decision,
      candidate,
      position: null,
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
