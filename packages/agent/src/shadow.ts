import { randomUUID } from "node:crypto"
import type { ShadowAccount, ShadowFillDoc, ShadowPositionDoc } from "@mb/core/agent"
import type { BaseEventDataMap } from "@mb/core/events"
import type { EmitMeta } from "@mb/engine-kit/bus"
import type { Collection } from "mongodb"
import type { EnvelopeHistory } from "./envelope"

/**
 * The shadow book (docs/plans/LOCAL-AI.md §10, level shadow): a simulated account in which the
 * agent's decisions are filled, so they can be scored like any decision without reaching the
 * broker. Buys fill at the ask plus the bot's slippage, sells at the bid minus it, each with the
 * bot's fee; stops and targets are checked against live prices by the bot's loop
 * (`checkExits`). Long only, one position per symbol, no adding, like the bots themselves.
 *
 * The account is derived from the fills: cash is the starting cash plus every sale's proceeds minus
 * every purchase's cost, fees included. The day's starting equity is kept in memory (a restart
 * starts the day over at the current equity), and so is the peak.
 */

export type ShadowCosts = { feeBps: number; slippageBps: number }

export type ShadowCollections = { shadowPositions: Collection<ShadowPositionDoc>; shadowFills: Collection<ShadowFillDoc> }

export type ShadowEventSink = { emit(type: "agent.shadow", data: BaseEventDataMap<string, string, string>["agent.shadow"], meta: EmitMeta): unknown }

export type ShadowOptions = {
  startingUsd: () => number
  costs: () => ShadowCosts
  bus: ShadowEventSink
  /** The bot's day a moment falls in (crypto: UTC; stock: the New York trading day). */
  day: (date: Date) => string
  /** Rounds a sale's price for display and storage (the venue's tick). */
  roundPrice?: (symbol: string, price: number) => number
  now?: () => Date
}

export type ShadowEntry = {
  symbol: string
  qty: number
  /** The ask (or the last price where there is no book): slippage is added to it. */
  reference: number
  episodeId: string
  stop: number | null
  target: number | null
  horizon: string | null
  strategy: string | null
  thesis: string
  invalidation: string
  conviction: number
}

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits
const EPSILON = 1e-9
const HOUR = 3_600_000

export class ShadowBook {
  private dayStart: { day: string; equity: number } | null = null
  private peak = 0
  private readonly now: () => Date

  constructor(
    private readonly col: ShadowCollections,
    private readonly o: ShadowOptions,
  ) {
    this.now = o.now ?? (() => new Date())
  }

  open(): Promise<ShadowPositionDoc[]> {
    return this.col.shadowPositions.find({ status: "open" }).sort({ opened_at: 1 }).toArray()
  }

  position(symbol: string): Promise<ShadowPositionDoc | null> {
    return this.col.shadowPositions.findOne({ symbol, status: "open" })
  }

  async cash(): Promise<number> {
    const [flows] = await this.col.shadowFills
      .aggregate<{ net: number }>([{ $group: { _id: null, net: { $sum: { $cond: [{ $eq: ["$side", "sell"] }, { $subtract: [{ $multiply: ["$qty", "$price"] }, "$fee_usd"] }, { $multiply: [-1, { $add: [{ $multiply: ["$qty", "$price"] }, "$fee_usd"] }] }] } } } }])
      .toArray()
    return this.o.startingUsd() + (flows?.net ?? 0)
  }

