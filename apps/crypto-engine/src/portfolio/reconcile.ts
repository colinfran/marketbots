import { randomUUID } from "node:crypto"
import type { DecisionDoc, OrderDoc } from "@mb/crypto-core/db"
import { ACCOUNT_ID, baseAsset, MODE, VENUE } from "@mb/crypto-core/venues"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import type { Collections } from "../db/mongo"
import type { Executor } from "../execution/executor"
import type { CliTrade, KrakenCli } from "../venues/kraken/cli"
import { DUST_USD, type Ledger, type PositionMeta } from "./ledger"

/**
 * Reconciles the engine's books with the Kraken CLI paper wallet (the venue of record).
 *
 * 1. Orders left `pending_submit` / `unknown` (crash or timeout mid-order) are matched to wallet
 *    trades by pair, side and volume. A match gets recorded as the order's fill; no match means
 *    the order never executed.
 * 2. Wallet trades the books don't know about are imported, so the books never silently miss a
 *    fill.
 * 3. USD and every coin balance are compared with the books. Any remaining difference makes the
 *    result not ok, and the risk engine blocks new entries until it's resolved (a paper reset
 *    clears it). Exits keep working. A coin the books closed out as dust (worth under
 *    `DUST_USD` at that position's last price, the ledger's own rule) isn't a difference.
 */

const USD_TOLERANCE = 0.02
const QTY_TOLERANCE = 1e-8

export type ReconcileResult = { ok: boolean; issues: string[]; imported: number; resolved: number }

const metaFromDecision = (d: DecisionDoc | null): PositionMeta => ({
  strategy_id: d?.strategy_id ?? null,
  thesis: d?.ai.thesis ?? null,
  invalidation: d?.ai.invalidation ?? null,
  stop_price: d?.sizing.stop_price ?? null,
  take_profit_price: d?.sizing.take_profit_price ?? null,
  horizon_hours: d?.ai.horizon_hours ?? null,
})

