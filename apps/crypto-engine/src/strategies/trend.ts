import { boundedStop, candidateFeatures, clampScore, type CryptoStrategy } from "./types"

/**
 * Trend following: 4h uptrend, daily trend not down, price above the 1h EMA20, and either a fresh
 * breakout above the 20×4h high or a healthy (not overbought) continuation. Stops sit ~2 ATR(1h)
 * below; the target is 2.5R.
 */
export const trendStrategy: CryptoStrategy = {
  id: "trend",
  screen: ({ features, regime, settings }) => {
    if (regime.label === "risk_off_trend") return []
    return features.flatMap((f) => {
      if (f.trend_4h !== "up" || f.trend_1d === "down" || f.ema20_1h === null || f.price <= f.ema20_1h) return []
      const rsi = f.rsi14_1h ?? 50
      const continuation = (f.ret_24h_pct ?? 0) > 0 && rsi >= 50 && rsi <= 72
      if (!f.breakout_4h && !continuation) return []
      const stop = boundedStop(f.price, 2 * (f.atr_1h ?? f.price * 0.01), settings)
      const score = clampScore(50 + Math.min(20, Math.max(-10, f.ret_7d_pct ?? 0)) + (f.breakout_4h ? 15 : 0) - Math.max(0, rsi - 70) * 2)
      const signal = f.breakout_4h
        ? `4h uptrend; breakout above the 20×4h high ${f.high_20x4h}; RSI(1h) ${rsi}`
        : `4h uptrend continuation; +${f.ret_24h_pct}% 24h; RSI(1h) ${rsi}`
      return [
        {
          instrument: f.symbol,
          symbol: f.symbol,
          strategy: "trend",
          score,
          signal,
          features: candidateFeatures(f),
          stop_hint: stop,
          target_hint: f.price + 2.5 * (f.price - stop),
        },
      ]
    })
  },
}
