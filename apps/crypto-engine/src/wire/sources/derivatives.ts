import { crossingId, crossingMeta, metricSource, type MetricRule, type MetricWatcher } from "../metrics"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { baseOf, num, settleAll, signed, universeBases, usd } from "./common"

/**
 * Derivatives positioning as wire items (MASTER_PLAN §4.1 wave 2): perpetual funding, open
 * interest, implied volatility and liquidations from public venue APIs. All of it is
 * `funding_extreme` or `liquidation_cascade`, which the policy only annotates (§3.5): crowded
 * positioning is context for Grok, not a reason to start a cycle.
 *
 *   kraken_futures  Kraken Futures tickers (PF_ linear perps; Kraken calls bitcoin XBT)
 *   hyperliquid     Hyperliquid `metaAndAssetCtxs`
 *   deribit         DVOL (BTC, ETH) and BTC/ETH perpetual funding
 *   coinalyze       funding averaged over the Binance and Bybit USDT perps, and liquidations
 *
 * An open-interest jump is filed under `funding_extreme` too: it is the same story (leverage
 * building or leaving), and like funding it describes positioning without explaining a move.
 * Thin markets are skipped: their funding swings on a few trades.
 */

/** Below this open interest a market's funding is noise. */
const FUNDING_MIN_OI_USD = 2e6
/** Open-interest changes only count on markets at least this deep. */
const OI_MIN_USD = 5e6
const OI_RULE: MetricRule = { id: "oi", kind: "change", windowMin: 60, pct: 20 }
const DVOL_RULE: MetricRule = { id: "dvol", kind: "change", windowMin: 60, pct: 15, direction: "up" }
/** Longs or shorts liquidated within 15 minutes (Binance + Bybit) that count as a cascade. */
const LIQUIDATION_USD: Record<string, number> = { BTC: 20e6, ETH: 10e6 }
const LIQUIDATION_DEFAULT_USD = 3e6
const LIQUIDATION_WINDOW_MS = 15 * 60_000

const HOURS_PER_YEAR = 24 * 365
const fundingRule = (ctx: SourceContext): MetricRule => ({ id: "funding", kind: "level", abs: ctx.settings().funding_extreme_annual_pct })

/** `openInterestUsd` null: an aggregate, or a venue whose depth we don't read (no thin-market floor, no open-interest rule). */
export type PerpReading = { symbol: string; fundingAnnualPct: number | null; openInterest: number | null; openInterestUsd: number | null }
type Venue = { id: string; label: string; url: (symbol: string) => string }

/** Funding beyond ±funding_extreme_annual_pct, and open interest moving ≥ 20% within an hour, as items. */
export const perpItems = (venue: Venue, readings: PerpReading[], w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const items: RawItem[] = []
  for (const r of readings) {
    const oiUsd = r.openInterestUsd
    if (r.fundingAnnualPct !== null && (oiUsd === null || oiUsd >= FUNDING_MIN_OI_USD)) {
      for (const c of w.observe(`${venue.id}:funding:${r.symbol}`, r.fundingAnnualPct, at, [fundingRule(ctx)])) {
        items.push({
          sourceId: crossingId(c),
          title: `${r.symbol} perp funding at ${signed(c.value, 0)}%/yr on ${venue.label} (${c.value > 0 ? "longs pay shorts" : "shorts pay longs"})`,
          url: venue.url(r.symbol),
          symbols: [r.symbol],
          category: "funding_extreme",
          kind: "derivatives",
          polarity: 0,
          publishedAt: new Date(at),
          meta: { ...crossingMeta(c), venue: venue.id, signal: "funding", funding_annual_pct: Math.round(c.value * 10) / 10, oi_usd: oiUsd === null ? null : Math.round(oiUsd) },
        })
      }
    }
    if (r.openInterest !== null && oiUsd !== null && oiUsd >= OI_MIN_USD) {
      for (const c of w.observe(`${venue.id}:oi:${r.symbol}`, r.openInterest, at, [OI_RULE])) {
        items.push({
          sourceId: crossingId(c),
          title: `${r.symbol} open interest on ${venue.label} ${c.delta! > 0 ? "up" : "down"} ${Math.abs(c.pct!).toFixed(0)}% in ${c.windowMin} min (${usd(oiUsd)})`,
          url: venue.url(r.symbol),
          symbols: [r.symbol],
          category: "funding_extreme",
          kind: "derivatives",
          polarity: 0,
          publishedAt: new Date(at),
          meta: { ...crossingMeta(c), venue: venue.id, signal: "open_interest", oi_usd: Math.round(oiUsd) },
        })
      }
    }
  }
  return items
}

// ── Kraken Futures ──────────────────────────────────────────────────────────

