import type {
  AlpacaAccount,
  AlpacaAsset,
  AlpacaCalendarDay,
  AlpacaOrder,
  AlpacaPosition,
  Bar,
  MostActive,
  Mover,
  NewOrder,
  NewsItem,
  OptionContract,
  OptionSnapshot,
  PortfolioHistory,
  Snapshot,
} from "@mb/stock-core/alpaca"
import { isOptionSymbol, OPTION_MULTIPLIER, parseOcc } from "@mb/stock-core/options"
import { vi } from "vitest"
import { AlpacaError, type Alpaca } from "../../src/alpaca/client"

/**
 * An in-memory Alpaca paper account. `broker.client` is an `Alpaca` whose every method is a spy
 * backed by this state, so the bot's code runs unchanged against a broker that behaves like the
 * real one: market orders fill at the current price, bracket/OCO exits reserve shares, cancels and
 * closes work, and options (single legs and two-leg mleg orders) fill against simulated quotes.
 */

const OPEN_STATUSES = new Set(["new", "accepted", "held", "partially_filled", "pending_new", "accepted_for_bidding", "pending_cancel", "pending_replace"])
export const isOpenStatus = (status: string) => OPEN_STATUSES.has(status)

type Timeframe = "5Min" | "15Min" | "30Min" | "1Hour" | "1Day"
type Holding = { qty: number; avg: number; side: "long" | "short"; lastday: number | null; qtyAvailable?: number }
export type OptionQuote = { bid: number; ask: number; delta?: number; iv?: number }

const clone = <T>(value: T): T => structuredClone(value)

export class FakeBroker {
  cash = 10_000
  /** Yesterday's closing equity. null = same as current equity (a flat day). */
  lastEquity: number | null = null
  readonly prices = new Map<string, number>()
  readonly holdings = new Map<string, Holding>()
  orders: AlpacaOrder[] = []
  /** Asset overrides; null marks a symbol Alpaca doesn't know (404). */
  readonly assets = new Map<string, Partial<AlpacaAsset> | null>()
  clock = { is_open: true }
  calendar: AlpacaCalendarDay[] = []
  /** Explicit snapshots; symbols without one get a snapshot derived from `prices`. */
  readonly snapshots = new Map<string, Snapshot>()
  bars: Partial<Record<Timeframe, Record<string, Bar[]>>> = {}
  movers: { gainers: Mover[]; losers: Mover[] } | Error = { gainers: [], losers: [] }
  mostActives: { most_actives: MostActive[] } | Error = { most_actives: [] }
  news: NewsItem[] = []
  readonly history = new Map<string, PortfolioHistory>()
  /** fill = market orders fill instantly; accept = they stay open; reject = the broker rejects them. */
  fillMode: "fill" | "accept" | "reject" = "fill"
  /** Symbols whose open orders ignore cancel requests. */
  readonly stuckCancels = new Set<string>()
  /** Errors thrown by the next submitOrder calls, in order. */
  readonly submitErrors: Error[] = []
  /** Every order request received, including ones that errored. */
  readonly submitted: NewOrder[] = []
  readonly barRequests: { symbols: string[]; timeframe: Timeframe; start: Date; end?: Date }[] = []
  readonly newsRequests: { symbols: string[] | null; start: Date; limit: number }[] = []
  /** Option quotes by contract symbol. Limit buys fill at their limit when it's at least the midpoint (sells: at most). */
  readonly optionQuotes = new Map<string, OptionQuote>()
  readonly optionContracts: OptionContract[] = []
  optionsLevel = 3
  private seq = 0
  readonly client: Alpaca

  constructor() {
    const methods = [
      "getAccount",
      "getClock",
      "getCalendar",
      "getPositions",
      "listOrders",
      "getOrder",
      "getOrderByClientId",
      "submitOrder",
      "cancelOrder",
      "closeAllPositions",
      "getAsset",
      "listAssets",
      "getPortfolioHistory",
      "getSnapshots",
      "getBars",
      "getMovers",
      "getMostActives",
      "getNews",
      "getOptionContracts",
      "getOptionChain",
      "getOptionSnapshots",
    ] as const
    this.client = Object.fromEntries(methods.map((name) => [name, vi.fn((...args: unknown[]) => (this[name] as (...a: unknown[]) => unknown)(...args))])) as unknown as Alpaca
  }

  // ─── State helpers for tests ──────────────────────────────────────────────

  setPrice(symbol: string, price: number) {
    this.prices.set(symbol, price)
    return this
  }

