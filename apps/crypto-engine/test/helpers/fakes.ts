import { EPHEMERAL_EVENTS, type EventDataMap } from "@mb/crypto-core/events"
import { silentLogger } from "@mb/engine-kit/log"
import { makeTestBus } from "@mb/engine-kit/testing/bus"
import { vi } from "vitest"
import type { EventBus } from "../../src/bus/event-bus"
import type { Collections } from "../../src/db/mongo"
import type { Quote } from "../../src/market/hub"
import { KrakenCli, type ExecFn } from "../../src/venues/kraken/cli"
import type { PairInfo } from "../../src/venues/kraken/pairs"
import type { Candle } from "../../src/venues/kraken/rest"

export const BTC: PairInfo = {
  symbol: "BTC/USD",
  restPair: "XXBTZUSD",
  altname: "XBTUSD",
  base: "XXBT",
  quote: "ZUSD",
  priceDecimals: 1,
  lotDecimals: 8,
  tickSize: 0.1,
  lotStep: 1e-8,
  orderMin: 0.00005,
  costMin: 0.5,
  online: true,
  takerFeeBps: 40,
  makerFeeBps: 25,
}

export const quote = (overrides: Partial<Quote> = {}): Quote => ({
  symbol: "BTC/USD",
  bid: 64_990,
  ask: 65_010,
  mid: 65_000,
  spreadBps: (20 / 65_000) * 10_000,
  last: 65_000,
  changePct: 1.2,
  at: Date.now(),
  ageS: 1,
  source: "ws",
  book: {
    asks: [
      { price: 65_010, qty: 0.5 },
      { price: 65_020, qty: 1 },
    ],
    bids: [
      { price: 64_990, qty: 0.5 },
      { price: 64_980, qty: 1 },
    ],
  },
  ...overrides,
})

/** A hub stand-in with fixed pairs and quotes. */
export const fakeHub = (quotes: Record<string, Quote | null> = { "BTC/USD": quote() }, pairs: PairInfo[] = [BTC]) => ({
  pairs: new Map(pairs.map((p) => [p.symbol, p])),
  quote: (symbol: string) => quotes[symbol] ?? null,
  tradingOnline: true,
  wsConnected: true,
  universe: pairs.map((p) => p.symbol),
  setUniverse: vi.fn(),
  onBar: vi.fn(),
  health: () => ({ rest: "ok" as const, ws: "connected" as const, last_message_at: new Date(), last_error: null, status_text: "online" }),
  symbolHealth: () => [],
  heldSymbols: () => [] as string[],
})

/**
 * An in-memory Kraken CLI paper wallet that follows the real CLI's math (buys fill at
 * ask × (1 + slippage), fee = cost × fee_rate) and prints the same JSON shapes.
 */
export class FakeWallet {
  usd: number
  coins = new Map<string, number>()
  trades: Record<string, unknown>[] = []
  next = 1
  calls: string[][] = []
  envs: NodeJS.ProcessEnv[] = []
  /** Next order call behaves like this instead of filling. */
  failNext: "timeout_after_fill" | "timeout" | "reject" | null = null

  constructor(
    usd = 10_000,
    public feeRate = 0.004,
    public slippageRate = 0,
    public ask = 65_010,
    public bid = 64_990,
    public workspaceExists = true,
  ) {
    this.usd = usd
  }

