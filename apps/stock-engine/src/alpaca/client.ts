import { randomUUID } from "node:crypto"
import type {
  AlpacaAccount,
  AlpacaAsset,
  AlpacaCalendarDay,
  AlpacaClock,
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
import { TokenBucket } from "@mb/engine-kit/util/async"

/**
 * Minimal typed client for Alpaca's REST APIs.
 *
 * Trading always goes to the PAPER endpoint: this bot only ever trades fake money. Stock market
 * data uses the free IEX feed (real prices, but only IEX's slice of volume); options data uses the
 * free "indicative" feed.
 */

export const TRADING_URL = "https://paper-api.alpaca.markets"
export const DATA_URL = "https://data.alpaca.markets"

export class AlpacaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "AlpacaError"
  }
}

type Query = Record<string, string | number | boolean | undefined>
type RequestOptions = { method?: string; query?: Query; body?: unknown; retry?: boolean }

const MAX_ATTEMPTS = 4
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Exponential backoff with jitter, honoring Retry-After when Alpaca sends it. */
const backoffMs = (attempt: number, retryAfter: string | null) => {
  const header = retryAfter ? Number(retryAfter) * 1000 : NaN
  if (Number.isFinite(header) && header > 0) return Math.min(header, 10_000)
  return Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 250
}

const unique = (symbols: string[]) => [...new Set(symbols.map((s) => s.toUpperCase()))]

const chunk = <T>(items: T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size))

export type AlpacaCredentials = { keyId: string; secret: string; feed?: "iex" | "sip" }

export type BarTimeframe = "1Min" | "5Min" | "15Min" | "30Min" | "1Hour" | "1Day"

export type OptionContractQuery = {
  underlying_symbols: string
  type?: "call" | "put"
  expiration_date_gte?: string
  expiration_date_lte?: string
  strike_price_gte?: number
  strike_price_lte?: number
  status?: "active" | "inactive"
}

export type OptionChainQuery = {
  type?: "call" | "put"
  expiration_date_gte?: string
  expiration_date_lte?: string
  strike_price_gte?: number
  strike_price_lte?: number
}

export type RestHealth = { ok: boolean; at: Date; error: string | null }

