import { crossingId, crossingMeta, metricSource, type Crossing, type MetricRule, type MetricWatcher } from "../metrics"
import type { RawItem, SourceContext, SourceSpec } from "../types"
import { num, universeBases } from "./common"

/**
 * Network stress (MASTER_PLAN §4.1 wave 2, `chain`): Bitcoin fees from mempool.space and Ethereum
 * gas from Etherscan, each spiking to at least 5× its 24-hour median (and above a floor where fees
 * start to bite). Filed as `volume_shock` (on-chain activity far above normal) with a low base:
 * context for the dossier, never a trigger. Solana's status page and the client release feeds are
 * plain catalog entries.
 */

const SPIKE = { id: "spike", kind: "spike", windowMin: 24 * 60, ratio: 5, minSamples: 12 } as const
const BTC_RULE: MetricRule = { ...SPIKE, min: 20 }
const ETH_RULE: MetricRule = { ...SPIKE, min: 2 }

const stress = (symbol: string, c: Crossing, title: string, url: string): RawItem => ({
  sourceId: crossingId(c),
  title,
  url,
  symbols: [symbol],
  category: "volume_shock",
  kind: "venue",
  polarity: 0,
  baseSeverity: 20,
  publishedAt: new Date(c.at),
  meta: { ...crossingMeta(c), signal: "fees" },
})

/** mempool.space recommended fees (sat/vB) → a spike item for BTC. */
export const btcFeeItems = (body: { fastestFee?: number }, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  const symbol = universeBases(ctx).get("BTC")
  const fee = num(body.fastestFee)
  if (!symbol || fee === null) return []
  return w.observe("chain:btc_fee", fee, ctx.now().getTime(), [BTC_RULE]).map((c) => stress(symbol, c, `Bitcoin network fees at ${Math.round(c.value)} sat/vB, ${c.ratio!.toFixed(1)}× the 24-hour median (mempool.space)`, "https://mempool.space"))
}

type GasOracle = { status?: string; message?: string; result?: { ProposeGasPrice?: string } | string }

/** Etherscan gas oracle (gwei) → a spike item for ETH. */
export const ethGasItems = (body: GasOracle, w: MetricWatcher, ctx: SourceContext): RawItem[] => {
  // Etherscan answers 200 with status "0" for errors (rate limit, bad key).
  if (body.status !== "1" || typeof body.result !== "object") throw new Error(`etherscan: ${body.message ?? "error"}: ${String(typeof body.result === "string" ? body.result : "").slice(0, 120)}`)
  const symbol = universeBases(ctx).get("ETH")
  const gwei = num(body.result.ProposeGasPrice)
  if (!symbol || gwei === null) return []
  return w.observe("chain:eth_gas", gwei, ctx.now().getTime(), [ETH_RULE]).map((c) => stress(symbol, c, `Ethereum gas at ${c.value.toFixed(1)} gwei, ${c.ratio!.toFixed(1)}× the 24-hour median (Etherscan)`, "https://etherscan.io/gastracker"))
}

export const CHAIN_SOURCES: SourceSpec[] = [
  {
    id: "chain:btc_fees",
    kind: "custom",
    url: "https://mempool.space/api/v1/fees/recommended",
    interval_s: 300,
    tier: 1,
    wire_kind: "venue",
    default_enabled: true,
    note: "mempool.space recommended fees: spikes ≥ 5× the 24-hour median and ≥ 20 sat/vB",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<{ fastestFee?: number }>(spec.url!, { conditional: false })
        return body === null ? null : btcFeeItems(body, w, ctx)
      }),
  },
  {
    id: "chain:eth_gas",
    kind: "custom",
    url: "https://api.etherscan.io/v2/api?chainid=1&module=gastracker&action=gasoracle",
    interval_s: 300,
    tier: 1,
    wire_kind: "venue",
    key_env: "ETHERSCAN_API_KEY",
    default_enabled: true,
    note: "Etherscan gas oracle (free key): spikes ≥ 5× the 24-hour median and ≥ 2 gwei",
    create: (spec, ctx) =>
      metricSource(spec, ctx, (w) => async () => {
        const body = await ctx.fetch.json<GasOracle>(`${spec.url}&apikey=${encodeURIComponent(ctx.env.ETHERSCAN_API_KEY ?? "")}`, { conditional: false })
        return body === null ? null : ethGasItems(body, w, ctx)
      }),
  },
]
