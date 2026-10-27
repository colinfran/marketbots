import { randomUUID } from "node:crypto"
import type { AccountDoc, FillDoc, OrderDoc, PositionDoc } from "@mb/crypto-core/db"
import { utcDay } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import type { StrategyId } from "@mb/crypto-core/strategies"
import { ACCOUNT_ID, MODE, VENUE, type AccountId } from "@mb/crypto-core/venues"
import type { EventBus } from "../bus/event-bus"
import type { Collections } from "../db/mongo"
import type { AccountState } from "../risk/engine"

/**
 * The engine's books for the paper account. Fills are the source of truth: position and account
 * documents are running totals derived from them, and `rebuild` can always recompute them from
 * fills. The Kraken CLI paper wallet is the venue of record; reconciliation compares these books
 * with the wallet's balances and history.
 *
 * The math matches the wallet's exactly: a buy costs qty × price + fee, a sale credits
 * qty × price − fee. Cost basis is average cost including entry fees; realized P&L on a sale is
 * proceeds after fees minus the cost basis of the coins sold.
 */

export type FillInput = {
  order: Pick<OrderDoc, "_id" | "account_id" | "venue" | "mode" | "instrument" | "symbol" | "side" | "reference_price" | "decision_id" | "purpose">
  qty: number
  price: number
  feeUsd: number
  at?: Date
  venueTradeId?: string | null
  fillId?: string
}

export type PositionMeta = {
  strategy_id?: StrategyId | null
  thesis?: string | null
  invalidation?: string | null
  stop_price?: number | null
  take_profit_price?: number | null
  horizon_hours?: number | null
}

export type FillOutcome = {
  fill: FillDoc
  position: PositionDoc
  opened: boolean
  closed: boolean
  /** On close: lifetime realized P&L as % of everything paid to build the position. */
  returnPct: number | null
}

const EPS = 1e-9

export class Ledger {
  constructor(
    private readonly col: Pick<Collections, "accounts" | "positions" | "fills" | "dailyStats" | "snapshots" | "orders">,
    private readonly bus: EventBus,
  ) {}

