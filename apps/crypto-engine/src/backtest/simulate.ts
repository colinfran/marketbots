import type { BacktestParams } from "@mb/crypto-core/commands"
import type { BacktestDoc, BacktestTrade, RegimeSnapshot } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { performanceMetrics, tradeStats, type EquityPoint } from "@mb/crypto-core/metrics"
import { applySettingsPatch, type Settings } from "@mb/crypto-core/settings"
import type { StrategyId } from "@mb/crypto-core/strategies"
import { classifyRegime, computeFeatures, type Features } from "../market/features"
import type { Quote } from "../market/hub"
import { cryptoSize } from "../risk/sizing"
import { screenCrypto } from "../strategies/registry"
import type { Candle } from "../venues/kraken/rest"

/**
 * Bar-by-bar backtest of the deterministic strategy layer (the no-AI baseline).
 *
 * Why no AI: an LLM asked to "decide" on historical bars has very likely seen what happened next
 * in its training data, so its backtested decisions would be look-ahead, not skill. The AI is
 * evaluated forward instead, on paper trades and scored decision outcomes, against this baseline.
 *
 * No look-ahead in the simulation either:
 * - features at bar t use only candles that closed at or before t;
 * - an entry decided at bar t fills at bar t+1's open, plus slippage and fees;
 * - stops and targets are checked on later bars; if a bar gaps through a level, the fill is the
 *   open, and if both levels sit inside one bar, the stop is assumed to hit first;
 * - positions also exit after a 72-hour time stop.
 *
 * Kraken's REST API serves 720 candles per interval, so "fast" features use the chosen interval,
 * "mid" features a 4× aggregation and "slow" features daily bars built from the same series.
 */

const HOUR = 3_600_000
const TIME_STOP_HOURS = 72

export const aggregate = (candles: Candle[], factor: number): Candle[] => {
  if (factor <= 1) return candles
  const out: Candle[] = []
  for (let i = 0; i + factor <= candles.length; i += factor) {
    const g = candles.slice(i, i + factor)
    const volume = g.reduce((s, c) => s + c.volume, 0)
    out.push({
      t: g[0].t,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
      vwap: volume > 0 ? g.reduce((s, c) => s + c.vwap * c.volume, 0) / volume : g[g.length - 1].close,
      volume,
      trades: g.reduce((s, c) => s + c.trades, 0),
    })
  }
  return out
}

type Open = { symbol: string; strategy: StrategyId; qty: number; entry: number; entryAt: number; stop: number; target: number; cost: number; regime: string }

export type SimulationResult = Pick<BacktestDoc, "metrics" | "in_sample" | "out_of_sample" | "by_strategy" | "by_symbol" | "by_regime" | "benchmarks" | "equity_curve" | "trades" | "notes">

