import { crossingId, crossingMeta, metricSource, type MetricRule, type MetricWatcher } from "@mb/wire/metrics"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { num, universeBases, usd } from "./common"

/**
 * DefiLlama's free endpoints:
 *
 *   defillama          chain TVL (`/v2/chains`): a chain losing ≥ `tvl_drop_pct` within an hour is
 *                      how an exploit often shows up first → `tvl_drop`, which the policy turns
 *                      into an exploit-signal review of a held asset (never an entry).
 *   defillama:stables  USDT and USDC supply: a ≥ $1B change over 24 h (mints flowing in, burns
 *                      flowing out) is a low-severity market-wide item.
 *
 * Chains map to universe assets by their gas token (Ethereum → ETH, Solana → SOL, Avalanche →
 * AVAX…). A chain with no universe asset is not tagged to one: only the big ones are watched, as
 * market-wide items. TVL is in dollars, so a crash of the chain's own token also lowers it; at
 * 15% within an hour that is rare, and a review of what we hold is the right reaction either way.
 */

/** Chains whose asset is in the universe are watched from this TVL… */
const UNIVERSE_CHAIN_MIN_TVL = 25e6
/** …other chains only when they are this big. */
const OTHER_CHAIN_MIN_TVL = 1e9
const STABLES = ["USDT", "USDC"]
const STABLE_CHANGE_USD = 1e9

type Chain = { name: string; tvl: number; tokenSymbol: string | null }
type Pegged = { symbol: string; name: string; circulating?: { peggedUSD?: number }; circulatingPrevDay?: { peggedUSD?: number } }

/** Chain TVL readings: the universe symbol the chain belongs to, if any. */
export const chainReadings = (chains: Chain[], universe: Map<string, string>) =>
  chains.flatMap((c) => {
    const tvl = num(c.tvl)
    const symbol = c.tokenSymbol ? (universe.get(c.tokenSymbol.toUpperCase()) ?? null) : null
    if (tvl === null || tvl < (symbol ? UNIVERSE_CHAIN_MIN_TVL : OTHER_CHAIN_MIN_TVL)) return []
    return [{ chain: c.name, symbol, tvl }]
  })

export const tvlItems = (chains: Chain[], w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const rule: MetricRule = { id: "drop", kind: "change", windowMin: 60, pct: ctx.settings().tvl_drop_pct, direction: "down" }
  const items: RawItem[] = []
  for (const r of chainReadings(chains, universeBases(ctx))) {
    for (const c of w.observe(`defillama:tvl:${r.chain}`, r.tvl, at, [rule])) {
      items.push({
        sourceId: crossingId(c),
        title: `${r.chain} TVL down ${Math.abs(c.pct!).toFixed(0)}% in ${c.windowMin} min to ${usd(c.value)} (DefiLlama)`,
        url: `https://defillama.com/chain/${encodeURIComponent(r.chain)}`,
        symbols: r.symbol ? [r.symbol] : [],
        marketWide: !r.symbol,
        category: "tvl_drop",
        polarity: -1,
        publishedAt: new Date(at),
        meta: { ...crossingMeta(c), chain: r.chain },
      })
    }
  }
  return items
}

/** USDT and USDC: supply now and its change over DefiLlama's last day. */
export const stableReadings = (body: { peggedAssets?: Pegged[] }) =>
  (body.peggedAssets ?? []).flatMap((p) => {
    const now = num(p.circulating?.peggedUSD)
    const prev = num(p.circulatingPrevDay?.peggedUSD)
    return STABLES.includes(p.symbol) && now !== null && prev !== null ? [{ symbol: p.symbol, supply: now, change: now - prev }] : []
  })

export const stableItems = (body: { peggedAssets?: Pegged[] }, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const at = ctx.now().getTime()
  const items: RawItem[] = []
  for (const r of stableReadings(body)) {
    for (const c of w.observe(`defillama:supply24h:${r.symbol}`, r.change, at, [{ id: "flow", kind: "level", abs: STABLE_CHANGE_USD }])) {
      items.push({
        sourceId: crossingId(c),
        title: `${r.symbol} supply ${c.value > 0 ? "up" : "down"} ${usd(Math.abs(c.value))} in 24 h to ${usd(r.supply)} (DefiLlama)`,
        url: "https://defillama.com/stablecoins",
        symbols: [],
        marketWide: true,
        category: "general",
        // Context, not news: low enough that it never triggers anything.
        baseSeverity: 25,
        polarity: c.value > 0 ? 1 : -1,
        publishedAt: new Date(at),
        meta: { ...crossingMeta(c), stablecoin: r.symbol, supply_usd: Math.round(r.supply), change_pct: Math.round((c.value / (r.supply - c.value)) * 10_000) / 100 },
      })
    }
  }
  return items
}

export const DEFILLAMA_SOURCES: SourceSpec[] = [
  {
    id: "defillama",
    kind: "custom",
    url: "https://api.llama.fi/v2/chains",
    interval_s: 300,
    tier: 1,
    default_enabled: true,
    note: "DefiLlama chain TVL: a drop ≥ tvl_drop_pct within an hour (exploit signal)",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const chains = await ctx.fetch.json<Chain[]>(spec.url!)
        return chains === null ? null : tvlItems(chains, w, ctx)
      }),
  },
  {
    id: "defillama:stables",
    kind: "custom",
    url: "https://stablecoins.llama.fi/stablecoins?includePrices=false",
    // A daily figure in a payload of several MB: every 30 minutes is plenty.
    interval_s: 1_800,
    tier: 1,
    default_enabled: true,
    note: "DefiLlama stablecoins: USDT/USDC supply change over 24 h",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<{ peggedAssets?: Pegged[] }>(spec.url!)
        return body === null ? null : stableItems(body, w, ctx)
      }),
  },
]