type KrakenFuturesTicker = { symbol: string; tag?: string; markPrice?: number; openInterest?: number; relativeFundingRate?: number; suspended?: boolean }

/** Linear perps (PF_) of universe assets. Their funding is charged hourly; XBT is bitcoin. */
export const krakenFuturesReadings = (body: { tickers?: KrakenFuturesTicker[] }, universe: Map<string, string>): PerpReading[] => {
  const out: PerpReading[] = []
  for (const t of body.tickers ?? []) {
    const m = /^PF_([A-Z0-9]+)USD$/.exec(t.symbol)
    if (!m || t.suspended) continue
    const symbol = universe.get(m[1] === "XBT" ? "BTC" : m[1])
    if (!symbol) continue
    const oi = num(t.openInterest)
    const mark = num(t.markPrice)
    const rate = num(t.relativeFundingRate)
    out.push({ symbol, fundingAnnualPct: rate === null ? null : rate * HOURS_PER_YEAR * 100, openInterest: oi, openInterestUsd: oi !== null && mark !== null ? oi * mark : null })
  }
  return out
}

const KRAKEN_FUTURES: Venue = { id: "kraken_futures", label: "Kraken Futures", url: () => "https://futures.kraken.com" }

// ── Hyperliquid ─────────────────────────────────────────────────────────────

type HlMeta = { universe: { name: string; isDelisted?: boolean }[] }
type HlCtx = { funding?: string; openInterest?: string; markPx?: string }

/** `metaAndAssetCtxs` → readings for universe coins. Hyperliquid funding is hourly too. */
export const hyperliquidReadings = (body: unknown, universe: Map<string, string>): PerpReading[] => {
  if (!Array.isArray(body) || body.length < 2) throw new Error("hyperliquid: unexpected metaAndAssetCtxs shape")
  const [meta, ctxs] = body as [HlMeta, HlCtx[]]
  const out: PerpReading[] = []
  meta.universe.forEach((asset, i) => {
    const symbol = universe.get(asset.name.toUpperCase())
    const c = ctxs[i]
    if (!symbol || !c || asset.isDelisted) return
    const funding = num(c.funding)
    const oi = num(c.openInterest)
    const mark = num(c.markPx)
    out.push({ symbol, fundingAnnualPct: funding === null ? null : funding * HOURS_PER_YEAR * 100, openInterest: oi, openInterestUsd: oi !== null && mark !== null ? oi * mark : null })
  })
  return out
}

const HYPERLIQUID: Venue = { id: "hyperliquid", label: "Hyperliquid", url: (symbol) => `https://app.hyperliquid.xyz/trade/${baseOf(symbol)}` }

// ── Deribit ─────────────────────────────────────────────────────────────────

type DeribitDvol = { result?: { data?: [number, number, number, number, number][] } }
type DeribitTicker = { result?: { instrument_name?: string; funding_8h?: number; open_interest?: number } }

/** The latest DVOL close, or null. */
export const latestDvol = (body: DeribitDvol): number | null => {
  const rows = body.result?.data ?? []
  return rows.length ? num(rows[rows.length - 1][4]) : null
}

/** 8-hour funding (a fraction) → % a year. */
export const deribitFundingAnnualPct = (body: DeribitTicker): number | null => {
  const f = num(body.result?.funding_8h)
  return f === null ? null : f * 3 * 365 * 100
}

const DERIBIT_API = "https://www.deribit.com/api/v2/public"
const DERIBIT: Venue = { id: "deribit", label: "Deribit", url: () => "https://www.deribit.com" }

const deribitPoll = (ctx: SourceContext, w: MetricWatcher) => async (): Promise<RawItem[]> => {
  const universe = universeBases(ctx)
  const coins = ["BTC", "ETH"].filter((b) => universe.has(b))
  const now = ctx.now().getTime()
  const results = await settleAll<{ coin: string; dvol?: number | null; funding?: number | null }>(
    coins.flatMap((coin) => [
      async () => ({ coin, dvol: latestDvol((await ctx.fetch.json<DeribitDvol>(`${DERIBIT_API}/get_volatility_index_data?currency=${coin}&resolution=60&start_timestamp=${now - 15 * 60_000}&end_timestamp=${now}`, { conditional: false })) ?? {}) }),
      async () => ({ coin, funding: deribitFundingAnnualPct((await ctx.fetch.json<DeribitTicker>(`${DERIBIT_API}/ticker?instrument_name=${coin}-PERPETUAL`, { conditional: false })) ?? {}) }),
    ]),
  )
  const items: RawItem[] = []
  const readings: PerpReading[] = []
  for (const r of results) {
    if (!r) continue
    const symbol = universe.get(r.coin)!
    if (r.funding !== undefined) readings.push({ symbol, fundingAnnualPct: r.funding, openInterest: null, openInterestUsd: null })
    if (r.dvol !== undefined && r.dvol !== null) {
      for (const c of w.observe(`deribit:dvol:${r.coin}`, r.dvol, now, [DVOL_RULE])) {
        items.push({
          sourceId: crossingId(c),
          title: `${r.coin} implied volatility (Deribit DVOL) up ${c.pct!.toFixed(0)}% in ${c.windowMin} min to ${c.value.toFixed(1)}`,
          url: "https://www.deribit.com",
          symbols: [symbol],
          category: "funding_extreme",
          kind: "derivatives",
          polarity: 0,
          publishedAt: new Date(now),
          meta: { ...crossingMeta(c), venue: "deribit", signal: "dvol" },
        })
      }
    }
  }
  return [...items, ...perpItems(DERIBIT, readings, w, ctx)]
}