  async ensureAccount(startingUsd: number): Promise<{ account: AccountDoc; created: boolean }> {
    const id = ACCOUNT_ID
    const now = new Date()
    const res = await this.col.accounts.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          venue: VENUE,
          mode: MODE,
          cash_usd: startingUsd,
          starting_usd: startingUsd,
          realized_pnl_usd: 0,
          fees_usd: 0,
          equity_usd: startingUsd,
          exposure_usd: 0,
          peak_equity_usd: startingUsd,
          day: utcDay(now),
          day_start_equity_usd: startingUsd,
          created_at: now,
          updated_at: now,
          resets: 0,
          last_reset_at: null,
        },
      },
      { upsert: true },
    )
    return { account: (await this.col.accounts.findOne({ _id: id }))!, created: res.upsertedCount > 0 }
  }

  account(id: AccountId = ACCOUNT_ID) {
    return this.col.accounts.findOne({ _id: id })
  }

  openPositions(id: AccountId = ACCOUNT_ID) {
    return this.col.positions.find({ account_id: id, status: "open" }).toArray()
  }

  /**
   * Records one fill and updates the position and account. The fill is written first (with a
   * unique id), so a crash in between leaves the fill as the truth for `rebuild` to apply.
   */
  async recordFill(input: FillInput, meta: PositionMeta): Promise<FillOutcome> {
    const { order, qty, price, feeUsd } = input
    const at = input.at ?? new Date()
    const existing = await this.col.positions.findOne({ account_id: order.account_id, instrument: order.instrument, status: "open" })
    const isBuy = order.side === "buy"
    if (!isBuy && !existing) throw new Error(`sell fill for ${order.instrument} without an open position`)

    let position: PositionDoc
    let opened = false
    let realized: number | null = null
    if (isBuy) {
      const cost = qty * price + feeUsd
      if (existing) {
        const newQty = existing.qty + qty
        position = {
          ...existing,
          qty: newQty,
          avg_price: (existing.avg_price * existing.qty + price * qty) / newQty,
          cost_basis_usd: existing.cost_basis_usd + cost,
          fees_usd: existing.fees_usd + feeUsd,
          updated_at: at,
        }
      } else {
        opened = true
        position = {
          _id: randomUUID(),
          account_id: order.account_id,
          venue: order.venue,
          mode: order.mode,
          instrument: order.instrument,
          symbol: order.symbol,
          side: "long",
          status: "open",
          qty,
          avg_price: price,
          cost_basis_usd: cost,
          fees_usd: feeUsd,
          realized_pnl_usd: 0,
          opened_at: at,
          updated_at: at,
          closed_at: null,
          strategy_id: meta.strategy_id ?? null,
          decision_id: order.decision_id,
          thesis: meta.thesis ?? null,
          invalidation: meta.invalidation ?? null,
          stop_price: meta.stop_price ?? null,
          take_profit_price: meta.take_profit_price ?? null,
          horizon_hours: meta.horizon_hours ?? null,
          last_reviewed_at: at,
          last_review_price: price,
          mark_price: price,
          marked_at: at,
          exit_reason: null,
        }
      }
    } else {
      const pos = existing!
      const sellQty = Math.min(qty, pos.qty)
      const basis = pos.cost_basis_usd * (sellQty / pos.qty)
      realized = sellQty * price - feeUsd - basis
      const remaining = pos.qty - sellQty
      const closed = remaining <= EPS || remaining * price < 0.01
      position = {
        ...pos,
        qty: closed ? 0 : remaining,
        cost_basis_usd: closed ? 0 : pos.cost_basis_usd - basis,
        fees_usd: pos.fees_usd + feeUsd,
        realized_pnl_usd: pos.realized_pnl_usd + realized,
        updated_at: at,
        status: closed ? "closed" : "open",
        closed_at: closed ? at : null,
        exit_reason: closed ? order.purpose : pos.exit_reason,
        mark_price: price,
        marked_at: at,
      }
    }

    const fill: FillDoc = {
      _id: input.fillId ?? randomUUID(),
      order_id: order._id,
      account_id: order.account_id,
      venue: order.venue,
      mode: order.mode,
      instrument: order.instrument,
      symbol: order.symbol,
      side: order.side,
      qty,
      price,
      fee_usd: roundTo(feeUsd, 6),
      at,
      reference_price: order.reference_price,
      slippage_bps:
        order.reference_price && order.reference_price > 0
          ? roundTo(((isBuy ? price - order.reference_price : order.reference_price - price) / order.reference_price) * 10_000, 2)
          : null,
      position_id: position._id,
      realized_pnl_usd: realized === null ? null : roundTo(realized, 6),
      venue_trade_id: input.venueTradeId ?? null,
      decision_id: order.decision_id,
      purpose: order.purpose,
    }
    await this.col.fills.insertOne(fill)
    await this.col.positions.replaceOne({ _id: position._id }, position, { upsert: true })
    const cashDelta = isBuy ? -(qty * price + feeUsd) : qty * price - feeUsd
    await this.col.accounts.updateOne(
      { _id: order.account_id },
      { $inc: { cash_usd: cashDelta, fees_usd: feeUsd, realized_pnl_usd: realized ?? 0 }, $set: { updated_at: at } },
    )
    let returnPct: number | null = null
    if (position.status === "closed") {
      const [entry] = await this.col.fills
        .aggregate<{ cost: number }>([
          { $match: { position_id: position._id, side: "buy" } },
          { $group: { _id: null, cost: { $sum: { $add: [{ $multiply: ["$qty", "$price"] }, "$fee_usd"] } } } },
        ])
        .toArray()
      returnPct = entry?.cost ? roundTo((position.realized_pnl_usd / entry.cost) * 100, 3) : null
    }
    return { fill, position, opened, closed: position.status === "closed", returnPct }
  }

  /** Updates position metadata (stops, review times) without touching quantities. */
  updatePosition(id: string, fields: Partial<Pick<PositionDoc, "stop_price" | "take_profit_price" | "last_reviewed_at" | "last_review_price" | "thesis" | "invalidation" | "horizon_hours">>) {
    return this.col.positions.updateOne({ _id: id }, { $set: { ...fields, updated_at: new Date() } })
  }

  /**
   * Marks positions to market, refreshes equity, exposure and peak, and rolls the UTC day
   * (closing out the previous day's stats). `priceOf` returns null for an unpriceable instrument,
   * which then keeps its last mark.
   */
  async markToMarket(priceOf: (p: PositionDoc) => number | null, now = new Date()): Promise<AccountDoc | null> {
    const id = ACCOUNT_ID
    const account = await this.col.accounts.findOne({ _id: id })
    if (!account) return null
    const positions = await this.openPositions(id)
    let exposure = 0
    for (const p of positions) {
      const mark = priceOf(p) ?? p.mark_price ?? p.avg_price
      exposure += p.qty * mark
      if (mark !== p.mark_price) await this.col.positions.updateOne({ _id: p._id }, { $set: { mark_price: mark, marked_at: now } })
    }
    const equity = account.cash_usd + exposure
    const today = utcDay(now)
    const update: Partial<AccountDoc> = {
      equity_usd: roundTo(equity, 6),
      exposure_usd: roundTo(exposure, 6),
      peak_equity_usd: Math.max(account.peak_equity_usd, equity),
      updated_at: now,
    }
    if (account.day !== today) {
      await this.closeDay(account, account.equity_usd)
      update.day = today
      update.day_start_equity_usd = account.equity_usd
    }
    await this.col.accounts.updateOne({ _id: id }, { $set: update })
    return { ...account, ...update }
  }

  private async closeDay(account: AccountDoc, endEquity: number) {
    const start = new Date(`${account.day}T00:00:00.000Z`)
    const end = new Date(start.getTime() + 86_400_000)
    const exits = await this.col.fills.find({ account_id: account._id, at: { $gte: start, $lt: end }, realized_pnl_usd: { $ne: null } }).toArray()
    const fees = await this.col.fills.aggregate<{ fees: number; n: number }>([
      { $match: { account_id: account._id, at: { $gte: start, $lt: end } } },
      { $group: { _id: null, fees: { $sum: "$fee_usd" }, n: { $sum: 1 } } },
    ]).toArray()
    const pnl = endEquity - account.day_start_equity_usd
    await this.col.dailyStats.updateOne(
      { _id: `${account._id}:${account.day}` },
      {
        $set: {
          account_id: account._id,
          day: account.day,
          start_equity_usd: account.day_start_equity_usd,
          end_equity_usd: endEquity,
          pnl_usd: roundTo(pnl, 2),
          pnl_pct: account.day_start_equity_usd > 0 ? roundTo((pnl / account.day_start_equity_usd) * 100, 3) : 0,
          trades: fees[0]?.n ?? 0,
          wins: exits.filter((f) => (f.realized_pnl_usd ?? 0) > 0).length,
          losses: exits.filter((f) => (f.realized_pnl_usd ?? 0) < 0).length,
          fees_usd: roundTo(fees[0]?.fees ?? 0, 2),
          updated_at: new Date(),
        },
      },
      { upsert: true },
    )
  }

  async snapshot(now = new Date()) {
    const id = ACCOUNT_ID
    const account = await this.col.accounts.findOne({ _id: id })
    if (!account) return
    const positions = await this.col.positions.countDocuments({ account_id: id, status: "open" })
    await this.col.snapshots.insertOne({
      _id: randomUUID(),
      account_id: id,
      at: now,
      equity_usd: account.equity_usd,
      cash_usd: account.cash_usd,
      exposure_usd: account.exposure_usd,
      positions,
      // Five-minute snapshots kept for a year back the equity and drawdown charts.
      expires_at: new Date(now.getTime() + 365 * 86_400_000),
    })
  }

  /** Risk-engine view of an account. */
  async riskState(now = Date.now(), lookbackMinutes = 10_080): Promise<AccountState | null> {
    const id = ACCOUNT_ID
    const account = await this.col.accounts.findOne({ _id: id })
    if (!account) return null
    const positions = await this.openPositions(id)
    const dayStart = new Date(`${utcDay(new Date(now))}T00:00:00.000Z`)
    const [tradesToday, exits] = await Promise.all([
      this.col.orders.countDocuments({ account_id: id, created_at: { $gte: dayStart }, filled_qty: { $gt: 0 }, purpose: { $in: ["entry", "reduce", "exit"] } }),
      this.col.positions
        .find({ account_id: id, status: "closed", closed_at: { $gte: new Date(now - lookbackMinutes * 60_000) } }, { projection: { symbol: 1, closed_at: 1 } })
        .toArray(),
    ])
    const lastExitAt = new Map<string, number>()
    for (const e of exits) if (e.closed_at) lastExitAt.set(e.symbol, Math.max(lastExitAt.get(e.symbol) ?? 0, e.closed_at.getTime()))
    return {
      equityUsd: account.equity_usd,
      cashUsd: account.cash_usd,
      dayStartEquityUsd: account.day_start_equity_usd,
      peakEquityUsd: account.peak_equity_usd,
      positions: positions.map((p) => ({ instrument: p.instrument, symbol: p.symbol, valueUsd: p.qty * (p.mark_price ?? p.avg_price), strategyId: p.strategy_id })),
      tradesToday,
      lastExitAt,
    }
  }

  /**
   * Recomputes cash and open-position quantities from fills since the last reset, and repairs
   * the stored documents if they drifted (e.g. a crash between writing a fill and its totals).
   * Returns a description of every repair.
   */
  async rebuild(id: AccountId = ACCOUNT_ID): Promise<string[]> {
    const account = await this.col.accounts.findOne({ _id: id })
    if (!account) return []
    const since = account.last_reset_at ?? new Date(0)
    const fills = await this.col.fills.find({ account_id: id, at: { $gte: since } }).sort({ at: 1, _id: 1 }).toArray()
    let cash = account.starting_usd
    const lots = new Map<string, { qty: number; basis: number }>()
    for (const f of fills) {
      const lot = lots.get(f.instrument) ?? { qty: 0, basis: 0 }
      if (f.side === "buy") {
        cash -= f.qty * f.price + f.fee_usd
        lot.qty += f.qty
        lot.basis += f.qty * f.price + f.fee_usd
      } else {
        cash += f.qty * f.price - f.fee_usd
        const sold = Math.min(f.qty, lot.qty)
        if (lot.qty > 0) lot.basis -= lot.basis * (sold / lot.qty)
        lot.qty -= sold
      }
      lots.set(f.instrument, lot)
    }
    const issues: string[] = []
    if (Math.abs(cash - account.cash_usd) > 0.01) {
      issues.push(`cash ${account.cash_usd.toFixed(2)} → ${cash.toFixed(2)} (rebuilt from fills)`)
      await this.col.accounts.updateOne({ _id: id }, { $set: { cash_usd: cash } })
    }
    const open = await this.openPositions(id)
    for (const p of open) {
      const lot = lots.get(p.instrument)
      if (!lot || lot.qty <= EPS) {
        issues.push(`${p.instrument}: open position has no remaining fills; closed`)
        await this.col.positions.updateOne({ _id: p._id }, { $set: { status: "closed", qty: 0, closed_at: new Date(), exit_reason: "reconciliation" } })
      } else if (Math.abs(lot.qty - p.qty) > Math.max(EPS, p.qty * 1e-9)) {
        issues.push(`${p.instrument}: qty ${p.qty} → ${lot.qty}`)
        await this.col.positions.updateOne({ _id: p._id }, { $set: { qty: lot.qty, cost_basis_usd: lot.basis } })
      }
    }
    for (const [instrument, lot] of lots) {
      if (lot.qty > EPS && !open.some((p) => p.instrument === instrument)) issues.push(`${instrument}: fills imply ${lot.qty} held but no open position exists (left for manual review)`)
    }
    return issues
  }

  /** Resets the paper account to its starting balance. Old fills are kept for history. */
  async resetPaper(startingUsd: number) {
    const id = ACCOUNT_ID
    const now = new Date()
    await this.col.positions.updateMany({ account_id: id, status: "open" }, { $set: { status: "closed", qty: 0, closed_at: now, exit_reason: "paper_reset" } })
    await this.col.orders.updateMany({ account_id: id, status: { $in: ["pending_submit", "submitted", "unknown"] } }, { $set: { status: "canceled", reason: "paper reset", updated_at: now } })
    await this.col.accounts.updateOne(
      { _id: id },
      {
        $set: {
          cash_usd: startingUsd,
          starting_usd: startingUsd,
          realized_pnl_usd: 0,
          fees_usd: 0,
          equity_usd: startingUsd,
          exposure_usd: 0,
          peak_equity_usd: startingUsd,
          day: utcDay(now),
          day_start_equity_usd: startingUsd,
          updated_at: now,
          last_reset_at: now,
        },
        $inc: { resets: 1 },
      },
      { upsert: true },
    )
    this.bus.emit("alert", { level: "info", title: "Paper wallet reset", message: `Reset to $${startingUsd}` }, { summary: `Paper wallet reset to $${startingUsd.toLocaleString("en-US")}` })
  }
}
