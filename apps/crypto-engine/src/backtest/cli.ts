import { backtestParamsSchema } from "@mb/crypto-core/commands"
import { DEFAULT_SETTINGS } from "@mb/crypto-core/settings"
import { parsePairs } from "../venues/kraken/pairs"
import { KrakenRest } from "../venues/kraken/rest"
import { loadHistory } from "./run"
import { simulate } from "./simulate"

/**
 * Command-line backtest (no database needed):
 *   pnpm backtest -- --symbols BTC/USD,ETH/USD,SOL/USD --strategies trend,momentum --interval 240
 * Prints the summary metrics as JSON. Set BACKTEST_DATA_DIR to use Kraken OHLCVT CSV files.
 */

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const main = async () => {
  const params = backtestParamsSchema.parse({
    symbols: arg("symbols", "BTC/USD,ETH/USD,SOL/USD").split(","),
    strategies: arg("strategies", "trend,mean_reversion,momentum").split(","),
    interval: Number(arg("interval", "240")),
    starting_usd: Number(arg("capital", "10000")),
    slippage_bps: Number(arg("slippage", "5")),
    fee_bps: Number(arg("fee", "40")),
    in_sample_fraction: Number(arg("in-sample", "0.7")),
  })
  const rest = new KrakenRest()
  const pairs = parsePairs(await rest.assetPairs())
  const { series, sources } = await loadHistory(params.symbols, params.interval, rest, pairs, process.env.BACKTEST_DATA_DIR ?? null)
  const result = simulate(series, params, DEFAULT_SETTINGS)
  console.log(
    JSON.stringify(
      { params, sources, notes: result.notes, metrics: result.metrics, in_sample: result.in_sample, out_of_sample: result.out_of_sample, by_strategy: result.by_strategy, benchmarks: result.benchmarks },
      null,
      2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
