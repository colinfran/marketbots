import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { BacktestParams } from "@mb/crypto-core/commands"
import type { BacktestDoc } from "@mb/crypto-core/db"
import type { Settings } from "@mb/crypto-core/settings"
import { errorMessage } from "@mb/engine-kit/log"
import type { Collections } from "../db/mongo"
import type { PairInfo } from "../venues/kraken/pairs"
import type { Candle, KrakenRest, OhlcInterval } from "../venues/kraken/rest"
import { simulate } from "./simulate"

/**
 * Loads history and runs a backtest. Data comes from Kraken's public OHLC endpoint (720 candles
 * per interval), or, when present, from Kraken's downloadable OHLCVT CSV files placed at
 * `<BACKTEST_DATA_DIR>/<BASE><QUOTE>_<interval>.csv` (e.g. XBTUSD_60.csv) for longer history.
 * CSV rows: unix_time,open,high,low,close,volume,trades.
 */

export const parseOhlcvtCsv = (text: string): Candle[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.split(","))
    .filter((p) => p.length >= 6 && /^\d+$/.test(p[0]))
    .map((p) => {
      const close = Number(p[4])
      return { t: Number(p[0]) * 1000, open: Number(p[1]), high: Number(p[2]), low: Number(p[3]), close, vwap: close, volume: Number(p[5]), trades: Number(p[6] ?? 0) }
    })
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite))
    .sort((a, b) => a.t - b.t)

export const loadHistory = async (
  symbols: string[],
  interval: OhlcInterval,
  rest: Pick<KrakenRest, "ohlc">,
  pairs: Map<string, PairInfo>,
  dataDir: string | null,
): Promise<{ series: Map<string, Candle[]>; sources: string[] }> => {
  const series = new Map<string, Candle[]>()
  const sources: string[] = []
  // BTC always loads: it drives the regime classification.
  for (const symbol of [...new Set(["BTC/USD", ...symbols])]) {
    const pair = pairs.get(symbol)
    if (!pair) continue
    const csv = dataDir ? [pair.altname, symbol.replace("/", "")].map((n) => join(dataDir, `${n}_${interval}.csv`)).find(existsSync) : undefined
    if (csv) {
      series.set(symbol, parseOhlcvtCsv(readFileSync(csv, "utf8")))
      sources.push(`${symbol}: ${csv}`)
    } else {
      series.set(symbol, await rest.ohlc(pair.restPair, interval))
      sources.push(`${symbol}: Kraken REST (last 720 candles)`)
    }
  }
  return { series, sources }
}

export const runBacktest = async (deps: {
  col: Pick<Collections, "backtests">
  rest: Pick<KrakenRest, "ohlc">
  pairs: Map<string, PairInfo>
  settings: Settings
  dataDir: string | null
  params: BacktestParams
  id?: string
}): Promise<BacktestDoc> => {
  const doc: BacktestDoc = {
    _id: deps.id ?? randomUUID(),
    created_at: new Date(),
    finished_at: null,
    status: "running",
    params: deps.params,
    metrics: null,
    in_sample: null,
    out_of_sample: null,
    by_strategy: {},
    by_symbol: {},
    by_regime: {},
    benchmarks: { buy_hold_btc_pct: null, equal_weight_pct: null },
    equity_curve: [],
    trades: [],
    notes: [],
    error: null,
  }
  await deps.col.backtests.insertOne(doc)
  try {
    const { series, sources } = await loadHistory(deps.params.symbols, deps.params.interval, deps.rest, deps.pairs, deps.dataDir)
    // BTC is always loaded for the regime; simulate only trades the selected symbols.
    const result = simulate(series, deps.params, deps.settings)
    const final: BacktestDoc = { ...doc, ...result, notes: [...result.notes, ...sources], status: "completed", finished_at: new Date() }
    if (!deps.params.symbols.includes("BTC/USD")) final.notes.push("BTC/USD was loaded for the regime only.")
    await deps.col.backtests.replaceOne({ _id: doc._id }, final)
    return final
  } catch (error) {
    const failed: BacktestDoc = { ...doc, status: "failed", error: errorMessage(error), finished_at: new Date() }
    await deps.col.backtests.replaceOne({ _id: doc._id }, failed)
    return failed
  }
}