  /** Opens a position directly (no order), e.g. one the bot already holds. */
  setPosition(symbol: string, qty: number, price: number, { avg = price, side = "long", lastday = null, qtyAvailable }: Partial<Holding> = {}) {
    this.prices.set(symbol, price)
    this.holdings.set(symbol, { qty, avg, side, lastday, qtyAvailable })
    this.cash -= qty * avg * (isOptionSymbol(symbol) ? OPTION_MULTIPLIER : 1)
    return this
  }

  setOptionQuote(symbol: string, quote: OptionQuote) {
    this.optionQuotes.set(symbol, quote)
    return this
  }

  /** Lists a contract (for chain lookups) with a quote. */
  listContract(symbol: string, quote: OptionQuote, openInterest = 5_000) {
    const c = parseOcc(symbol)!
    this.optionContracts.push({
      id: `oc-${symbol}`,
      symbol,
      name: symbol,
      status: "active",
      tradable: true,
      expiration_date: c.expiration,
      underlying_symbol: c.root,
      type: c.type,
      style: "american",
      strike_price: String(c.strike),
      open_interest: String(openInterest),
    })
    return this.setOptionQuote(symbol, quote)
  }

  private markOf(symbol: string, h: Holding) {
    if (isOptionSymbol(symbol)) {
      const q = this.optionQuotes.get(symbol)
      return q ? (q.bid + q.ask) / 2 : h.avg
    }
    return this.prices.get(symbol) ?? h.avg
  }

  get equity() {
    let value = this.cash
    for (const [symbol, h] of this.holdings) value += h.qty * this.markOf(symbol, h) * (isOptionSymbol(symbol) ? OPTION_MULTIPLIER : 1)
    return value
  }

  /** Every order and leg, flattened. */
  allOrders(): AlpacaOrder[] {
    return this.orders.flatMap((o) => [o, ...(o.legs ?? [])])
  }

  openOrders(symbol?: string) {
    return this.allOrders().filter((o) => isOpenStatus(o.status) && (!symbol || o.symbol === symbol))
  }

  /** Adds a resting order (e.g. existing exits) without going through submitOrder. */
  addOrder(order: AlpacaOrder) {
    this.orders.push(order)
    return order
  }

  /** Simulates the broker filling an open order (e.g. a stop-loss triggering between runs). */
  fillOrder(id: string, price?: number) {
    const group = this.groupOf(id)
    const order = this.allOrders().find((o) => o.id === id)
    if (!group || !order) throw new Error(`no order ${id}`)
    const fillPrice = price ?? this.prices.get(order.symbol) ?? 0
    const qty = Number(order.qty)
    Object.assign(order, { status: "filled", filled_qty: String(qty), filled_avg_price: String(fillPrice), filled_at: new Date().toISOString() })
    this.applyFill(order.symbol, order.side as "buy" | "sell", qty, fillPrice)
    // One-cancels-other: the sibling exits are canceled.
    for (const o of [group, ...(group.legs ?? [])]) if (o !== order && isOpenStatus(o.status) && o.side === "sell") this.markCanceled(o)
  }

  // ─── Broker behaviour ─────────────────────────────────────────────────────

  account(): AlpacaAccount {
    const equity = this.equity
    const long = equity - this.cash
    return {
      id: "fake-account",
      status: "ACTIVE",
      currency: "USD",
      cash: String(this.cash),
      equity: String(equity),
      last_equity: String(this.lastEquity ?? equity),
      buying_power: String(this.cash * 2),
      long_market_value: String(long),
      portfolio_value: String(equity),
      trading_blocked: false,
      account_blocked: false,
      options_buying_power: String(this.cash),
      options_trading_level: this.optionsLevel,
    }
  }

  position(symbol: string): AlpacaPosition {
    const h = this.holdings.get(symbol)!
    const option = isOptionSymbol(symbol)
    const m = option ? OPTION_MULTIPLIER : 1
    const price = this.markOf(symbol, h)
    const lastday = h.lastday ?? h.avg
    const available = h.qtyAvailable ?? h.qty - this.reservedQty(symbol)
    return {
      symbol,
      asset_class: option ? "us_option" : "us_equity",
      qty: String(h.qty),
      qty_available: String(available),
      avg_entry_price: String(h.avg),
      current_price: String(price),
      lastday_price: String(lastday),
      market_value: String(h.qty * price * m),
      cost_basis: String(h.qty * h.avg * m),
      unrealized_pl: String(h.qty * (price - h.avg) * m),
      unrealized_plpc: String((price - h.avg) / h.avg),
      unrealized_intraday_pl: String(h.qty * (price - lastday) * m),
      unrealized_intraday_plpc: String((price - lastday) / lastday),
      change_today: String((price - lastday) / lastday),
      side: h.qty < 0 ? "short" : h.side,
    }
  }

