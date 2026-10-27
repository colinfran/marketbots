import { boundedStop, candidateFeatures, clampScore, type CryptoStrategy } from "./types"

/**
 * Mean reversion: an unusually sharp drop (24h move ≥ 1.5 typical daily moves) that pushed price
 * below the lower 1h Bollinger band with RSI(1h) < 30, in an asset whose daily trend isn't down.
 * The target is the 1h EMA20 (the "mean"); the stop is 1.5 ATR(4h) below.
 */
export const meanReversionStrategy: CryptoStrategy = {
  id: "mean_reversion",
  screen: ({ features, settings }) =>
    features.flatMap((f) => {
      const rsi = f.rsi14_1h
      if (rsi === null || rsi >= 30 || f.bb_pct_b_1h === null || f.bb_pct_b_1h > 0.05) return []
      if (f.trend_1d === "down" || (f.move_zscore_24h ?? 0) > -1.5 || f.ema20_1h === null) return []
      const atr4h = ((f.atr_pct_4h ?? 1.5) / 100) * f.price
      const stop = boundedStop(f.price, 1.5 * atr4h, settings)
      const target = Math.max(f.ema20_1h, f.price + 1.2 * (f.price - stop))
      const score = clampScore(45 + (30 - rsi) * 1.5 + Math.min(20, Math.abs(f.move_zscore_24h ?? 0) * 5))
      return [
        {
          instrument: f.symbol,
          symbol: f.symbol,
          strategy: "mean_reversion",
          score,
          signal: `Oversold: RSI(1h) ${rsi}, below lower band, 24h move ${f.ret_24h_pct}% (z ${f.move_zscore_24h})`,
          features: candidateFeatures(f),
          stop_hint: stop,
          target_hint: target,
        },
      ]
    }),
}