  exec: ExecFn = async (_file, args, options) => {
    this.calls.push(args)
    this.envs.push(options.env)
    const ok = (body: unknown) => ({ stdout: JSON.stringify({ mode: "paper", ...(body as object) }), stderr: "" })
    // Same error envelope as the real CLI 0.4.1.
    const fail = (message: string) => Object.assign(new Error("exit 1"), { code: 1, stdout: JSON.stringify({ error: "validation", message: `Validation error: ${message}` }), stderr: "" })
    if (args[0] === "--version") return { stdout: "kraken 0.4.1", stderr: "" }
    if (args[0] === "workspace" && args[1] === "show") {
      if (!this.workspaceExists) throw fail(`Workspace '${args[2]}' not found. Create it with 'kraken workspace create ${args[2]} --capital <amount> --mode paper'.`)
      return ok({ name: args[2], capital: "10000", currency: "USD", fee_rate: String(this.feeRate), slippage_rate: String(this.slippageRate), created_at: "2026-10-01T00:00:00Z" })
    }
    if (args[0] === "workspace" && args[1] === "create") {
      this.workspaceExists = true
      return ok({ name: args[2] })
    }
    if (args[0] === "paper" && args[1] === "reset") {
      this.usd = Number(args[args.indexOf("--capital") + 1])
      this.coins.clear()
      this.trades = []
      return ok({ action: "reset" })
    }
    if (args[0] === "paper" && args[1] === "balance") {
      const balances: Record<string, unknown> = { USD: { total: String(this.usd), reserved: "0", available: String(this.usd) } }
      for (const [k, v] of this.coins) if (v > 0) balances[k] = { total: String(v), reserved: "0", available: String(v) }
      return ok({ workspace: "test", balances })
    }
    if (args[0] === "paper" && args[1] === "history") return ok({ trades: this.trades, cancelled: [], filled_count: this.trades.length, cancelled_count: 0 })
    if (args[0] === "paper" && (args[1] === "buy" || args[1] === "sell")) {
      const side = args[1]
      const pair = args[2]
      const volume = Number(args[3])
      if (this.failNext === "reject") {
        this.failNext = null
        throw fail(`Insufficient USD balance. Available: ${this.usd.toFixed(2)}`)
      }
      if (this.failNext === "timeout") {
        this.failNext = null
        throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" })
      }
      const price = side === "buy" ? this.ask * (1 + this.slippageRate) : this.bid * (1 - this.slippageRate)
      const cost = volume * price
      const fee = cost * this.feeRate
      const base = pair.split("/")[0]
      if (side === "buy") {
        if (this.usd < cost + fee) throw fail(`Insufficient USD balance. Available: ${this.usd.toFixed(2)}, Required: ${(cost + fee).toFixed(2)}`)
        this.usd -= cost + fee
        this.coins.set(base, (this.coins.get(base) ?? 0) + volume)
      } else {
        if ((this.coins.get(base) ?? 0) < volume - 1e-12) throw fail(`Insufficient ${base} balance`)
        this.usd += cost - fee
        this.coins.set(base, (this.coins.get(base) ?? 0) - volume)
      }
      const trade = { id: `PAPER-${String(this.next++).padStart(5, "0")}`, order_id: `OPAPER-${this.next}`, status: "filled", pair, side, volume: String(volume), price: String(price), fee: String(fee), cost: String(cost), time: new Date().toISOString() }
      this.trades.push(trade)
      if (this.failNext === "timeout_after_fill") {
        this.failNext = null
        throw Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" })
      }
      return ok({ action: "market_order_filled", trade_id: trade.id, order_id: trade.order_id, side, pair, volume: trade.volume, price: trade.price, fee: trade.fee, cost: trade.cost })
    }
    throw new Error(`FakeWallet: unhandled args ${args.join(" ")}`)
  }

  cli() {
    return new KrakenCli("kraken", "test", 5_000, silentLogger, this.exec)
  }
}

/** A real event bus with crypto's events on the test database (@mb/engine-kit/testing/bus). */
export const makeBus = (col: Pick<Collections, "events">): Promise<EventBus> => makeTestBus<EventDataMap>(col, EPHEMERAL_EVENTS)

/** Deterministic hourly candles from a price path. */
export const candles = (closes: number[], stepMs = 3_600_000, start = Date.UTC(2026, 0, 1)): Candle[] =>
  closes.map((close, i) => {
    const open = i ? closes[i - 1] : close
    return { t: start + i * stepMs, open, high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, close, vwap: close, volume: 100, trades: 50 }
  })
