import type { SymbolFeatures, SymbolHealth, VenueHealth } from "@mb/crypto-core/db"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { every, sleep, backoffMs } from "@mb/engine-kit/util/async"
import type { EventBus } from "../bus/event-bus"
import type { Level, OrderBook } from "../venues/kraken/book"
import { parsePairs, type PairInfo } from "../venues/kraken/pairs"
import type { KrakenRest } from "../venues/kraken/rest"
import { KrakenWs, type MinuteBar, type TickerState } from "../venues/kraken/ws"

/**
 * Live Kraken market state: pair metadata, tickers and order books, with freshness tracking.
 *
 * WebSockets are the primary feed. If the socket is down for more than 30s, REST polling takes
 * over (tickers for the universe plus order books for held symbols) so stops keep working, and
 * every quote carries its age so nothing trades on stale prices.
 */

export type Quote = {
  symbol: string
  bid: number
  ask: number
  mid: number
  spreadBps: number
  last: number | null
  changePct: number | null
  at: number
  ageS: number
  source: "ws" | "rest"
  book: { asks: Level[]; bids: Level[] } | null
}

type RestQuote = Omit<Quote, "ageS">

export class MarketHub {
  pairs = new Map<string, PairInfo>()
  private symbols: string[] = []
  private ws: KrakenWs | null = null
  private readonly restQuotes = new Map<string, RestQuote>()
  private readonly lastTickerEmit = new Map<string, number>()
  private readonly staleSymbols = new Set<string>()
  private disconnectedSince: number | null = Date.now()
  private systemStatus: string | null = null
  private lastError: string | null = null
  private restOk = false
  private stops: (() => void)[] = []
  /** Latest indicator summaries per symbol (set after each cycle), reported in the heartbeat. */
  features = new Map<string, SymbolFeatures>()
  /** Symbols whose books the REST fallback should keep current (held positions). */
  heldSymbols: () => string[] = () => []
  private readonly barListeners: ((bar: MinuteBar) => void)[] = []
  private readonly dataTickers = new Map<string, TickerState>()
  private dataSymbols: string[] = []

  constructor(
    private readonly rest: KrakenRest,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly maxQuoteAgeS: () => number,
  ) {}

  /** Loads pair metadata (retrying until Kraken answers) and opens the WebSocket feed. */
  async start(universe: string[], signal?: AbortSignal) {
    for (let attempt = 1; !signal?.aborted; attempt++) {
      try {
        this.pairs = parsePairs(await this.rest.assetPairs())
        this.restOk = true
        break
      } catch (error) {
        this.lastError = errorMessage(error)
        this.log.warn("loading Kraken asset pairs failed; retrying", { attempt, error: this.lastError })
        await sleep(Math.max(2_000, backoffMs(attempt, 2_000, 60_000)), signal)
      }
    }
    this.symbols = this.filterUniverse(universe)
    this.ws = new KrakenWs(this.symbols, this.pairs, this.log.child({ component: "kraken-ws" }), {
      onTicker: (t) => this.onTicker(t),
      onDataTicker: (t) => this.dataTickers.set(t.symbol, t),
      onBar: (bar) => {
        for (const fn of this.barListeners) {
          try {
            fn(bar)
          } catch (error) {
            this.log.warn("bar listener failed", { error: errorMessage(error) })
          }
        }
      },
      onConnection: (state, reason) => this.onConnection(state, reason),
      onSymbolError: (symbol, message) =>
        this.bus.emit("venue.error", { message: `${symbol}: ${message}` }, { summary: `Kraken rejected ${symbol}: ${message}`, level: "warn" }),
    })
    this.ws.setDataSymbols(this.dataSymbols)
    this.ws.start()
    const onError = (error: unknown) => this.log.warn("market hub job failed", { error: errorMessage(error) })
    this.stops.push(every(10_000, () => this.restFallback(), onError))
    this.stops.push(every(5_000, () => this.checkStaleness(), onError))
    this.stops.push(every(60_000, () => this.pollSystemStatus(), onError, { immediate: true }))
  }