export const reconcileWallet = async (deps: {
  col: Pick<Collections, "orders" | "fills" | "decisions" | "accounts" | "positions">
  ledger: Ledger
  executor: Executor
  cli: KrakenCli
  log: Logger
}): Promise<ReconcileResult> => {
  const { col, ledger, executor, cli, log } = deps
  const issues: string[] = []
  const account = await ledger.account()
  if (!account) return { ok: false, issues: ["paper account missing"], imported: 0, resolved: 0 }
  const since = account.last_reset_at ?? new Date(0)

  let trades: CliTrade[]
  try {
    trades = await cli.history()
  } catch (error) {
    return { ok: false, issues: [`paper wallet history unavailable: ${errorMessage(error)}`], imported: 0, resolved: 0 }
  }
  const recorded = new Set(
    (await col.fills.find({ account_id: ACCOUNT_ID, at: { $gte: since }, venue_trade_id: { $ne: null } }, { projection: { venue_trade_id: 1 } }).toArray()).map((f) => f.venue_trade_id),
  )
  const unrecorded = trades.filter((t) => t.tradeId && !recorded.has(t.tradeId))

  // 1. Orders whose outcome the engine never learned.
  let resolved = 0
  const pending = await col.orders.find({ account_id: ACCOUNT_ID, status: { $in: ["pending_submit", "submitted", "unknown"] } }).sort({ created_at: 1 }).toArray()
  for (const order of pending) {
    const match = unrecorded.find(
      (t) =>
        t.pair === order.symbol &&
        t.side === order.side &&
        Math.abs(t.volume - order.qty) <= QTY_TOLERANCE * Math.max(1, order.qty) &&
        (!t.time || t.time.getTime() >= order.created_at.getTime() - 60_000),
    )
    const decision = order.decision_id ? await col.decisions.findOne({ _id: order.decision_id }) : null
    if (match) {
      unrecorded.splice(unrecorded.indexOf(match), 1)
      const outcomes = await executor.recordFills(order, [{ qty: match.volume, price: match.price, feeUsd: match.fee, venueTradeId: match.tradeId, at: match.time ?? undefined }], metaFromDecision(decision))
      await executor.finalize(order, { status: "filled", venueOrderId: match.orderId || null, fills: [], reason: "recovered by reconciliation" }, outcomes)
      issues.push(`order ${order._id.slice(0, 8)} (${order.side} ${order.qty} ${order.symbol}) had an unknown outcome; found in the wallet and recorded`)
    } else {
      await executor.finalize(order, { status: "rejected", venueOrderId: null, fills: [], reason: "not executed by the paper wallet (reconciliation)" }, [])
    }
    resolved += 1
  }

  // 2. Wallet trades the books don't have.
  let imported = 0
  for (const t of unrecorded) {
    if (t.time && t.time < since) continue
    const order: OrderDoc = {
      _id: randomUUID(),
      account_id: ACCOUNT_ID,
      venue: VENUE,
      mode: MODE,
      instrument: t.pair,
      symbol: t.pair,
      side: t.side,
      type: "market",
      qty: t.volume,
      limit_price: null,
      reference_price: null,
      status: "submitted",
      venue_order_id: t.orderId || null,
      filled_qty: 0,
      avg_fill_price: null,
      fees_usd: 0,
      decision_id: null,
      position_id: null,
      purpose: "reconciliation",
      created_at: t.time ?? new Date(),
      submitted_at: t.time ?? new Date(),
      updated_at: new Date(),
      reason: "imported from the paper wallet",
      history: [],
    }
    await col.orders.insertOne(order)
    const outcomes = await executor.recordFills(order, [{ qty: t.volume, price: t.price, feeUsd: t.fee, venueTradeId: t.tradeId, at: t.time ?? undefined }], {})
    await executor.finalize(order, { status: "filled", venueOrderId: t.orderId || null, fills: [], reason: "imported from the paper wallet" }, outcomes)
    if (outcomes.length) imported += 1
    issues.push(`wallet trade ${t.tradeId} (${t.side} ${t.volume} ${t.pair}) was missing from the books${outcomes.length ? "; imported" : " and could not be imported"}`)
  }

  // 3. Balances.
  const [balances, refreshed, positions] = await Promise.all([cli.balance(), ledger.account(), ledger.openPositions()])
  const walletUsd = balances.USD?.total ?? 0
  const booksUsd = refreshed?.cash_usd ?? 0
  let mismatched = false
  if (Math.abs(walletUsd - booksUsd) > USD_TOLERANCE) {
    mismatched = true
    issues.push(`USD: wallet ${walletUsd.toFixed(2)} vs books ${booksUsd.toFixed(2)}`)
  }
  const held = new Map(positions.map((p) => [baseAsset(p.symbol), p]))
  /** Whether `qty` of `asset` is what the books' last closed position in it left as dust. */
  const isDust = async (asset: string, qty: number) => {
    const closed = col.positions.find(
      { account_id: ACCOUNT_ID, status: "closed", closed_at: { $gte: since } },
      { sort: { closed_at: -1 }, projection: { symbol: 1, mark_price: 1, avg_price: 1 } },
    )
    for await (const p of closed) {
      if (baseAsset(p.symbol) === asset) return qty * (p.mark_price ?? p.avg_price) < DUST_USD
    }
    return false
  }
  for (const [asset, b] of Object.entries(balances)) {
    if (asset === "USD" || b.total <= QTY_TOLERANCE) continue
    const p = held.get(asset)
    if (!p) {
      if (await isDust(asset, b.total)) continue
      mismatched = true
      issues.push(`${asset}: wallet holds ${b.total} but the books have no open position`)
    } else if (Math.abs(p.qty - b.total) > QTY_TOLERANCE * Math.max(1, p.qty)) {
      mismatched = true
      issues.push(`${asset}: wallet ${b.total} vs books ${p.qty}`)
    }
  }
  for (const [asset, p] of held) {
    if ((balances[asset]?.total ?? 0) <= QTY_TOLERANCE) {
      mismatched = true
      issues.push(`${p.symbol}: books hold ${p.qty} but the wallet has none`)
    }
  }
  if (issues.length) log.warn("paper wallet reconciliation", { issues, imported, resolved })
  return { ok: !mismatched, issues, imported, resolved }
}
