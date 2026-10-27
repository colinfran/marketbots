import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "../src/log"
import { bookChecksum, OrderBook } from "../src/venues/kraken/book"
import { KrakenCli, KrakenCliError, normalizePair } from "../src/venues/kraken/cli"
import { formatQty, minimumViolation, parsePairs, roundQty, toV2Symbol } from "../src/venues/kraken/pairs"
import { KrakenWs } from "../src/venues/kraken/ws"
import { BTC, FakeWallet } from "./helpers/fakes"

// Worked example from docs.kraken.com/api/docs/guides/spot-ws-book-v2 (expected checksum 3310070434).
const ASKS = [
  [45285.2, 0.001],
  [45286.4, 1.54571953],
  [45286.6, 1.54571109],
  [45289.6, 1.54560911],
  [45290.2, 0.1589066],
  [45291.8, 1.54553491],
  [45294.7, 0.04454749],
  [45296.1, 0.3538],
  [45297.5, 0.09945542],
  [45299.5, 0.18772827],
].map(([price, qty]) => ({ price, qty }))
const BIDS = [
  [45283.5, 0.1],
  [45283.4, 1.54582015],
  [45282.1, 0.1],
  [45281.0, 0.1],
  [45280.3, 1.54592586],
  [45279.0, 0.0799],
  [45277.6, 0.03310103],
  [45277.5, 0.3],
  [45277.3, 1.54602737],
  [45276.6, 0.15445238],
].map(([price, qty]) => ({ price, qty }))

describe("order book checksum", () => {
  it("matches Kraken's documented example", () => {
    expect(bookChecksum(ASKS, BIDS, 1, 8)).toBe(3310070434)
  })

  it("verifies after applying updates and detects a corrupted book", () => {
    const book = new OrderBook("BTC/USD", 10, 1, 8)
    book.snapshot(ASKS, BIDS)
    expect(book.verify(3310070434)).toBe(true)
    book.update([{ price: 45285.2, qty: 0 }], [])
    expect(book.bestAsk).toBe(45286.4)
    expect(book.verify(3310070434)).toBe(false)
  })

  it("reports mid and spread", () => {
    const book = new OrderBook("BTC/USD", 10, 1, 8)
    book.snapshot(ASKS, BIDS)
    expect(book.mid).toBeCloseTo((45285.2 + 45283.5) / 2)
    expect(book.spreadBps).toBeCloseTo((1.7 / 45284.35) * 10_000, 3)
  })
})

describe("pairs", () => {
  it("maps legacy websocket names to v2 symbols", () => {
    expect(toV2Symbol("XBT/USD")).toBe("BTC/USD")
    expect(toV2Symbol("XDG/USD")).toBe("DOGE/USD")
    const pairs = parsePairs({ XXBTZUSD: { altname: "XBTUSD", wsname: "XBT/USD", base: "XXBT", quote: "ZUSD", pair_decimals: 1, lot_decimals: 8, tick_size: "0.1", ordermin: "0.00005", costmin: "0.5", status: "online", fees: [[0, 0.4]] } })
    expect(pairs.get("BTC/USD")).toMatchObject({ restPair: "XXBTZUSD", tickSize: 0.1, orderMin: 0.00005, takerFeeBps: 40 })
  })

  it("rounds size down and enforces venue minimums", () => {
    expect(roundQty(BTC, 0.123456789)).toBe(0.12345678)
    expect(formatQty(BTC, 0.1)).toBe("0.10000000")
    expect(minimumViolation(BTC, 0.00001, 65_000)).toMatch(/below Kraken minimum/)
    expect(minimumViolation(BTC, 0.001, 65_000)).toBeNull()
  })
})

describe("KrakenWs message handling", () => {
  const ws = () => {
    const onBook = vi.fn()
    const onTicker = vi.fn()
    const client = new KrakenWs(["BTC/USD"], new Map([["BTC/USD", { ...BTC, priceDecimals: 1, lotDecimals: 8 }]]), silentLogger, { onBook, onTicker }, 10)
    return { client, onBook, onTicker }
  }

  it("builds a verified book from a snapshot and ignores updates without one", () => {
    const { client, onBook } = ws()
    client.handleMessage(JSON.stringify({ channel: "book", type: "update", data: [{ symbol: "BTC/USD", asks: [], bids: [], checksum: 1 }] }))
    expect(onBook).not.toHaveBeenCalled()
    client.handleMessage(JSON.stringify({ channel: "book", type: "snapshot", data: [{ symbol: "BTC/USD", asks: ASKS, bids: BIDS, checksum: 3310070434 }] }))
    expect(onBook).toHaveBeenCalledTimes(1)
    expect(client.books.get("BTC/USD")?.bestBid).toBe(45283.5)
  })

  it("drops a book whose checksum doesn't match", () => {
    const { client, onBook } = ws()
    client.handleMessage(JSON.stringify({ channel: "book", type: "snapshot", data: [{ symbol: "BTC/USD", asks: ASKS, bids: BIDS, checksum: 123 }] }))
    expect(onBook).not.toHaveBeenCalled()
    expect(client.books.has("BTC/USD")).toBe(false)
  })

  it("tracks tickers for subscribed symbols only", () => {
    const { client, onTicker } = ws()
    const tick = (symbol: string) => JSON.stringify({ channel: "ticker", type: "update", data: [{ symbol, bid: 1, ask: 2, last: 1.5, volume: 10, vwap: 1.4, low: 1, high: 2, change_pct: 3 }] })
    client.handleMessage(tick("ETH/USD"))
    client.handleMessage(tick("BTC/USD"))
    expect(onTicker).toHaveBeenCalledTimes(1)
    expect(client.tickers.get("BTC/USD")).toMatchObject({ bid: 1, ask: 2, change_pct: 3 })
  })
})