  stop() {
    for (const stop of this.stops) stop()
    this.stops = []
    this.ws?.stop()
  }

  private filterUniverse(universe: string[]) {
    const ok = universe.filter((s) => this.pairs.get(s)?.online)
    const missing = universe.filter((s) => !ok.includes(s))
    if (missing.length) this.log.warn("universe symbols not tradable on Kraken; skipping", { missing })
    return ok
  }

  setUniverse(universe: string[]) {
    this.symbols = this.filterUniverse(universe)
    this.ws?.setSymbols(this.symbols)
  }

  get universe() {
    return [...this.symbols]
  }

  /** Every closed 1-minute bar of the universe (for the news engine's anomaly detector). */
  onBar(fn: (bar: MinuteBar) => void) {
    this.barListeners.push(fn)
  }

  /**
   * Ticker-only symbols watched as data (stablecoins for a depeg). They never join the universe,
   * have no quote() and can't be traded.
   */
  setDataSymbols(symbols: string[]) {
    this.dataSymbols = symbols
    this.ws?.setDataSymbols(symbols)
  }

  dataTicker(symbol: string): TickerState | null {
    return this.dataTickers.get(symbol) ?? null
  }

  /** Up to 720 closed 1-minute bars from REST, oldest first (the anomaly detector's warm-up). */
  async minuteHistory(symbol: string): Promise<MinuteBar[]> {
    const pair = this.pairs.get(symbol)
    if (!pair) return []
    const candles = await this.rest.ohlc(pair.restPair, 1)
    return candles.map((c) => ({ symbol, t: c.t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
  }

  get wsConnected() {
    return this.ws?.connected ?? false
  }

  /** Kraken is fully online (not in maintenance / cancel-only), so its prices are trustworthy for fills. */
  get tradingOnline() {
    return this.systemStatus === null || this.systemStatus === "online"
  }

  private onTicker(t: TickerState) {
    const last = this.lastTickerEmit.get(t.symbol) ?? 0
    if (Date.now() - last < 2_000) return
    this.lastTickerEmit.set(t.symbol, Date.now())
    this.bus.emit(
      "market.ticker",
      { symbol: t.symbol, bid: t.bid, ask: t.ask, last: t.last, change_pct: Number.isFinite(t.change_pct) ? t.change_pct : null },
      { summary: `${t.symbol} ${t.last}`, level: "debug", instrument: t.symbol },
    )
  }

  private onConnection(state: "connecting" | "connected" | "disconnected", reason?: string) {
    if (state === "connected") {
      this.disconnectedSince = null
      this.bus.emit("venue.connected", { channel: "ws" }, { summary: "Kraken market data stream connected" })
    } else if (state === "disconnected") {
      this.disconnectedSince ??= Date.now()
      this.bus.emit(
        "venue.disconnected",
        { channel: "ws", reason: reason ?? "closed" },
        { summary: `Kraken market data stream disconnected (${reason ?? "closed"})`, level: "warn" },
      )
    }
  }

  /** REST polling while the socket has been down for 30s+. */
  private async restFallback() {
    if (this.disconnectedSince === null || Date.now() - this.disconnectedSince < 30_000 || !this.symbols.length) return
    const bySymbol = new Map([...this.pairs.values()].map((p) => [p.restPair, p]))
    const tickers = await this.rest.ticker(this.symbols.map((s) => this.pairs.get(s)!.restPair))
    this.restOk = true
    const now = Date.now()
    for (const [key, t] of Object.entries(tickers)) {
      const pair = bySymbol.get(key) ?? [...this.pairs.values()].find((p) => p.altname === key)
      if (!pair) continue
      const bid = Number(t.b[0])
      const ask = Number(t.a[0])
      const open = Number(t.o)
      const last = Number(t.c[0])
      this.restQuotes.set(pair.symbol, {
        symbol: pair.symbol,
        bid,
        ask,
        mid: (bid + ask) / 2,
        spreadBps: ((ask - bid) / ((bid + ask) / 2)) * 10_000,
        last,
        changePct: open > 0 ? (last / open - 1) * 100 : null,
        at: now,
        source: "rest",
        book: this.restQuotes.get(pair.symbol)?.book ?? null,
      })
    }
    for (const symbol of this.heldSymbols().filter((s) => this.symbols.includes(s))) {
      const pair = this.pairs.get(symbol)!
      const depth = Object.values(await this.rest.depth(pair.restPair, 25))[0]
      const quote = this.restQuotes.get(symbol)
      if (!depth || !quote) continue
      quote.book = {
        asks: depth.asks.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
        bids: depth.bids.map(([p, q]) => ({ price: Number(p), qty: Number(q) })),
      }
    }
  }

  private checkStaleness() {
    const maxAge = this.maxQuoteAgeS()
    for (const symbol of this.symbols) {
      const q = this.quote(symbol)
      const stale = !q || q.ageS > maxAge
      if (stale && !this.staleSymbols.has(symbol)) {
        this.staleSymbols.add(symbol)
        this.bus.emit("market.stale", { symbol, age_s: q ? Math.round(q.ageS) : -1 }, { summary: `${symbol} quotes are stale`, level: "warn", instrument: symbol })
      } else if (!stale && this.staleSymbols.has(symbol)) {
        this.staleSymbols.delete(symbol)
        this.bus.emit("market.restored", { symbol }, { summary: `${symbol} quotes restored`, instrument: symbol })
      }
    }
  }

  private async pollSystemStatus() {
    try {
      const status = await this.rest.systemStatus()
      if (status.status !== this.systemStatus && this.systemStatus !== null) {
        this.bus.emit(
          "venue.error",
          { message: `Kraken system status: ${status.status}` },
          { summary: `Kraken system status changed to ${status.status}`, level: status.status === "online" ? "info" : "warn" },
        )
      }
      this.systemStatus = status.status
      this.restOk = true
    } catch (error) {
      this.restOk = false
      this.lastError = errorMessage(error)
    }
  }

  /** Best current quote for a symbol: the WebSocket book, else the ticker, else REST fallback. */
  quote(symbol: string): Quote | null {
    const now = Date.now()
    const book: OrderBook | undefined = this.ws?.books.get(symbol)
    if (book && book.bestBid !== null && book.bestAsk !== null && this.ws?.connected) {
      const ticker = this.ws.tickers.get(symbol)
      return {
        symbol,
        bid: book.bestBid,
        ask: book.bestAsk,
        mid: book.mid!,
        spreadBps: book.spreadBps!,
        last: ticker?.last ?? null,
        changePct: ticker && Number.isFinite(ticker.change_pct) ? ticker.change_pct : null,
        at: book.updatedAt,
        // A quiet book doesn't update, but it's live as long as the socket is (heartbeats prove it).
        ageS: Math.max(0, (now - Math.max(book.updatedAt, this.ws.lastMessageAt)) / 1000),
        source: "ws",
        book: book.levels(),
      }
    }
    const rest = this.restQuotes.get(symbol)
    if (rest) return { ...rest, ageS: (now - rest.at) / 1000 }
    return null
  }

  health(): VenueHealth {
    return {
      rest: this.restOk ? (this.tradingOnline ? "ok" : "degraded") : "down",
      ws: this.ws?.connected ? "connected" : this.ws ? "disconnected" : "connecting",
      last_message_at: this.ws?.lastMessageAt ? new Date(this.ws.lastMessageAt) : null,
      last_error: this.lastError,
      status_text: this.systemStatus,
    }
  }

  symbolHealth(): SymbolHealth[] {
    const maxAge = this.maxQuoteAgeS()
    return this.symbols.map((symbol) => {
      const q = this.quote(symbol)
      return {
        symbol,
        bid: q?.bid ?? null,
        ask: q?.ask ?? null,
        last: q?.last ?? null,
        change_pct: q?.changePct ?? null,
        age_s: q ? Math.round(q.ageS * 10) / 10 : null,
        stale: !q || q.ageS > maxAge,
        features: this.features.get(symbol) ?? null,
      }
    })
  }
}