export const createAlpaca = ({ keyId, secret, feed = "iex" }: AlpacaCredentials, onHealth?: (h: RestHealth) => void, { requestsPerMinute = 150 } = {}) => {
  // Alpaca allows ~200 requests/minute per account; stay comfortably under it.
  const bucket = new TokenBucket(Math.max(20, requestsPerMinute / 7), requestsPerMinute / 60)

  /**
   * Network errors, rate limits (429) and 5xx responses are retried with backoff. GET/DELETE are
   * retried by default; POST only when the caller makes it safe (orders carry a unique
   * client_order_id, so a duplicate is detected instead of placed twice).
   */
  const request = async <T>(base: string, path: string, { method = "GET", query, body, retry }: RequestOptions = {}): Promise<T> => {
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    const canRetry = retry ?? method !== "POST"

    for (let attempt = 1; ; attempt++) {
      await bucket.take()
      let res: Response
      try {
        res = await fetch(url, {
          method,
          headers: {
            "APCA-API-KEY-ID": keyId,
            "APCA-API-SECRET-KEY": secret,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        })
      } catch (error) {
        if (!canRetry || attempt >= MAX_ATTEMPTS) {
          onHealth?.({ ok: false, at: new Date(), error: `${method} ${path}: ${(error as Error).message}` })
          throw error
        }
        await sleep(backoffMs(attempt, null))
        continue
      }

      const text = await res.text()
      if (res.ok) {
        onHealth?.({ ok: true, at: new Date(), error: null })
        return (text ? JSON.parse(text) : undefined) as T
      }
      if (canRetry && RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt, res.headers.get("retry-after")))
        continue
      }
      let message = text
      try {
        message = (JSON.parse(text) as { message?: string }).message ?? text
      } catch {}
      const error = new AlpacaError(res.status, `Alpaca ${method} ${path} failed (${res.status}): ${message}`)
      // 4xx answers (a rejected order, an unknown symbol) mean the API itself is working.
      onHealth?.({ ok: res.status < 500, at: new Date(), error: res.status >= 500 ? error.message : null })
      throw error
    }
  }

  const trading = <T>(path: string, opts?: RequestOptions) => request<T>(TRADING_URL, path, opts)
  const data = <T>(path: string, opts?: RequestOptions) => request<T>(DATA_URL, path, opts)

  const alpaca = {
    getAccount: () => trading<AlpacaAccount>("/v2/account"),

    getClock: () => trading<AlpacaClock>("/v2/clock"),

    getCalendar: (start: string, end: string) => trading<AlpacaCalendarDay[]>("/v2/calendar", { query: { start, end } }),

    getPositions: () => trading<AlpacaPosition[]>("/v2/positions"),

    listOrders: (query: {
      status?: "open" | "closed" | "all"
      after?: string
      until?: string
      limit?: number
      nested?: boolean
      symbols?: string
      direction?: "asc" | "desc"
    }) => trading<AlpacaOrder[]>("/v2/orders", { query }),

    getOrder: (id: string) => trading<AlpacaOrder>(`/v2/orders/${id}`, { query: { nested: true } }),

    getOrderByClientId: (clientOrderId: string) => trading<AlpacaOrder>("/v2/orders:by_client_order_id", { query: { client_order_id: clientOrderId } }),

    /**
     * Places an order, retrying transient failures. Every order gets a unique client_order_id, so if
     * a retry is rejected as a duplicate, the first attempt actually went through and that order is returned.
     */
    submitOrder: async (order: NewOrder): Promise<AlpacaOrder> => {
      const body = { ...order, client_order_id: order.client_order_id ?? `smb-${randomUUID()}` }
      try {
        return await trading<AlpacaOrder>("/v2/orders", { method: "POST", body, retry: true })
      } catch (error) {
        if (error instanceof AlpacaError && error.status === 422 && /client.?order.?id/i.test(error.message)) {
          return alpaca.getOrderByClientId(body.client_order_id)
        }
        throw error
      }
    },

    cancelOrder: (id: string) => trading<void>(`/v2/orders/${id}`, { method: "DELETE" }),

    closeAllPositions: () => trading<unknown>("/v2/positions", { method: "DELETE", query: { cancel_orders: true } }),

    getAsset: (symbol: string) => trading<AlpacaAsset>(`/v2/assets/${encodeURIComponent(symbol)}`),

    /** Every active US equity (about 14k; one call). */
    listAssets: () => trading<AlpacaAsset[]>("/v2/assets", { query: { status: "active", asset_class: "us_equity" } }),

    getPortfolioHistory: (period: string, timeframe: string) =>
      trading<PortfolioHistory>("/v2/account/portfolio/history", { query: { period, timeframe, intraday_reporting: "market_hours" } }),

    /** Latest trade, quote, minute bar, daily bar and previous daily bar per symbol. */
    getSnapshots: async (symbols: string[]): Promise<Record<string, Snapshot>> => {
      const result: Record<string, Snapshot> = {}
      for (const group of chunk(unique(symbols), 100)) {
        if (group.length === 0) continue
        const page = await data<Record<string, Snapshot | null>>("/v2/stocks/snapshots", { query: { symbols: group.join(","), feed } })
        for (const [symbol, snap] of Object.entries(page)) if (snap) result[symbol] = snap
      }
      return result
    },

    /**
     * Historical bars for many symbols, following pagination. `feed: "sip"` (all exchanges) works on
     * the free plan only for data more than 15 minutes old.
     */
    getBars: async (symbols: string[], timeframe: BarTimeframe, start: Date, end?: Date, opts: { feed?: "iex" | "sip" } = {}): Promise<Record<string, Bar[]>> => {
      const result: Record<string, Bar[]> = {}
      const list = unique(symbols)
      if (list.length === 0) return result
      let pageToken: string | undefined
      for (let page = 0; page < 30; page++) {
        const res = await data<{ bars: Record<string, Bar[]> | null; next_page_token: string | null }>("/v2/stocks/bars", {
          query: {
            symbols: list.join(","),
            timeframe,
            start: start.toISOString(),
            end: end?.toISOString(),
            feed: opts.feed ?? feed,
            adjustment: "split",
            limit: 10_000,
            page_token: pageToken,
          },
        })
        for (const [symbol, bars] of Object.entries(res.bars ?? {})) result[symbol] = [...(result[symbol] ?? []), ...bars]
        if (!res.next_page_token) break
        pageToken = res.next_page_token
      }
      return result
    },

    /**
     * One page of historical bars (up to 10,000, oldest first per symbol) and the next page's
     * token: the history backfill's resumable unit. SIP, adjusted for splits like getBars.
     */
    getBarsPage: async (symbols: string[], timeframe: BarTimeframe, start: Date, end: Date, pageToken: string | null): Promise<{ bars: Record<string, Bar[]>; next: string | null }> => {
      const res = await data<{ bars: Record<string, Bar[]> | null; next_page_token: string | null }>("/v2/stocks/bars", {
        query: { symbols: unique(symbols).join(","), timeframe, start: start.toISOString(), end: end.toISOString(), feed: "sip", adjustment: "split", limit: 10_000, page_token: pageToken ?? undefined },
      })
      return { bars: res.bars ?? {}, next: res.next_page_token }
    },

    getMovers: (top = 20) => data<{ gainers: Mover[]; losers: Mover[] }>("/v1beta1/screener/stocks/movers", { query: { top } }),

    getMostActives: (top = 20) => data<{ most_actives: MostActive[] }>("/v1beta1/screener/stocks/most-actives", { query: { by: "volume", top } }),

    getNews: async (symbols: string[] | null, start: Date, limit = 30): Promise<NewsItem[]> => {
      const res = await data<{ news: NewsItem[] }>("/v1beta1/news", {
        query: {
          symbols: symbols && symbols.length > 0 ? unique(symbols).join(",") : undefined,
          start: start.toISOString(),
          limit: Math.min(limit, 50),
          sort: "desc",
          exclude_contentless: true,
        },
      })
      return res.news ?? []
    },

    // ─── Options ──────────────────────────────────────────────────────────────

    /** Listed contracts (with open interest), following pagination. */
    getOptionContracts: async (query: OptionContractQuery): Promise<OptionContract[]> => {
      const out: OptionContract[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 10; page++) {
        const res = await trading<{ option_contracts: OptionContract[] | null; next_page_token: string | null }>("/v2/options/contracts", {
          query: { status: "active", ...query, limit: 1_000, page_token: pageToken },
        })
        out.push(...(res.option_contracts ?? []))
        if (!res.next_page_token) break
        pageToken = res.next_page_token
      }
      return out
    },

    /** Quotes, greeks and implied volatility for an underlying's contracts (indicative feed). */
    getOptionChain: async (underlying: string, query: OptionChainQuery = {}): Promise<Record<string, OptionSnapshot>> => {
      const result: Record<string, OptionSnapshot> = {}
      let pageToken: string | undefined
      for (let page = 0; page < 10; page++) {
        const res = await data<{ snapshots: Record<string, OptionSnapshot> | null; next_page_token: string | null }>(
          `/v1beta1/options/snapshots/${encodeURIComponent(underlying.toUpperCase())}`,
          { query: { feed: "indicative", ...query, limit: 1_000, page_token: pageToken } },
        )
        Object.assign(result, res.snapshots ?? {})
        if (!res.next_page_token) break
        pageToken = res.next_page_token
      }
      return result
    },

    /** Snapshots for specific contracts (e.g. the legs of open positions). */
    getOptionSnapshots: async (symbols: string[]): Promise<Record<string, OptionSnapshot>> => {
      const result: Record<string, OptionSnapshot> = {}
      for (const group of chunk(unique(symbols), 100)) {
        if (group.length === 0) continue
        const res = await data<{ snapshots: Record<string, OptionSnapshot> | null }>("/v1beta1/options/snapshots", {
          query: { symbols: group.join(","), feed: "indicative" },
        })
        Object.assign(result, res.snapshots ?? {})
      }
      return result
    },
  }
  return alpaca
}

export type Alpaca = ReturnType<typeof createAlpaca>