  private nextId(kind: string) {
    this.seq += 1
    return `${kind}-${this.seq}`
  }

  private newOrder(fields: Partial<AlpacaOrder>): AlpacaOrder {
    const now = new Date().toISOString()
    return {
      id: this.nextId("ord"),
      client_order_id: this.nextId("cid"),
      created_at: now,
      updated_at: now,
      submitted_at: now,
      filled_at: null,
      canceled_at: null,
      expired_at: null,
      failed_at: null,
      symbol: "",
      qty: null,
      notional: null,
      filled_qty: "0",
      filled_avg_price: null,
      order_class: "simple",
      type: "market",
      side: "buy",
      time_in_force: "day",
      limit_price: null,
      stop_price: null,
      status: "new",
      legs: null,
      ...fields,
    }
  }

  private groupOf(id: string) {
    return this.orders.find((o) => o.id === id || (o.legs ?? []).some((l) => l.id === id))
  }

  /** Shares held back by open sell orders (a bracket's or OCO's legs share one quantity). */
  private reservedQty(symbol: string) {
    return this.orders
      .filter((o) => o.symbol === symbol && [o, ...(o.legs ?? [])].some((x) => x.side === "sell" && isOpenStatus(x.status)))
      .reduce((sum, o) => sum + Number(o.qty), 0)
  }

  /** Signed position change: buys add, sells subtract (options can go short). */
  private applyFill(symbol: string, side: "buy" | "sell", qty: number, price: number) {
    const m = isOptionSymbol(symbol) ? OPTION_MULTIPLIER : 1
    const h = this.holdings.get(symbol)
    const signed = side === "buy" ? qty : -qty
    const before = h?.qty ?? 0
    const after = before + signed
    // Stocks are long only: selling more than is held just flattens.
    if (Math.abs(after) <= 1e-9 || (m === 1 && after < 0)) this.holdings.delete(symbol)
    else if (!h || Math.sign(before) !== Math.sign(after) || Math.abs(after) > Math.abs(before)) {
      const avg = h && Math.sign(before) === Math.sign(after) ? (Math.abs(before) * h.avg + qty * price) / Math.abs(after) : price
      this.holdings.set(symbol, { qty: after, avg, side: after > 0 ? "long" : "short", lastday: h?.lastday ?? null })
    } else h.qty = after
    this.cash += (side === "buy" ? -1 : 1) * qty * price * m
  }

  private markCanceled(order: AlpacaOrder) {
    order.status = "canceled"
    order.canceled_at = new Date().toISOString()
  }

  private optionMid(symbol: string) {
    const q = this.optionQuotes.get(symbol)
    if (!q) throw new AlpacaError(422, `no quote for ${symbol}`)
    return { mid: (q.bid + q.ask) / 2, bid: q.bid, ask: q.ask }
  }

