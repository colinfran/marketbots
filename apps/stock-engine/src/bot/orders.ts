import { randomUUID } from "node:crypto"
import type { AlpacaOrder } from "@mb/stock-core/alpaca"
import type { OrderDoc, OrderRole } from "@mb/stock-core/db"
import { FILLED_ORDERS, fillsFromOrders, type OrderFill } from "@mb/stock-core/fills"
import { isOptionSymbol, parseOcc } from "@mb/stock-core/options"
import { marketDay } from "@mb/stock-core/time"
import type { AnyBulkWriteOperation } from "mongodb"
import type { Alpaca } from "../alpaca/client"
import type { Collections } from "../db/mongo"

/**
 * Keeps the `orders` collection in sync with Alpaca so every fill is recorded, including
 * stop-loss / take-profit legs that Alpaca triggers on its own and the legs of options spreads.
 * Orders arrive three ways: right after the bot places them, from the trade_updates stream, and
 * from a periodic REST sync that catches anything the stream missed.
 */

const TERMINAL = new Set(["filled", "canceled", "expired", "replaced", "rejected", "suspended", "stopped"])
const FINAL = new Set(["filled", "canceled", "expired", "rejected", "suspended", "stopped"])

export const clientId = (kind: string) => `smb-${kind}-${randomUUID().slice(0, 18)}`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls an order until it reaches a final state or the timeout passes. */
export const waitForFill = async (alpaca: Pick<Alpaca, "getOrder">, order: AlpacaOrder, timeoutMs = 15_000): Promise<AlpacaOrder> => {
  let current = order
  const started = Date.now()
  while (!FINAL.has(current.status) && Date.now() - started < timeoutMs) {
    await sleep(750)
    current = await alpaca.getOrder(order.id)
  }
  return current
}

const toNumber = (value: string | null | undefined) => (value === null || value === undefined || value === "" ? null : Number(value))
const toDate = (value: string | null | undefined) => (value ? new Date(value) : null)

const roleFor = (order: AlpacaOrder, parent: AlpacaOrder | null): OrderRole => {
  if (order.order_class === "mleg" && !order.symbol) return "spread"
  if (order.position_intent) return order.position_intent.endsWith("_to_open") ? "entry" : "exit"
  if (parent?.order_class === "mleg") return order.side === "buy" ? "entry" : "exit"
  if (parent) return order.type === "limit" ? "take_profit" : "stop_loss"
  if (order.order_class === "oco") return "take_profit"
  return order.side === "buy" ? "entry" : "exit"
}

const flatten = (orders: AlpacaOrder[]): { order: AlpacaOrder; parent: AlpacaOrder | null }[] =>
  orders.flatMap((order) => [{ order, parent: null }, ...(order.legs ?? []).map((leg) => ({ order: leg, parent: order }))])

/** Fields that describe what the order is (set once; repaired when the parent is known). */
const identity = (order: AlpacaOrder, parent: AlpacaOrder | null) => {
  const option = isOptionSymbol(order.symbol) || order.asset_class === "us_option"
  return {
    client_order_id: order.client_order_id,
    symbol: order.symbol,
    asset_class: option || order.order_class === "mleg" ? ("us_option" as const) : ("us_equity" as const),
    underlying: option ? (parseOcc(order.symbol)?.root ?? null) : null,
    side: order.side,
    type: order.type,
    order_class: order.order_class || "simple",
    role: roleFor(order, parent),
    position_intent: order.position_intent ?? null,
    parent_id: parent?.id ?? null,
    created_at: new Date(order.created_at),
  }
}

/** Fields that change as the order works. */
const progress = (order: AlpacaOrder) => {
  const filledAt = toDate(order.filled_at)
  return {
    qty: toNumber(order.qty),
    filled_qty: Number(order.filled_qty ?? 0),
    filled_avg_price: toNumber(order.filled_avg_price),
    limit_price: toNumber(order.limit_price),
    stop_price: toNumber(order.stop_price),
    status: order.status,
    submitted_at: toDate(order.submitted_at),
    filled_at: filledAt,
    canceled_at: toDate(order.canceled_at),
    trading_day: marketDay(filledAt ?? new Date(order.created_at)),
    synced_at: new Date(),
  }
}

export type OrderLinks = { decisionId?: string | null; structureId?: string | null }

/**
 * Upserts Alpaca orders (and their legs). `links` ties newly placed orders to the decision and
 * options position that caused them. A leg seen without its parent (a trade update) never
 * overwrites what's already known about it.
 */
export const saveOrders = async (col: Pick<Collections, "orders">, orders: AlpacaOrder[], { decisionId = null, structureId = null }: OrderLinks = {}) => {
  if (orders.length === 0) return
  const ops: AnyBulkWriteOperation<OrderDoc>[] = flatten(orders).map(({ order, parent }) => {
    const id = identity(order, parent)
    const known = parent !== null || order.legs?.length
    return {
      updateOne: {
        filter: { _id: order.id },
        update: {
          $set: {
            ...progress(order),
            ...(known ? id : {}),
            ...(decisionId ? { decision_id: decisionId } : {}),
            ...(structureId ? { structure_id: structureId } : {}),
          },
          $setOnInsert: {
            ...(known ? {} : id),
            ...(decisionId ? {} : { decision_id: null }),
            ...(structureId ? {} : { structure_id: null }),
          },
        },
        upsert: true,
      },
    }
  })
  await col.orders.bulkWrite(ops, { ordered: false })
}

/**
 * Pulls recent orders (default: last 14 days) plus every order still recorded as non-terminal,
 * so legs that fill days later are never missed. Returns how many fills are recorded.
 */
export const syncOrders = async (col: Pick<Collections, "orders">, alpaca: Pick<Alpaca, "listOrders" | "getOrder">, lookbackDays = 14) => {
  const since = new Date(Date.now() - lookbackDays * 86_400_000)
  const fetched: AlpacaOrder[] = []
  let until: string | undefined
  for (let page = 0; page < 10; page++) {
    const batch = await alpaca.listOrders({ status: "all", after: since.toISOString(), until, limit: 500, nested: true, direction: "desc" })
    fetched.push(...batch)
    if (batch.length < 500) break
    until = batch[batch.length - 1].submitted_at ?? batch[batch.length - 1].created_at
  }
  await saveOrders(col, fetched)

  const seen = new Set(flatten(fetched).map(({ order }) => order.id))
  const stale = await col.orders.find({ status: { $nin: [...TERMINAL] }, _id: { $nin: [...seen] } }, { projection: { _id: 1, parent_id: 1 } }).limit(50).toArray()
  const roots = [...new Set(stale.map((o) => o.parent_id ?? o._id))]
  const refreshed = await Promise.all(roots.map((id) => alpaca.getOrder(id).catch(() => null)))
  await saveOrders(col, refreshed.filter((o): o is AlpacaOrder => o !== null))
  return col.orders.countDocuments({ status: { $in: ["filled", "partially_filled"] } })
}

export type BotFill = OrderFill

/** All fills (optionally filtered), with FIFO realized P&L. */
export const loadRealizedFills = async (col: Pick<Collections, "orders">, filter: Record<string, unknown> = {}): Promise<BotFill[]> => {
  const docs = await col.orders.find({ ...FILLED_ORDERS, ...filter }).sort({ filled_at: 1 }).toArray()
  const parentIds = [...new Set(docs.map((d) => d.parent_id).filter((id): id is string => !!id))]
  const parents = parentIds.length ? await col.orders.find({ _id: { $in: parentIds } }).toArray() : []
  return fillsFromOrders(docs, parents)
}
