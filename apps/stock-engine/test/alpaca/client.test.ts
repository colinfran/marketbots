import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AlpacaError, createAlpaca, type Alpaca, type RestHealth } from "../../src/alpaca/client"
import { alpacaOrder, bar } from "../helpers/factories"
import { fetchCall, json, mockFetch, text } from "../helpers/fetch"
import { settle } from "../helpers/timers"

const TRADING = "https://paper-api.alpaca.markets"
const DATA = "https://data.alpaca.markets"

let alpaca: Alpaca
const health: RestHealth[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  health.length = 0
  // No client-side rate limiting in tests (it's covered on its own below).
  alpaca = createAlpaca({ keyId: "test-key", secret: "test-secret" }, (h) => health.push(h), { requestsPerMinute: 1_000_000 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("request basics", () => {
  it("sends authenticated, uncached requests to the paper trading endpoint", async () => {
    const fetch = mockFetch(json({ id: "acct", equity: "10000" }))
    expect(await alpaca.getAccount()).toEqual({ id: "acct", equity: "10000" })
    const { url, init } = fetchCall(fetch)
    expect(url.href).toBe(`${TRADING}/v2/account`)
    expect(init).toMatchObject({
      method: "GET",
      headers: { "APCA-API-KEY-ID": "test-key", "APCA-API-SECRET-KEY": "test-secret" },
      body: undefined,
    })
    expect(init.headers).not.toHaveProperty("Content-Type")
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("never talks to the live trading endpoint", async () => {
    const fetch = mockFetch(json({}), json([]), json([]))
    await alpaca.getClock()
    await alpaca.getPositions()
    await alpaca.listOrders({ status: "open" })
    for (let i = 0; i < 3; i++) expect(fetchCall(fetch, i).url.origin).toBe(TRADING)
  })

  it("encodes query params and skips undefined ones", async () => {
    const fetch = mockFetch(json([]))
    await alpaca.listOrders({ status: "all", limit: 500, nested: true, after: undefined, symbols: "AAPL,MSFT" })
    const { url } = fetchCall(fetch)
    expect(url.pathname).toBe("/v2/orders")
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "all", limit: "500", nested: "true", symbols: "AAPL,MSFT" })
  })

  it("returns undefined for an empty body (e.g. DELETE 204)", async () => {
    mockFetch(new Response(null, { status: 204 }))
    expect(await alpaca.cancelOrder("abc")).toBeUndefined()
  })
})

describe("errors", () => {
  it("throws AlpacaError with the status and Alpaca's message", async () => {
    mockFetch(json({ code: 40310000, message: "insufficient buying power" }, { status: 403 }))
    const error = await alpaca.getAccount().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AlpacaError)
    expect(error).toMatchObject({ name: "AlpacaError", status: 403, message: "Alpaca GET /v2/account failed (403): insufficient buying power" })
  })

  it("keeps the raw text when the error body isn't JSON", async () => {
    mockFetch(text("<html>Bad Gateway</html>", { status: 404 }))
    await expect(alpaca.getClock()).rejects.toThrow("Alpaca GET /v2/clock failed (404): <html>Bad Gateway</html>")
  })

  it("keeps the raw text when the JSON has no message", async () => {
    mockFetch(json({ code: 1 }, { status: 400 }))
    await expect(alpaca.getClock()).rejects.toThrow('failed (400): {"code":1}')
  })

  it.each([400, 401, 403, 404, 422])("does not retry a %i", async (status) => {
    const fetch = mockFetch(json({ message: "nope" }, { status }))
    await expect(alpaca.getAccount()).rejects.toMatchObject({ status })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe("retries", () => {
  it.each([408, 429, 500, 502, 503, 504])("retries a GET that returns %i", async (status) => {
    const fetch = mockFetch(json({ message: "busy" }, { status }), json({ is_open: true }))
    expect(await settle(alpaca.getClock())).toEqual({ is_open: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it("gives up after 4 attempts with the last error", async () => {
    const fetch = mockFetch(...Array.from({ length: 4 }, () => json({ message: "down" }, { status: 503 })))
    await expect(settle(alpaca.getClock())).rejects.toMatchObject({ status: 503, message: expect.stringContaining("down") })
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it("retries network errors on GET and rethrows the original error at the end", async () => {
    const fetch = mockFetch(new TypeError("fetch failed"), new TypeError("fetch failed"), json([]))
    expect(await settle(alpaca.getPositions())).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(3)

    mockFetch(...Array.from({ length: 4 }, () => new TypeError("socket hang up")))
    await expect(settle(alpaca.getPositions())).rejects.toThrow("socket hang up")
  })

  it("retries DELETE requests", async () => {
    const fetch = mockFetch(json({}, { status: 500 }), new Response(null, { status: 204 }))
    await settle(alpaca.cancelOrder("o1"))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetchCall(fetch, 1).init.method).toBe("DELETE")
  })

  it("backs off exponentially: 500ms, 1s, 2s", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const fetch = mockFetch(json({}, { status: 500 }), json({}, { status: 500 }), json({}, { status: 500 }), json({}))
    const done = alpaca.getClock()
    for (const [wait, calls] of [[0, 1], [499, 1], [1, 2], [999, 2], [1, 3], [1_999, 3], [1, 4]]) {
      await vi.advanceTimersByTimeAsync(wait)
      expect(fetch).toHaveBeenCalledTimes(calls)
    }
    await done
  })

  it("adds up to 250ms of jitter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.996) // 500 + 249ms
    const fetch = mockFetch(json({}, { status: 500 }), json({}))
    const done = alpaca.getClock()
    await vi.advanceTimersByTimeAsync(748)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await done
  })

  it("honors Retry-After, capped at 10 seconds", async () => {
    const fetch = mockFetch(json({}, { status: 429, headers: { "retry-after": "3" } }), json({}, { status: 429, headers: { "retry-after": "120" } }), json({}))
    const done = alpaca.getClock()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(3)
    await done
  })
})

describe("submitOrder", () => {
  const order = { symbol: "AAPL", qty: "5", side: "buy" as const, type: "market" as const, time_in_force: "gtc" as const }

  it("POSTs JSON with a unique client_order_id", async () => {
    const fetch = mockFetch(json(alpacaOrder()), json(alpacaOrder()))
    await alpaca.submitOrder(order)
    await alpaca.submitOrder(order)
    const first = fetchCall(fetch, 0)
    expect(first.url.href).toBe(`${TRADING}/v2/orders`)
    expect(first.init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } })
    expect(first.body).toEqual({ ...order, client_order_id: expect.stringMatching(/^smb-[0-9a-f-]{36}$/) })
    expect(fetchCall(fetch, 1).body.client_order_id).not.toBe(first.body.client_order_id)
  })

  it("keeps a caller-supplied client_order_id", async () => {
    const fetch = mockFetch(json(alpacaOrder()))
    await alpaca.submitOrder({ ...order, client_order_id: "smb-buy-123" })
    expect(fetchCall(fetch).body.client_order_id).toBe("smb-buy-123")
  })

  it("retries transient failures with the same client_order_id", async () => {
    const fetch = mockFetch(json({ message: "busy" }, { status: 503 }), json(alpacaOrder({ id: "placed" })))
    expect((await settle(alpaca.submitOrder(order))).id).toBe("placed")
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetchCall(fetch, 1).body.client_order_id).toBe(fetchCall(fetch, 0).body.client_order_id)
  })

  it("returns the original order when a retry is rejected as a duplicate", async () => {
    // Attempt 1 reached Alpaca but the response was lost; attempt 2 is a duplicate.
    const fetch = mockFetch(
      new TypeError("fetch failed"),
      json({ message: "client_order_id must be unique" }, { status: 422 }),
      json(alpacaOrder({ id: "original" })),
    )
    const result = await settle(alpaca.submitOrder({ ...order, client_order_id: "smb-x" }))
    expect(result.id).toBe("original")
    const lookup = fetchCall(fetch, 2)
    expect(lookup.url.pathname).toBe("/v2/orders:by_client_order_id")
    expect(lookup.url.searchParams.get("client_order_id")).toBe("smb-x")
    expect(lookup.init.method).toBe("GET")
  })

  it("rethrows other 422s without looking anything up", async () => {
    const fetch = mockFetch(json({ message: "qty must be > 0" }, { status: 422 }))
    await expect(alpaca.submitOrder(order)).rejects.toMatchObject({ status: 422 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("rethrows non-Alpaca errors", async () => {
    mockFetch(...Array.from({ length: 4 }, () => new TypeError("fetch failed")))
    await expect(settle(alpaca.submitOrder(order))).rejects.toThrow("fetch failed")
  })
})

describe("trading endpoints", () => {
  it("builds the right paths and params", async () => {
    const fetch = mockFetch(json([]), json({}), json({}), json([]), json({}))
    await alpaca.getCalendar("2026-10-26", "2026-10-30")
    await alpaca.getOrder("o1")
    await alpaca.getAsset("BRK/B")
    await alpaca.closeAllPositions()
    await alpaca.getPortfolioHistory("1M", "1D")

    expect(fetchCall(fetch, 0).url.href).toBe(`${TRADING}/v2/calendar?start=2026-10-26&end=2026-10-30`)
    expect(fetchCall(fetch, 1).url.href).toBe(`${TRADING}/v2/orders/o1?nested=true`)
    expect(fetchCall(fetch, 2).url.pathname).toBe("/v2/assets/BRK%2FB")
    expect(fetchCall(fetch, 3).url.href).toBe(`${TRADING}/v2/positions?cancel_orders=true`)
    expect(fetchCall(fetch, 3).init.method).toBe("DELETE")
    expect(Object.fromEntries(fetchCall(fetch, 4).url.searchParams)).toEqual({ period: "1M", timeframe: "1D", intraday_reporting: "market_hours" })
  })
})

describe("market data", () => {
  it("fetches snapshots from the IEX feed, uppercased and deduped, skipping nulls", async () => {
    const fetch = mockFetch(json({ AAPL: { latestTrade: { p: 200, t: "t" } }, DEAD: null }))
    const result = await alpaca.getSnapshots(["aapl", "AAPL", "dead"])
    expect(result).toEqual({ AAPL: { latestTrade: { p: 200, t: "t" } } })
    const { url } = fetchCall(fetch)
    expect(url.origin + url.pathname).toBe(`${DATA}/v2/stocks/snapshots`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ symbols: "AAPL,DEAD", feed: "iex" })
  })

  it("splits snapshot requests into chunks of 100", async () => {
    const symbols = Array.from({ length: 205 }, (_, i) => `S${i}`)
    const fetch = mockFetch(json({ S0: {} }), json({ S100: {} }), json({ S200: {} }))
    const result = await alpaca.getSnapshots(symbols)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetchCall(fetch, 0).url.searchParams.get("symbols")!.split(",")).toHaveLength(100)
    expect(fetchCall(fetch, 2).url.searchParams.get("symbols")!.split(",")).toHaveLength(5)
    expect(Object.keys(result)).toEqual(["S0", "S100", "S200"])
  })

  it("skips the request entirely for no symbols", async () => {
    const fetch = mockFetch()
    expect(await alpaca.getSnapshots([])).toEqual({})
    expect(await alpaca.getBars([], "1Day", new Date())).toEqual({})
    expect(fetch).not.toHaveBeenCalled()
  })

  it("follows bar pagination and merges pages per symbol", async () => {
    const a1 = bar("09:30", 1)
    const a2 = bar("09:35", 2)
    const b1 = bar("09:30", 10)
    const fetch = mockFetch(
      json({ bars: { AAPL: [a1], MSFT: [b1] }, next_page_token: "page2" }),
      json({ bars: { AAPL: [a2] }, next_page_token: null }),
    )
    const start = new Date("2026-10-26T13:30:00Z")
    const end = new Date("2026-10-26T20:00:00Z")
    const result = await alpaca.getBars(["aapl", "MSFT"], "5Min", start, end)
    expect(result).toEqual({ AAPL: [a1, a2], MSFT: [b1] })

    const first = Object.fromEntries(fetchCall(fetch, 0).url.searchParams)
    expect(first).toEqual({
      symbols: "AAPL,MSFT",
      timeframe: "5Min",
      start: start.toISOString(),
      end: end.toISOString(),
      feed: "iex",
      adjustment: "split",
      limit: "10000",
    })
    expect(fetchCall(fetch, 1).url.searchParams.get("page_token")).toBe("page2")
  })

  it("omits end when not given and tolerates null bars", async () => {
    const fetch = mockFetch(json({ bars: null, next_page_token: null }))
    expect(await alpaca.getBars(["AAPL"], "1Day", new Date("2026-09-01T00:00:00Z"))).toEqual({})
    expect(fetchCall(fetch).url.searchParams.has("end")).toBe(false)
  })

  it("stops paginating after 30 pages", async () => {
    const fetch = mockFetch(...Array.from({ length: 30 }, (_, i) => json({ bars: { A: [bar("09:30", i)] }, next_page_token: "more" })))
    const result = await alpaca.getBars(["A"], "5Min", new Date())
    expect(fetch).toHaveBeenCalledTimes(30)
    expect(result.A).toHaveLength(30)
  })

  it("queries the screeners", async () => {
    const fetch = mockFetch(json({ gainers: [], losers: [] }), json({ most_actives: [] }), json({ gainers: [], losers: [] }))
    await alpaca.getMovers(25)
    await alpaca.getMostActives(25)
    await alpaca.getMovers()
    expect(fetchCall(fetch, 0).url.href).toBe(`${DATA}/v1beta1/screener/stocks/movers?top=25`)
    expect(fetchCall(fetch, 1).url.href).toBe(`${DATA}/v1beta1/screener/stocks/most-actives?by=volume&top=25`)
    expect(fetchCall(fetch, 2).url.searchParams.get("top")).toBe("20")
  })

  it("fetches news with symbols, a capped limit and no empty articles", async () => {
    const start = new Date("2026-10-26T12:00:00Z")
    const fetch = mockFetch(json({ news: [{ id: 1 }] }), json({}), json({ news: [] }))
    expect(await alpaca.getNews(["nvda", "NVDA", "amd"], start, 80)).toEqual([{ id: 1 }])
    expect(Object.fromEntries(fetchCall(fetch, 0).url.searchParams)).toEqual({
      symbols: "NVDA,AMD",
      start: start.toISOString(),
      limit: "50",
      sort: "desc",
      exclude_contentless: "true",
    })

    expect(await alpaca.getNews(null, start)).toEqual([])
    expect(fetchCall(fetch, 1).url.searchParams.has("symbols")).toBe(false)
    expect(fetchCall(fetch, 1).url.searchParams.get("limit")).toBe("30")

    await alpaca.getNews([], start)
    expect(fetchCall(fetch, 2).url.searchParams.has("symbols")).toBe(false)
  })
})

describe("options endpoints", () => {
  it("lists contracts on the trading API with filters, following pages", async () => {
    const fetch = mockFetch(json({ option_contracts: [{ symbol: "A" }], next_page_token: "p2" }), json({ option_contracts: [{ symbol: "B" }], next_page_token: null }))
    const list = await alpaca.getOptionContracts({ underlying_symbols: "NVDA", expiration_date_gte: "2026-11-09", strike_price_lte: 175 })
    expect(list.map((c) => c.symbol)).toEqual(["A", "B"])
    const { url } = fetchCall(fetch)
    expect(url.origin + url.pathname).toBe(`${TRADING}/v2/options/contracts`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ status: "active", underlying_symbols: "NVDA", expiration_date_gte: "2026-11-09", strike_price_lte: "175", limit: "1000" })
    expect(fetchCall(fetch, 1).url.searchParams.get("page_token")).toBe("p2")
  })

  it("reads an underlying's chain from the free indicative feed", async () => {
    const fetch = mockFetch(json({ snapshots: { X: { latestQuote: { bp: 1, ap: 1.1 } } }, next_page_token: null }))
    expect(await alpaca.getOptionChain("nvda", { type: "call" })).toEqual({ X: { latestQuote: { bp: 1, ap: 1.1 } } })
    const { url } = fetchCall(fetch)
    expect(url.origin + url.pathname).toBe(`${DATA}/v1beta1/options/snapshots/NVDA`)
    expect(url.searchParams.get("feed")).toBe("indicative")
    expect(url.searchParams.get("type")).toBe("call")
  })

  it("fetches snapshots for specific contracts in chunks of 100", async () => {
    const symbols = Array.from({ length: 150 }, (_, i) => `NVDA261120C${String(i).padStart(8, "0")}`)
    const fetch = mockFetch(json({ snapshots: {} }), json({ snapshots: null }))
    await alpaca.getOptionSnapshots(symbols)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetchCall(fetch, 0).url.pathname).toBe("/v1beta1/options/snapshots")
    expect(fetchCall(fetch, 1).url.searchParams.get("symbols")!.split(",")).toHaveLength(50)
  })

  it("submits multi-leg orders as one request", async () => {
    const fetch = mockFetch(json(alpacaOrder({ order_class: "mleg" })))
    await alpaca.submitOrder({
      order_class: "mleg",
      qty: "2",
      type: "limit",
      limit_price: "3.10",
      time_in_force: "day",
      legs: [
        { symbol: "NVDA261120C00140000", ratio_qty: "1", side: "buy", position_intent: "buy_to_open" },
        { symbol: "NVDA261120C00150000", ratio_qty: "1", side: "sell", position_intent: "sell_to_open" },
      ],
    })
    expect(fetchCall(fetch).body).toMatchObject({ order_class: "mleg", limit_price: "3.10", legs: [{ side: "buy" }, { side: "sell" }] })
  })
})

describe("health reporting", () => {
  it("reports successes, client errors as healthy and server errors as unhealthy", async () => {
    mockFetch(json({}), json({ message: "nope" }, { status: 422 }), json({}, { status: 501 }))
    await alpaca.getClock()
    await alpaca.getClock().catch(() => undefined)
    await alpaca.getClock().catch(() => undefined)
    expect(health.map((h) => h.ok)).toEqual([true, true, false])
  })
})
