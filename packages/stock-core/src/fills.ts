import type { Book, OrderDoc, OrderRole } from "./db"
import { isOptionSymbol, OPTION_MULTIPLIER } from "./options"

/** Every order the core book places (buys, sells, stops, its liquidations) carries this client_order_id prefix. */
export const CORE_ORDER_PREFIX = "smb-core-"

/** The book an order belongs to: the core book's carry CORE_ORDER_PREFIX (a leg, its parent's). */
export const orderBook = (doc: Pick<OrderDoc, "client_order_id">, parent?: Pick<OrderDoc, "client_order_id">): Book =>
  doc.client_order_id?.startsWith(CORE_ORDER_PREFIX) || parent?.client_order_id?.startsWith(CORE_ORDER_PREFIX) ? "core" : "trading"

/**
 * First-in-first-out realized P&L over the bot's fills, shared by the engine (daily stats, the AI's
 * context) and the dashboard (trades page).
 *
 * Stocks are long only: a sell with no recorded buys (a position that predates the records) gets
 * null and opens nothing. Option legs can be short (the sold leg of a debit spread), so for option
 * symbols an unmatched sell opens a short lot that a later buy closes. Option P&L is per contract,
 * so prices are multiplied by 100.
 */

export type Fill = { id: string; symbol: string; side: "buy" | "sell"; qty: number; price: number; at: Date }

export type RealizedFill = Fill & { realized_pnl: number | null; cost_basis: number | null }

export const multiplierFor = (symbol: string) => (isOptionSymbol(symbol) ? OPTION_MULTIPLIER : 1)

const EPS = 1e-9

export const realizedPnl = (fills: Fill[]): RealizedFill[] => {
  /** Open lots per symbol: positive qty = long, negative = short. */
  const lots = new Map<string, { qty: number; price: number }[]>()
  return [...fills]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((fill) => {
      const queue = lots.get(fill.symbol) ?? []
      lots.set(fill.symbol, queue)
      const dir = fill.side === "buy" ? 1 : -1
      let remaining = fill.qty
      let cost = 0
      let matched = 0
      // Close lots on the other side first, oldest first.
      while (remaining > EPS && queue.length > 0 && Math.sign(queue[0].qty) === -dir) {
        const lot = queue[0]
        const take = Math.min(Math.abs(lot.qty), remaining)
        cost += take * lot.price
        matched += take
        lot.qty += dir * take
        remaining -= take
        if (Math.abs(lot.qty) <= EPS) queue.shift()
      }
      if (remaining > EPS && (dir === 1 || isOptionSymbol(fill.symbol))) queue.push({ qty: dir * remaining, price: fill.price })
      if (matched === 0) return { ...fill, realized_pnl: null, cost_basis: null }
      // Selling closes a long (proceeds - cost); buying closes a short (credit received - cost to close).
      const gross = dir === -1 ? matched * fill.price - cost : cost - matched * fill.price
      return {
        ...fill,
        realized_pnl: Math.round(gross * multiplierFor(fill.symbol) * 100) / 100,
        cost_basis: Math.round((cost / matched) * 100) / 100,
      }
    })
}

export type OrderFill = RealizedFill & {
  role: OrderRole
  decision_id: string | null
  structure_id: string | null
  asset_class: OrderDoc["asset_class"]
  underlying: string | null
  /** The book whose order this was (orderBook). */
  book: Book
}

/** Mongo filter for order documents that are fills (spread parents excluded: their legs are the fills). */
export const FILLED_ORDERS = { status: { $in: ["filled", "partially_filled"] }, filled_qty: { $gt: 0 }, role: { $ne: "spread" }, symbol: { $ne: "" } } as const

/**
 * Filled order documents → fills with FIFO realized P&L. Exit legs inherit the decision (and options
 * position) of the order they belong to, so pass their parents too.
 */
export const fillsFromOrders = (docs: OrderDoc[], parents: OrderDoc[] = []): OrderFill[] => {
  const byId = new Map(docs.map((d) => [d._id, d]))
  const parentById = new Map([...docs, ...parents].map((p) => [p._id, p]))
  return realizedPnl(
    docs.map((d) => ({ id: d._id, symbol: d.symbol, side: d.side === "sell" ? "sell" : "buy", qty: d.filled_qty, price: d.filled_avg_price ?? 0, at: d.filled_at ?? d.created_at })),
  ).map((fill) => {
    const doc = byId.get(fill.id)!
    const parent = doc.parent_id ? parentById.get(doc.parent_id) : undefined
    return {
      ...fill,
      role: doc.role,
      decision_id: doc.decision_id ?? parent?.decision_id ?? null,
      structure_id: doc.structure_id ?? parent?.structure_id ?? null,
      asset_class: doc.asset_class ?? "us_equity",
      underlying: doc.underlying ?? null,
      book: orderBook(doc, parent),
    }
  })
}