// ── Coinalyze ───────────────────────────────────────────────────────────────

type CoinalyzeMarket = { symbol: string; exchange: string; base_asset: string; quote_asset: string; is_perpetual: boolean; margined: string }
type CoinalyzeFunding = { symbol: string; value: number }
type CoinalyzeLiquidations = { symbol: string; history: { t: number; l: number; s: number }[] }

const COINALYZE_API = "https://api.coinalyze.net/v1"
/** Binance (A) and Bybit (6) USDT perps: most of the market's perp open interest. */
const COINALYZE_EXCHANGES = ["A", "6"]
const BATCH = 20
const MARKETS_TTL_MS = 24 * 3_600_000

/** Universe base → its Binance/Bybit USDT perp symbols on Coinalyze. */
export const coinalyzeSymbols = (markets: CoinalyzeMarket[], bases: Iterable<string>) => {
  const want = new Set(bases)
  const out = new Map<string, string[]>()
  for (const m of markets) {
    const base = m.base_asset?.toUpperCase()
    if (!m.is_perpetual || m.margined !== "STABLE" || m.quote_asset !== "USDT" || !COINALYZE_EXCHANGES.includes(m.exchange) || !want.has(base)) continue
    out.set(base, [...(out.get(base) ?? []), m.symbol])
  }
  return out
}

/** Average funding per base, % a year (Coinalyze reports % per 8-hour period). */
export const coinalyzeFunding = (rows: CoinalyzeFunding[], bySymbol: Map<string, string>) => {
  const sums = new Map<string, { total: number; n: number }>()
  for (const r of rows) {
    const base = bySymbol.get(r.symbol)
    const v = num(r.value)
    if (!base || v === null) continue
    const s = sums.get(base) ?? { total: 0, n: 0 }
    sums.set(base, { total: s.total + v, n: s.n + 1 })
  }
  return new Map([...sums].map(([base, s]) => [base, (s.total / s.n) * 3 * 365]))
}

/** Longs and shorts liquidated (USD) per base in buckets starting within the window. */
export const coinalyzeLiquidations = (rows: CoinalyzeLiquidations[], bySymbol: Map<string, string>, since: number) => {
  const out = new Map<string, { longs: number; shorts: number }>()
  for (const r of rows) {
    const base = bySymbol.get(r.symbol)
    if (!base) continue
    const acc = out.get(base) ?? { longs: 0, shorts: 0 }
    for (const h of r.history ?? []) {
      if (h.t * 1000 < since) continue
      acc.longs += num(h.l) ?? 0
      acc.shorts += num(h.s) ?? 0
    }
    out.set(base, acc)
  }
  return out
}

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