  private submitOption(req: NewOrder): AlpacaOrder {
    const qty = Number(req.qty)
    const fills = this.fillMode === "fill"
    if (this.fillMode === "reject") {
      const order = this.newOrder({ symbol: req.symbol ?? "", qty: req.qty, side: req.side ?? "", type: req.type, order_class: req.order_class ?? "simple", status: "rejected", client_order_id: req.client_order_id! })
      this.orders.push(order)
      return clone(order)
    }
    if (req.order_class === "mleg") {
      const legs = req.legs!
      const quotes = legs.map((l) => this.optionMid(l.symbol))
      const net = legs.reduce((sum, l, i) => sum + (l.side === "buy" ? 1 : -1) * quotes[i].mid, 0)
      const limit = req.limit_price !== undefined ? Number(req.limit_price) : null
      // Debit (positive) limits fill at or above the net mid; credit (negative) limits fill at or below it.
      const marketable = limit === null || limit >= net - 1e-9
      const filled = fills && marketable
      const now = new Date().toISOString()
      const legOrders = legs.map((l, i) =>
        this.newOrder({
          symbol: l.symbol,
          asset_class: "us_option",
          qty: req.qty,
          side: l.side,
          type: req.type,
          order_class: "mleg",
          position_intent: l.position_intent,
          status: filled ? "filled" : "new",
          filled_qty: filled ? req.qty : "0",
          filled_avg_price: filled ? String(quotes[i].mid) : null,
          filled_at: filled ? now : null,
        }),
      )
      const order = this.newOrder({
        symbol: "",
        asset_class: "us_option",
        qty: req.qty,
        side: "",
        type: req.type,
        order_class: "mleg",
        limit_price: req.limit_price ?? null,
        client_order_id: req.client_order_id!,
        status: filled ? "filled" : "new",
        filled_qty: filled ? req.qty : "0",
        filled_avg_price: filled ? String(Math.abs(limit ?? net)) : null,
        filled_at: filled ? now : null,
        legs: legOrders,
      })
      this.orders.push(order)
      if (filled) legs.forEach((l, i) => this.applyFill(l.symbol, l.side, qty, quotes[i].mid))
      return clone(order)
    }
    const symbol = req.symbol!
    const q = this.optionMid(symbol)
    const limit = req.limit_price !== undefined ? Number(req.limit_price) : null
    const buy = req.side === "buy"
    if (!buy) {
      const held = this.holdings.get(symbol)?.qty ?? 0
      if (qty > held + 1e-9) throw new AlpacaError(403, `insufficient qty available for order (requested: ${qty}, available: ${held})`)
    }
    const marketable = limit === null || (buy ? limit >= q.mid - 1e-9 : limit <= q.mid + 1e-9)
    const filled = fills && marketable
    const price = limit ?? (buy ? q.ask : q.bid)
    const order = this.newOrder({
      symbol,
      asset_class: "us_option",
      qty: req.qty,
      side: req.side,
      type: req.type,
      limit_price: req.limit_price ?? null,
      position_intent: req.position_intent ?? null,
      client_order_id: req.client_order_id!,
      status: filled ? "filled" : "new",
      filled_qty: filled ? req.qty : "0",
      filled_avg_price: filled ? String(price) : null,
      filled_at: filled ? new Date().toISOString() : null,
    })
    this.orders.push(order)
    if (filled) this.applyFill(symbol, req.side!, qty, price)
    return clone(order)
  }

  submitOrder = async (req: NewOrder): Promise<AlpacaOrder> => {
    this.submitted.push(clone(req))
    const error = this.submitErrors.shift()
    if (error) throw error
    const duplicate = req.client_order_id ? this.orders.find((o) => o.client_order_id === req.client_order_id) : undefined
    if (duplicate) return clone(duplicate)
    if (req.order_class === "mleg" || (req.symbol && isOptionSymbol(req.symbol))) return this.submitOption({ ...req, client_order_id: req.client_order_id ?? this.nextId("cid") })

    const symbol = req.symbol!
    const side = req.side!
    const qty = Number(req.qty)
    const price = this.prices.get(symbol) ?? 0
    if (side === "sell") {
      const available = (this.holdings.get(symbol)?.qty ?? 0) - this.reservedQty(symbol)
      if (qty > available + 1e-9) {
        throw new AlpacaError(403, `Alpaca POST /v2/orders failed (403): insufficient qty available for order (requested: ${qty}, available: ${available})`)
      }
    }
    const base = {
      symbol,
      qty: req.qty,
      side,
      time_in_force: req.time_in_force,
      client_order_id: req.client_order_id ?? this.nextId("cid"),
      order_class: (req.order_class ?? "simple") as AlpacaOrder["order_class"],
    }

    if (this.fillMode === "reject") {
      const order = this.newOrder({ ...base, type: req.type, status: "rejected", failed_at: new Date().toISOString() })
      this.orders.push(order)
      return clone(order)
    }

    if (req.order_class === "oco") {
      const stopLeg = this.newOrder({ ...base, client_order_id: this.nextId("cid"), type: "stop", stop_price: req.stop_loss!.stop_price, status: "held" })
      const order = this.newOrder({ ...base, type: "limit", limit_price: req.take_profit!.limit_price, status: "new", legs: [stopLeg] })
      this.orders.push(order)
      return clone(order)
    }

    // A plain stop rests until a test fills it (fillOrder).
    if (req.type === "stop") {
      const order = this.newOrder({ ...base, type: "stop", stop_price: req.stop_price ?? null, status: "new" })
      this.orders.push(order)
      return clone(order)
    }

    const fills = this.fillMode === "fill"
    const order = this.newOrder({
      ...base,
      type: req.type,
      limit_price: req.limit_price ?? null,
      status: fills ? "filled" : "accepted",
      filled_qty: fills ? req.qty : "0",
      filled_avg_price: fills ? String(price) : null,
      filled_at: fills ? new Date().toISOString() : null,
    })
    if (req.order_class === "bracket") {
      const leg = { symbol, qty: req.qty, side: "sell" as const, time_in_force: req.time_in_force, order_class: "bracket" as const }
      order.legs = [
        this.newOrder({ ...leg, type: "limit", limit_price: req.take_profit!.limit_price, status: fills ? "new" : "held" }),
        this.newOrder({ ...leg, type: "stop", stop_price: req.stop_loss!.stop_price, status: "held" }),
      ]
    }
    this.orders.push(order)
    if (fills) this.applyFill(symbol, side, qty, price)
    return clone(order)
  }

