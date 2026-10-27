import type { AlpacaOrder, TradeUpdate } from "@mb/stock-core/alpaca"
import { describeContract, isOptionSymbol, parseOcc } from "@mb/stock-core/options"
import type { TradingContext } from "./context"
import { loadRealizedFills, saveOrders } from "./orders"

/**
 * Turns Alpaca trade updates into books and live events: the order is saved (without overwriting
 * what's already known about a leg), and fills, cancels and rejections are streamed. A stock
 * position opening or going flat (including a stop-loss or take-profit the broker triggered on
 * its own) is reported with its realized P&L.
 */

const labelOf = (order: AlpacaOrder) => {
  if (order.symbol) return isOptionSymbol(order.symbol) ? describeContract(order.symbol) : order.symbol
  const leg = order.legs?.[0]?.symbol
  return leg ? `${parseOcc(leg)?.root ?? leg} spread` : "order"
}

const instrumentOf = (order: AlpacaOrder) => {
  const symbol = order.symbol || order.legs?.[0]?.symbol || ""
  return isOptionSymbol(symbol) ? (parseOcc(symbol)?.root ?? undefined) : symbol || undefined
}

/** Posts a completed buy to Discord: shares, a contract or a debit spread, with its bracket if any. */
const notifyPurchase = async (alerts: TradingContext["alerts"], order: AlpacaOrder, option: boolean, label: string) => {
  const qty = Number(order.filled_qty)
  const price = Number(order.filled_avg_price ?? 0)
  const unit = !option ? "share" : order.order_class === "mleg" ? "spread" : "contract"
  const cost = qty * price * (option ? 100 : 1)
  const legs = order.order_class === "bracket" ? (order.legs ?? []) : []
  const stop = legs.find((l) => l.type === "stop" || l.type === "stop_limit")?.stop_price
  const target = legs.find((l) => l.type === "limit")?.limit_price
  await alerts.success(`Bought ${label}`, `[paper] ${qty} ${unit}${qty === 1 ? "" : "s"} at $${price.toFixed(2)}, $${cost.toFixed(2)} in total.`, {
    path: option ? "/trades?tab=options" : `/markets/${order.symbol}`,
    key: `buy|${order.id}`,
    fields: { Stop: stop ? `$${Number(stop).toFixed(2)}` : null, Target: target ? `$${Number(target).toFixed(2)}` : null },
  })
}

export const handleTradeUpdate = async (ctx: Pick<TradingContext, "col" | "bus" | "alerts">, update: TradeUpdate): Promise<{ filled: boolean }> => {
  const { col, bus } = ctx
  const order = update.order
  await saveOrders(col, [order])
  const option = order.order_class === "mleg" || isOptionSymbol(order.symbol)
  const asset_class = option ? "us_option" : "us_equity"
  const label = labelOf(order)
  const instrument = instrumentOf(order)
  const side = order.side || (order.legs?.[0]?.side ?? "")

  switch (update.event) {
    case "fill":
    case "partial_fill": {
      const qty = Number(update.qty ?? order.filled_qty)
      const price = Number(update.price ?? order.filled_avg_price ?? 0)
      const partial = update.event === "partial_fill"
      bus.emit(
        "order.filled",
        { order_id: order.id, symbol: order.symbol || label, side, qty, price, partial, asset_class },
        { summary: `${partial ? "Partially filled" : "Filled"}: ${side} ${qty} ${label} at $${price.toFixed(2)}`, instrument },
      )
      if (side === "buy" && !partial) await notifyPurchase(ctx.alerts, order, option, label)
      if (!option && update.position_qty !== undefined) {
        const positionQty = Number(update.position_qty)
        if (side === "buy" && Math.abs(positionQty - qty) < 1e-9) {
          bus.emit("position.opened", { symbol: order.symbol, asset_class, qty, price, structure_id: null }, { summary: `Opened ${order.symbol}: ${qty} shares at $${price.toFixed(2)}`, instrument })
        } else if (side === "sell" && positionQty === 0 && !partial) {
          const fills = await loadRealizedFills(col, { symbol: order.symbol })
          const fill = fills.find((f) => f.id === order.id)
          const realized = fill?.realized_pnl ?? null
          const returnPct = fill?.cost_basis ? Math.round(((fill.price - fill.cost_basis) / fill.cost_basis) * 10_000) / 100 : null
          const doc = await col.orders.findOne({ _id: order.id }, { projection: { role: 1 } })
          const reason = doc?.role === "stop_loss" ? "stop-loss" : doc?.role === "take_profit" ? "take-profit" : "sold"
          bus.emit(
            "position.closed",
            { symbol: order.symbol, asset_class, realized_pnl_usd: realized, return_pct: returnPct, reason, structure_id: null },
            { summary: `Closed ${order.symbol} (${reason})${realized !== null ? `: ${realized >= 0 ? "+" : "−"}$${Math.abs(realized).toFixed(2)}` : ""}`, instrument },
          )
        }
      }
      return { filled: true }
    }
    case "canceled":
    case "expired":
    case "done_for_day":
      bus.emit("order.canceled", { order_id: order.id, symbol: order.symbol || label, reason: update.event }, { summary: `Order ${update.event.replace(/_/g, " ")}: ${side} ${label}`, instrument, level: "debug" })
      return { filled: false }
    case "rejected":
      bus.emit("order.rejected", { order_id: order.id, symbol: order.symbol || label, reason: "rejected by the broker" }, { summary: `Order rejected: ${side} ${label}`, instrument, level: "warn" })
      return { filled: false }
    default:
      bus.emit("order.updated", { order_id: order.id, symbol: order.symbol || label, status: order.status, filled_qty: Number(order.filled_qty ?? 0) }, { summary: `Order ${update.event.replace(/_/g, " ")}: ${side} ${label}`, instrument, level: "debug" })
      return { filled: false }
  }
}