  /** The account at the given marks (an open position without one counts at its entry). */
  async account(mark: (symbol: string) => number | null): Promise<ShadowAccount & { day_start_equity_usd: number; peak_equity_usd: number }> {
    const [open, cash, realized, closed] = await Promise.all([
      this.open(),
      this.cash(),
      this.col.shadowPositions.aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: "$realized_pnl_usd" } } }]).toArray(),
      this.col.shadowPositions.countDocuments({ status: "closed" }),
    ])
    const value = open.reduce((s, p) => s + p.qty * (mark(p.symbol) ?? p.mark_price ?? p.entry_price), 0)
    const cost = open.reduce((s, p) => s + p.cost_usd, 0)
    const equity = cash + value
    const starting = this.o.startingUsd()
    const day = this.o.day(this.now())
    if (!this.dayStart || this.dayStart.day !== day) this.dayStart = { day, equity }
    this.peak = Math.max(this.peak, starting, equity)
    return {
      starting_usd: starting,
      cash_usd: round(cash),
      equity_usd: round(equity),
      exposure_usd: round(value),
      realized_pnl_usd: round(realized[0]?.total ?? 0),
      unrealized_pnl_usd: round(value - cost),
      return_pct: starting > 0 ? round((equity / starting - 1) * 100) : 0,
      open_positions: open.length,
      closed_positions: closed,
      day_start_equity_usd: round(this.dayStart.equity),
      peak_equity_usd: round(this.peak),
    }
  }

  /** Buys at the reference plus slippage, with the fee. Refused when the symbol is already held or the cash isn't there. */
  async buy(e: ShadowEntry): Promise<{ ok: true; position: ShadowPositionDoc; fill: ShadowFillDoc } | { ok: false; reason: string }> {
    const { feeBps, slippageBps } = this.o.costs()
    if (!(e.qty > 0) || !(e.reference > 0)) return { ok: false, reason: "nothing to buy" }
    if (await this.position(e.symbol)) return { ok: false, reason: `${e.symbol} is already in the shadow book` }
    const price = e.reference * (1 + slippageBps / 10_000)
    const fee = (e.qty * price * feeBps) / 10_000
    const cost = e.qty * price + fee
    const cash = await this.cash()
    if (cost > cash + EPSILON) return { ok: false, reason: `the shadow book has $${round(cash)} cash, the buy costs $${round(cost)}` }
    const at = this.now()
    const position: ShadowPositionDoc = {
      _id: randomUUID(),
      symbol: e.symbol,
      status: "open",
      qty: e.qty,
      entry_price: price,
      cost_usd: cost,
      fees_usd: fee,
      opened_at: at,
      stop_price: e.stop,
      take_profit_price: e.target,
      horizon: e.horizon,
      strategy: e.strategy,
      thesis: e.thesis,
      invalidation: e.invalidation,
      conviction: e.conviction,
      episode_id: e.episodeId,
      last_reviewed_at: at,
      last_review_price: e.reference,
      mark_price: e.reference,
      marked_at: at,
      realized_pnl_usd: 0,
      closed_at: null,
      exit_price: null,
      exit_reason: null,
    }
    const fill: ShadowFillDoc = { _id: randomUUID(), position_id: position._id, symbol: e.symbol, side: "buy", qty: e.qty, price, reference_price: e.reference, fee_usd: fee, at, reason: "entry", episode_id: e.episodeId, realized_pnl_usd: null }
    await this.col.shadowPositions.insertOne(position)
    await this.col.shadowFills.insertOne(fill)
    this.o.bus.emit(
      "agent.shadow",
      { position_id: position._id, symbol: e.symbol, side: "buy", qty: e.qty, price: this.price(e.symbol, price), reason: "entry", realized_pnl_usd: null },
      { summary: `Agent (shadow) bought ${e.qty} ${e.symbol} at ${this.price(e.symbol, price)}`, instrument: e.symbol },
    )
    return { ok: true, position, fill }
  }

  /** Sells `qty` (all of it by default) at the reference minus slippage, with the fee. */
  async sell(p: ShadowPositionDoc, { qty = p.qty, reference, reason, episodeId }: { qty?: number; reference: number; reason: string; episodeId: string | null }): Promise<ShadowFillDoc | null> {
    const q = Math.min(p.qty, qty)
    if (!(q > 0) || !(reference > 0)) return null
    const { feeBps, slippageBps } = this.o.costs()
    const price = reference * (1 - slippageBps / 10_000)
    const fee = (q * price * feeBps) / 10_000
    const costShare = p.cost_usd * (q / p.qty)
    const realized = q * price - fee - costShare
    const remaining = p.qty - q
    const closed = remaining <= EPSILON * Math.max(1, p.qty)
    const at = this.now()
    const fill: ShadowFillDoc = { _id: randomUUID(), position_id: p._id, symbol: p.symbol, side: "sell", qty: q, price, reference_price: reference, fee_usd: fee, at, reason, episode_id: episodeId, realized_pnl_usd: realized }
    await this.col.shadowFills.insertOne(fill)
    await this.col.shadowPositions.updateOne(
      { _id: p._id },
      {
        $set: {
          qty: closed ? 0 : remaining,
          cost_usd: closed ? 0 : p.cost_usd - costShare,
          fees_usd: p.fees_usd + fee,
          realized_pnl_usd: p.realized_pnl_usd + realized,
          mark_price: reference,
          marked_at: at,
          ...(closed ? { status: "closed" as const, closed_at: at, exit_price: price, exit_reason: reason } : {}),
        },
      },
    )
    this.o.bus.emit(
      "agent.shadow",
      { position_id: p._id, symbol: p.symbol, side: "sell", qty: q, price: this.price(p.symbol, price), reason, realized_pnl_usd: round(realized) },
      { summary: `Agent (shadow) sold ${q} ${p.symbol} at ${this.price(p.symbol, price)} (${reason.replace(/_/g, " ")}): ${realized >= 0 ? "+" : "-"}$${Math.abs(round(realized))}`, instrument: p.symbol },
    )
    return fill
  }

  /** New exit levels or a review mark. A stop only ever moves up. */
  async update(p: ShadowPositionDoc, fields: { stop?: number | null; target?: number | null; reviewedPrice?: number | null }) {
    const stop = fields.stop !== undefined && fields.stop !== null && (p.stop_price === null || fields.stop > p.stop_price) ? fields.stop : p.stop_price
    const target = fields.target !== undefined && fields.target !== null ? fields.target : p.take_profit_price
    const review = fields.reviewedPrice !== undefined ? { last_reviewed_at: this.now(), last_review_price: fields.reviewedPrice } : {}
    await this.col.shadowPositions.updateOne({ _id: p._id }, { $set: { stop_price: stop, take_profit_price: target, ...review } })
    return { stop, target, raised: stop !== p.stop_price }
  }

  /** Marks every open position (the dashboard shows them). */
  async mark(price: (symbol: string) => number | null) {
    const at = this.now()
    for (const p of await this.open()) {
      const m = price(p.symbol)
      if (m !== null) await this.col.shadowPositions.updateOne({ _id: p._id, status: "open" }, { $set: { mark_price: m, marked_at: at } })
    }
  }

  /**
   * Stops and targets, against the price a sale would get (the bid, or the last price): a stop is
   * filled at that price (a gap through the stop fills below it), a target likewise.
   */
  async checkExits(sellPrice: (symbol: string) => number | null): Promise<ShadowFillDoc[]> {
    const fills: ShadowFillDoc[] = []
    for (const p of await this.open()) {
      const px = sellPrice(p.symbol)
      if (px === null) continue
      const reason = p.stop_price !== null && px <= p.stop_price ? "stop_loss" : p.take_profit_price !== null && px >= p.take_profit_price ? "take_profit" : null
      if (!reason) continue
      const fill = await this.sell(p, { reference: px, reason, episodeId: null })
      if (fill) fills.push(fill)
    }
    return fills
  }

  /** What the envelope needs: the last day's entries and the last action, exit and stop-out per symbol. */
  async envelopeHistory(equityUsd: number): Promise<EnvelopeHistory> {
    const now = this.now().getTime()
    const [fills, openPositions] = await Promise.all([
      this.col.shadowFills.find({ at: { $gte: new Date(now - 7 * 24 * HOUR) } }).sort({ at: 1 }).toArray(),
      this.col.shadowPositions.countDocuments({ status: "open" }),
    ])
    const lastAction = new Map<string, number>()
    const lastExit = new Map<string, number>()
    const lastStopOut = new Map<string, number>()
    const entries: EnvelopeHistory["entries"] = []
    for (const f of fills) {
      const at = f.at.getTime()
      if (f.side === "buy") {
        if (now - at < 24 * HOUR) entries.push({ symbol: f.symbol, at, notionalUsd: f.qty * f.price })
        lastAction.set(f.symbol, at)
      } else {
        // Exits the agent decided count as its actions; stops and targets fire on their own.
        if (f.episode_id) lastAction.set(f.symbol, at)
        lastExit.set(f.symbol, at)
        if (f.reason === "stop_loss") lastStopOut.set(f.symbol, at)
      }
    }
    return { equityUsd, openPositions, entries, lastAction, lastExit, lastStopOut }
  }

  private price(symbol: string, price: number) {
    return this.o.roundPrice ? this.o.roundPrice(symbol, price) : round(price, 4)
  }
}