export const simulate = (series: Map<string, Candle[]>, params: BacktestParams, baseSettings: Settings): SimulationResult => {
  // Only the selected strategies run (daily_trend never does: its multi-week holds don't fit the 72h time stop).
  const patch = Object.fromEntries(
    (["trend", "daily_trend", "mean_reversion", "momentum", "event_driven"] as const).map((id) => [id, { enabled: (params.strategies as string[]).includes(id) }]),
  )
  const patched = applySettingsPatch(baseSettings, { strategies: patch })
  const settings = patched.ok ? patched.settings : baseSettings
  const intervalMs = params.interval * 60_000
  const midFactor = 4
  const dayFactor = Math.max(1, Math.round(1440 / params.interval))
  const slip = params.slippage_bps / 10_000
  const fee = params.fee_bps / 10_000
  const notes: string[] = [
    `Strategy screens on ${params.interval}-minute bars (fast), ${params.interval * midFactor}-minute aggregates (mid) and daily aggregates (slow).`,
    "Deterministic strategies only (no AI). Entries fill at the next bar's open; fees and slippage on both legs; 72h time stop.",
  ]

  // Align all symbols on a common timeline.
  const symbols = [...series.keys()]
  const times = [...new Set(symbols.flatMap((s) => series.get(s)!.map((c) => c.t)))].sort((a, b) => a - b)
  const index = new Map(symbols.map((s) => [s, new Map(series.get(s)!.map((c, i) => [c.t, i]))]))
  // Warm-up: the slow (daily) features need 30+ days.
  const warmup = Math.max(60, dayFactor * 31)
  if (times.length <= warmup + 10) {
    return {
      metrics: null,
      in_sample: null,
      out_of_sample: null,
      by_strategy: {},
      by_symbol: {},
      by_regime: {},
      benchmarks: { buy_hold_btc_pct: null, equal_weight_pct: null },
      equity_curve: [],
      trades: [],
      notes: [...notes, `Not enough history: ${times.length} bars, need more than ${warmup + 10}. Use a longer interval or CSV data.`],
    }
  }

  let cash = params.starting_usd
  const open: Open[] = []
  const pending: { symbol: string; strategy: StrategyId; stop: number; target: number; regime: string }[] = []
  const trades: BacktestTrade[] = []
  const curve: EquityPoint[] = []
  let exposureBars = 0
  let tradedNotional = 0

  const candleAt = (symbol: string, t: number) => {
    const i = index.get(symbol)!.get(t)
    return i === undefined ? null : series.get(symbol)![i]
  }
  // Aggregates are built once; at bar i only groups that closed by bar i are used (no look-ahead).
  const mid = new Map(symbols.map((s) => [s, aggregate(series.get(s)!, midFactor)]))
  const day = new Map(symbols.map((s) => [s, aggregate(series.get(s)!, dayFactor)]))

  for (let ti = warmup; ti < times.length; ti++) {
    const t = times[ti]
    // 1. Fill entries decided on the previous bar, at this bar's open.
    for (const p of pending.splice(0)) {
      const c = candleAt(p.symbol, t)
      if (!c || open.some((o) => o.symbol === p.symbol)) continue
      const equity = cash + open.reduce((s, o) => s + o.qty * (candleAt(o.symbol, t)?.open ?? o.entry), 0)
      const price = c.open * (1 + slip)
      // Keep the stop distance the screen intended, measured from the actual fill.
      const stop = Math.min(p.stop, price * (1 - settings.kraken.min_stop_pct / 100))
      const size = cryptoSize({ equity, price, stop, riskPct: settings.kraken.risk_per_trade_pct, maxPositionPct: settings.kraken.max_position_pct, sizePctOfMax: 100 })
      const exposure = open.reduce((s, o) => s + o.qty * c.open, 0)
      const room = Math.max(0, (equity * settings.kraken.max_total_exposure_pct) / 100 - exposure)
      const notional = Math.min(size.notional, room, cash / (1 + fee))
      if (notional < 10 || open.length >= settings.kraken.max_concurrent_positions) continue
      const qty = notional / price
      cash -= notional * (1 + fee)
      tradedNotional += notional
      open.push({ symbol: p.symbol, strategy: p.strategy, qty, entry: price, entryAt: t, stop, target: p.target, cost: notional * (1 + fee), regime: p.regime })
    }

    // 2. Exits: stops, targets, time stop.
    for (const o of [...open]) {
      const c = candleAt(o.symbol, t)
      if (!c) continue
      let exit: number | null = null
      let reason = ""
      if (c.open <= o.stop) [exit, reason] = [c.open, "stop_loss"]
      else if (c.open >= o.target) [exit, reason] = [c.open, "take_profit"]
      else if (c.low <= o.stop) [exit, reason] = [o.stop, "stop_loss"]
      else if (c.high >= o.target) [exit, reason] = [o.target, "take_profit"]
      else if (t + intervalMs - o.entryAt >= TIME_STOP_HOURS * HOUR) [exit, reason] = [c.close, "time_stop"]
      if (exit === null) continue
      const price = exit * (1 - slip)
      const proceeds = o.qty * price * (1 - fee)
      cash += proceeds
      tradedNotional += o.qty * price
      open.splice(open.indexOf(o), 1)
      trades.push({
        symbol: o.symbol,
        strategy: o.strategy,
        entry_at: new Date(o.entryAt),
        exit_at: new Date(t),
        entry_price: roundTo(o.entry, 6),
        exit_price: roundTo(price, 6),
        qty: o.qty,
        pnl_usd: roundTo(proceeds - o.cost, 2),
        return_pct: roundTo((proceeds / o.cost - 1) * 100, 3),
        exit_reason: reason,
        regime: o.regime,
      })
    }

    // 3. Mark to market at the close.
    const equity = cash + open.reduce((s, o) => s + o.qty * (candleAt(o.symbol, t)?.close ?? o.entry), 0)
    curve.push({ t, equity })
    if (open.length) exposureBars += 1

    // 4. Screens at this bar's close → entries for the next bar.
    const features: Features[] = []
    for (const symbol of symbols) {
      const i = index.get(symbol)!.get(t)
      if (i === undefined) continue
      const all = series.get(symbol)!
      const c = all[i]
      const midDone = Math.floor((i + 1) / midFactor)
      const dayDone = Math.floor((i + 1) / dayFactor)
      const quote: Quote = { symbol, bid: c.close, ask: c.close, mid: c.close, spreadBps: 0, last: c.close, changePct: null, at: t, ageS: 0, source: "rest", book: null }
      const f = computeFeatures(
        symbol,
        { h1: all.slice(Math.max(0, i - 719), i + 1), h4: mid.get(symbol)!.slice(Math.max(0, midDone - 300), midDone), d1: day.get(symbol)!.slice(Math.max(0, dayDone - 400), dayDone) },
        quote,
      )
      if (f) features.push(f)
    }
    if (!features.length) continue
    const regime: RegimeSnapshot = classifyRegime(features)
    const held = new Set(open.map((o) => o.symbol))
    const tradable = screenCrypto({ regime, features, held, settings }).filter((c) => params.symbols.includes(c.symbol))
    for (const cand of tradable.slice(0, settings.ai.max_candidates_per_cycle)) {
      pending.push({ symbol: cand.symbol, strategy: cand.strategy, stop: cand.stop_hint, target: cand.target_hint, regime: regime.label })
    }
  }

  const split = Math.floor(curve.length * params.in_sample_fraction)
  const splitT = curve[split]?.t ?? Number.POSITIVE_INFINITY
  const asResults = (list: BacktestTrade[]) => list.map((t) => ({ pnl_usd: t.pnl_usd, return_pct: t.return_pct }))
  const group = (key: (t: BacktestTrade) => string) => {
    const groups = new Map<string, BacktestTrade[]>()
    for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t])
    return Object.fromEntries([...groups].map(([k, v]) => [k, tradeStats(asResults(v))]))
  }
  const firstLast = (symbol: string) => {
    const c = series.get(symbol)
    const first = c?.find((x) => x.t >= times[warmup])
    const last = c?.at(-1)
    return first && last ? (last.close / first.close - 1) * 100 : null
  }
  const ew = params.symbols.filter((s) => series.has(s)).map(firstLast).filter((v): v is number => v !== null)
  // Keep stored curves small: at most ~500 points.
  const stride = Math.max(1, Math.ceil(curve.length / 500))
  return {
    metrics: performanceMetrics(curve, asResults(trades), { exposure_pct: curve.length ? roundTo((exposureBars / curve.length) * 100, 1) : null, traded_notional_usd: tradedNotional }),
    in_sample: performanceMetrics(curve.slice(0, split + 1), asResults(trades.filter((t) => t.exit_at.getTime() < splitT))),
    out_of_sample: performanceMetrics(curve.slice(split), asResults(trades.filter((t) => t.exit_at.getTime() >= splitT))),
    by_strategy: group((t) => t.strategy),
    by_symbol: group((t) => t.symbol),
    by_regime: group((t) => t.regime),
    benchmarks: {
      buy_hold_btc_pct: series.has("BTC/USD") ? (firstLast("BTC/USD") === null ? null : roundTo(firstLast("BTC/USD")!, 2)) : null,
      equal_weight_pct: ew.length ? roundTo(ew.reduce((a, b) => a + b, 0) / ew.length, 2) : null,
    },
    equity_curve: curve.filter((_, i) => i % stride === 0 || i === curve.length - 1).map((p) => ({ t: p.t, equity: roundTo(p.equity, 2) })),
    trades: trades.slice(-500),
    notes,
  }
}