describe("KrakenCli", () => {
  it("parses a market fill and passes a minimal environment", async () => {
    process.env.AI_GATEWAY_API_KEY = "super-secret-gateway-key"
    const wallet = new FakeWallet()
    const fill = await wallet.cli().marketOrder("buy", "BTC/USD", "0.01000000")
    expect(fill).toMatchObject({ side: "buy", pair: "BTC/USD", volume: 0.01, price: 65_010 })
    expect(fill.fee).toBeCloseTo(0.01 * 65_010 * 0.004)
    expect(wallet.calls[0]).toEqual(["paper", "buy", "BTC/USD", "0.01000000", "-o", "json"])
    // Engine secrets never reach the child process.
    expect(JSON.stringify(wallet.envs[0])).not.toContain("super-secret-gateway-key")
    expect(wallet.envs[0].KRAKEN_WORKSPACE).toBe("test")
    delete process.env.AI_GATEWAY_API_KEY
  })

  it("classifies rejections, timeouts and a missing binary", async () => {
    const wallet = new FakeWallet(10)
    await expect(wallet.cli().marketOrder("buy", "BTC/USD", "1")).rejects.toMatchObject({ kind: "rejected" })
    wallet.failNext = "timeout"
    await expect(wallet.cli().marketOrder("buy", "BTC/USD", "0.0001")).rejects.toMatchObject({ kind: "timeout" })
    const missing = new KrakenCli("nope", "test", 1_000, silentLogger, async () => {
      throw Object.assign(new Error("spawn nope ENOENT"), { code: "ENOENT" })
    })
    await expect(missing.version()).rejects.toMatchObject({ kind: "missing" })
  })

  it("treats the real CLI's missing-workspace error as 'no workspace yet'", async () => {
    // Verbatim output of `kraken workspace show cryptomarketbot -o json` (CLI 0.4.1) before the workspace exists.
    const stdout = `{"error":"validation","message":"Validation error: Workspace 'cryptomarketbot' not found. Create it with 'kraken workspace create cryptomarketbot --capital <amount> --mode paper'."}`
    const cli = new KrakenCli("kraken", "cryptomarketbot", 1_000, silentLogger, async () => {
      throw Object.assign(new Error("exit 1"), { code: 1, stdout, stderr: "" })
    })
    expect(await cli.showWorkspace()).toBeNull()
    await expect(cli.balance()).rejects.toMatchObject({ kind: "rejected", message: expect.stringContaining("Workspace 'cryptomarketbot' not found") })
  })

  it("refuses malformed arguments before running anything", async () => {
    const wallet = new FakeWallet()
    await expect(wallet.cli().marketOrder("buy", "BTC/USD; rm -rf /", "1")).rejects.toBeInstanceOf(KrakenCliError)
    await expect(wallet.cli().marketOrder("buy", "BTC/USD", "1e3")).rejects.toBeInstanceOf(KrakenCliError)
    expect(wallet.calls).toHaveLength(0)
  })

  it("serializes calls (the workspace journal has one writer)", async () => {
    let running = 0
    let maxConcurrent = 0
    const cli = new KrakenCli("kraken", "test", 1_000, silentLogger, async () => {
      running += 1
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((r) => setTimeout(r, 10))
      running -= 1
      return { stdout: JSON.stringify({ mode: "paper", balances: {} }), stderr: "" }
    })
    await Promise.all([cli.balance(), cli.balance(), cli.balance()])
    expect(maxConcurrent).toBe(1)
  })

  it("reads balances and history with normalized asset names", async () => {
    const wallet = new FakeWallet()
    const cli = wallet.cli()
    await cli.marketOrder("buy", "BTC/USD", "0.01")
    const balances = await cli.balance()
    expect(balances.BTC.total).toBe(0.01)
    expect(balances.USD.total).toBeCloseTo(10_000 - 650.1 - 650.1 * 0.004)
    const history = await cli.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ pair: "BTC/USD", side: "buy", volume: 0.01 })
    expect(normalizePair("XBTUSD")).toBe("BTC/USD")
    expect(normalizePair("xdg/usd")).toBe("DOGE/USD")
  })
})