  cancelOrder = async (id: string): Promise<void> => {
    const group = this.groupOf(id)
    if (!group) throw new AlpacaError(404, `Alpaca DELETE /v2/orders/${id} failed (404): order not found`)
    if (this.stuckCancels.has(group.symbol)) return
    for (const o of [group, ...(group.legs ?? [])]) if (isOpenStatus(o.status)) this.markCanceled(o)
  }

  listOrders = async (q: Parameters<Alpaca["listOrders"]>[0]): Promise<AlpacaOrder[]> => {
    const status = q.status ?? "open"
    const matches = (o: AlpacaOrder) => status === "all" || (status === "open" ? isOpenStatus(o.status) : !isOpenStatus(o.status))
    const symbols = q.symbols ? new Set(q.symbols.split(",")) : null
    let list = q.nested ? this.orders.filter((o) => [o, ...(o.legs ?? [])].some(matches)) : this.allOrders().filter(matches).map((o) => ({ ...o, legs: null }))
    if (symbols) list = list.filter((o) => symbols.has(o.symbol))
    if (q.after) list = list.filter((o) => new Date(o.created_at) > new Date(q.after!))
    if (q.until) list = list.filter((o) => new Date(o.created_at) < new Date(q.until!))
    list.sort((a, b) => (q.direction === "asc" ? 1 : -1) * a.created_at.localeCompare(b.created_at))
    return clone(list.slice(0, q.limit ?? 50))
  }

  getOrder = async (id: string): Promise<AlpacaOrder> => {
    const order = this.orders.find((o) => o.id === id) ?? this.allOrders().find((o) => o.id === id)
    if (!order) throw new AlpacaError(404, `Alpaca GET /v2/orders/${id} failed (404): order not found`)
    return clone(order)
  }

  getOrderByClientId = async (clientOrderId: string): Promise<AlpacaOrder> => {
    const order = this.allOrders().find((o) => o.client_order_id === clientOrderId)
    if (!order) throw new AlpacaError(404, "order not found")
    return clone(order)
  }

  closeAllPositions = async () => {
    for (const o of this.openOrders()) this.markCanceled(o)
    const closed = [...this.holdings.keys()]
    for (const symbol of closed) {
      const h = this.holdings.get(symbol)!
      const price = this.markOf(symbol, h)
      const side = h.qty > 0 ? "sell" : "buy"
      this.orders.push(this.newOrder({ symbol, qty: String(Math.abs(h.qty)), side, status: "filled", filled_qty: String(Math.abs(h.qty)), filled_avg_price: String(price), filled_at: new Date().toISOString() }))
      this.applyFill(symbol, side, Math.abs(h.qty), price)
    }
    return closed.map((symbol) => ({ symbol, status: 200 }))
  }

  getAsset = async (symbol: string): Promise<AlpacaAsset> => {
    const override = this.assets.get(symbol)
    if (override === null) throw new AlpacaError(404, `Alpaca GET /v2/assets/${symbol} failed (404): asset not found`)
    return { symbol, name: `${symbol} Inc.`, class: "us_equity", exchange: "NASDAQ", status: "active", tradable: true, fractionable: true, ...override }
  }

  /** What listAssets returns (empty unless a test fills it). */
  assetList: AlpacaAsset[] = []
  listAssets = async (): Promise<AlpacaAsset[]> => clone(this.assetList)