const coinalyzePoll = (ctx: SourceContext, w: MetricWatcher) => {
  let markets: { at: number; list: CoinalyzeMarket[] } | null = null
  const key = () => encodeURIComponent(ctx.env.COINALYZE_API_KEY ?? "")
  return async (): Promise<RawItem[]> => {
    const now = ctx.now().getTime()
    if (!markets || now - markets.at > MARKETS_TTL_MS) markets = { at: now, list: (await ctx.fetch.json<CoinalyzeMarket[]>(`${COINALYZE_API}/future-markets?api_key=${key()}`, { conditional: false })) ?? [] }
    const universe = universeBases(ctx)
    const symbols = coinalyzeSymbols(markets.list, universe.keys())
    const bySymbol = new Map([...symbols].flatMap(([base, list]) => list.map((s) => [s, base] as const)))
    const batches = chunks([...bySymbol.keys()], BATCH)
    if (!batches.length) return []
    const from = Math.floor((now - 20 * 60_000) / 1000)
    const to = Math.floor(now / 1000)
    const results = await settleAll<{ funding?: CoinalyzeFunding[]; liquidations?: CoinalyzeLiquidations[] }>([
      ...batches.map((b) => async () => ({ funding: (await ctx.fetch.json<CoinalyzeFunding[]>(`${COINALYZE_API}/funding-rate?symbols=${b.join(",")}&api_key=${key()}`, { conditional: false })) ?? [] })),
      ...batches.map((b) => async () => ({ liquidations: (await ctx.fetch.json<CoinalyzeLiquidations[]>(`${COINALYZE_API}/liquidation-history?symbols=${b.join(",")}&interval=5min&from=${from}&to=${to}&convert_to_usd=true&api_key=${key()}`, { conditional: false })) ?? [] })),
    ])
    const funding = coinalyzeFunding(results.flatMap((r) => r?.funding ?? []), bySymbol)
    const liquidations = coinalyzeLiquidations(results.flatMap((r) => r?.liquidations ?? []), bySymbol, now - LIQUIDATION_WINDOW_MS)
    const venue: Venue = { id: "coinalyze", label: "Binance and Bybit (Coinalyze)", url: (symbol) => `https://coinalyze.net/${baseOf(symbol).toLowerCase()}/` }
    const items = perpItems(venue, [...funding].map(([base, pct]) => ({ symbol: universe.get(base)!, fundingAnnualPct: pct, openInterest: null, openInterestUsd: null })), w, ctx)
    for (const [base, liq] of liquidations) {
      const symbol = universe.get(base)!
      const threshold = LIQUIDATION_USD[base] ?? LIQUIDATION_DEFAULT_USD
      for (const side of ["longs", "shorts"] as const) {
        for (const c of w.observe(`coinalyze:liq_${side}:${symbol}`, liq[side], now, [{ id: "cascade", kind: "level", abs: threshold }])) {
          items.push({
            sourceId: crossingId(c),
            title: `${symbol}: ${usd(c.value)} of ${side} liquidated in 15 min on Binance and Bybit (Coinalyze)`,
            url: venue.url(symbol),
            symbols: [symbol],
            category: "liquidation_cascade",
            kind: "derivatives",
            // Longs being liquidated is forced selling; shorts, a squeeze.
            polarity: side === "longs" ? -1 : 1,
            publishedAt: new Date(now),
            meta: { ...crossingMeta(c), venue: "coinalyze", signal: "liquidations", side, threshold_usd: threshold },
          })
        }
      }
    }
    return items
  }
}

// ── Catalog entries ─────────────────────────────────────────────────────────

export const DERIVATIVES_SOURCES: SourceSpec[] = [
  {
    id: "kraken_futures",
    kind: "custom",
    url: "https://futures.kraken.com/derivatives/api/v3/tickers",
    interval_s: 60,
    tier: 1,
    wire_kind: "derivatives",
    default_enabled: true,
    note: "Kraken Futures public tickers: PF_ perp funding (hourly) and open interest",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<{ tickers?: KrakenFuturesTicker[] }>(spec.url!, { conditional: false })
        return body === null ? null : perpItems(KRAKEN_FUTURES, krakenFuturesReadings(body, universeBases(ctx)), w, ctx)
      }),
  },
  {
    id: "hyperliquid",
    kind: "custom",
    url: "https://api.hyperliquid.xyz/info",
    interval_s: 60,
    tier: 1,
    wire_kind: "derivatives",
    default_enabled: true,
    note: "Hyperliquid info API metaAndAssetCtxs: funding (hourly) and open interest for every perp",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => perpItems(HYPERLIQUID, hyperliquidReadings(await ctx.fetch.postJson<unknown>(spec.url!, { type: "metaAndAssetCtxs" }), universeBases(ctx)), w, ctx)),
  },
  {
    id: "deribit",
    kind: "custom",
    url: DERIBIT_API,
    interval_s: 60,
    tier: 1,
    wire_kind: "derivatives",
    default_enabled: true,
    note: "Deribit public API: DVOL (BTC, ETH) and perpetual funding",
    create: (spec, ctx) => metricSource(spec, ctx, (w) => deribitPoll(ctx, w)),
  },
  {
    id: "coinalyze",
    kind: "custom",
    url: COINALYZE_API,
    interval_s: 60,
    tier: 2,
    wire_kind: "derivatives",
    key_env: "COINALYZE_API_KEY",
    default_enabled: true,
    note: "Coinalyze (free key, ~40 calls/min): funding and 5-minute liquidations for Binance and Bybit USDT perps, 20 symbols per call (4 calls a minute)",
    create: (spec, ctx) => metricSource(spec, ctx, (w) => coinalyzePoll(ctx, w)),
  },
]