  getSnapshots = async (symbols: string[]): Promise<Record<string, Snapshot>> => {
    const result: Record<string, Snapshot> = {}
    const now = new Date().toISOString()
    for (const symbol of new Set(symbols.map((s) => s.toUpperCase()))) {
      const explicit = this.snapshots.get(symbol)
      const price = this.prices.get(symbol)
      if (explicit) result[symbol] = clone(explicit)
      else if (price !== undefined) {
        const prev = this.holdings.get(symbol)?.lastday ?? price
        result[symbol] = {
          latestTrade: { p: price, t: now },
          dailyBar: { t: now, o: prev, h: Math.max(prev, price), l: Math.min(prev, price), c: price, v: 10_000, vw: price, n: 100 },
          prevDailyBar: { t: now, o: prev, h: prev, l: prev, c: prev, v: 10_000, vw: prev, n: 100 },
        }
      }
    }
    return result
  }

  getBars = async (symbols: string[], timeframe: Timeframe, start: Date, end?: Date): Promise<Record<string, Bar[]>> => {
    this.barRequests.push({ symbols: [...symbols], timeframe, start, end })
    const result: Record<string, Bar[]> = {}
    for (const symbol of symbols) {
      const bars = (this.bars[timeframe]?.[symbol] ?? []).filter((b) => new Date(b.t) >= start && (!end || new Date(b.t) <= end))
      if (bars.length) result[symbol] = clone(bars)
    }
    return result
  }

  getMovers = async () => {
    if (this.movers instanceof Error) throw this.movers
    return clone(this.movers)
  }

  getMostActives = async () => {
    if (this.mostActives instanceof Error) throw this.mostActives
    return clone(this.mostActives)
  }

  getNews = async (symbols: string[] | null, start: Date, limit = 30): Promise<NewsItem[]> => {
    this.newsRequests.push({ symbols, start, limit })
    const wanted = symbols && symbols.length ? new Set(symbols) : null
    return clone(this.news.filter((n) => new Date(n.created_at) >= start && (!wanted || n.symbols.some((s) => wanted.has(s)))).slice(0, limit))
  }

  getPortfolioHistory = async (period: string): Promise<PortfolioHistory> => {
    const history = this.history.get(period)
    if (!history) throw new AlpacaError(500, "history unavailable")
    return clone(history)
  }

  getCalendar = async (start: string, end: string): Promise<AlpacaCalendarDay[]> => clone(this.calendar.filter((c) => c.date >= start && c.date <= end))

  getClock = async () => ({ timestamp: new Date().toISOString(), is_open: this.clock.is_open, next_open: "2026-10-27T13:30:00Z", next_close: "2026-10-26T20:00:00Z" })

  getAccount = async () => this.account()

  getPositions = async () => [...this.holdings.keys()].map((s) => this.position(s))

  private snapshotOf = (symbol: string): OptionSnapshot | undefined => {
    const q = this.optionQuotes.get(symbol)
    if (!q) return undefined
    const now = new Date().toISOString()
    return {
      latestQuote: { bp: q.bid, ap: q.ask, t: now },
      ...(q.delta !== undefined ? { greeks: { delta: q.delta, gamma: 0.02, theta: -0.05, vega: 0.1, rho: 0.01 } } : {}),
      ...(q.iv !== undefined ? { impliedVolatility: q.iv } : {}),
    }
  }

  getOptionContracts = async (query: Parameters<Alpaca["getOptionContracts"]>[0]): Promise<OptionContract[]> =>
    clone(
      this.optionContracts.filter(
        (c) =>
          query.underlying_symbols.split(",").includes(c.underlying_symbol) &&
          (!query.expiration_date_gte || c.expiration_date >= query.expiration_date_gte) &&
          (!query.expiration_date_lte || c.expiration_date <= query.expiration_date_lte) &&
          (query.strike_price_gte === undefined || Number(c.strike_price) >= query.strike_price_gte) &&
          (query.strike_price_lte === undefined || Number(c.strike_price) <= query.strike_price_lte),
      ),
    )

  getOptionChain = async (underlying: string): Promise<Record<string, OptionSnapshot>> =>
    Object.fromEntries(this.optionContracts.filter((c) => c.underlying_symbol === underlying).flatMap((c) => (this.snapshotOf(c.symbol) ? [[c.symbol, this.snapshotOf(c.symbol)!]] : [])))

  getOptionSnapshots = async (symbols: string[]): Promise<Record<string, OptionSnapshot>> =>
    Object.fromEntries(symbols.flatMap((s) => (this.snapshotOf(s) ? [[s, this.snapshotOf(s)!]] : [])))
}

/** A fresh fake broker; pass `broker.client` wherever an `Alpaca` is expected. */
export const fakeBroker = () => new FakeBroker()
