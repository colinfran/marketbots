import { boundedStop, candidateFeatures, clampScore, type CryptoStrategy } from "./types"

/**
 * Long-term trend: the 50-day average above the 200-day and price above the 200-day, bought either
 * above the 50-day while not overbought (continuation) or on a pullback to within 1.5 ATR(1d)
 * below it. Stops sit 2.5 ATR(1d) below; the target is 3R. Positions are held for weeks to months
 * and reviewed on daily scales.
 */
export const dailyTrendStrategy: CryptoStrategy = {
  id: "daily_trend",
  screen: ({ features, regime, settings }) => {
    if (regime.label === "risk_off_trend" || regime.label === "high_volatility") return []
    return features.flatMap((f) => {
      const { sma50_1d: sma50, sma200_1d: sma200, atr_pct_1d: atrPct } = f
      if (sma50 === null || sma200 === null || atrPct === null) return []
      if (sma50 <= sma200 || f.price <= sma200) return []
      const atr = (atrPct / 100) * f.price
      const rsi = f.rsi14_1d ?? 50
      const fromSma50 = f.price - sma50
      const continuation = fromSma50 >= 0 && fromSma50 <= 3 * atr && rsi <= 70
      const pullback = fromSma50 < 0 && fromSma50 >= -1.5 * atr && rsi >= 30
      if (!continuation && !pullback) return []
      const stop = boundedStop(f.price, 2.5 * atr, settings)
      const trendGapPct = ((sma50 - sma200) / sma200) * 100
      const score = clampScore(50 + Math.min(15, trendGapPct) + (continuation ? 10 : 5) - Math.max(0, rsi - 65) * 2)
      const vs50 = `${Math.abs((f.price / sma50 - 1) * 100).toFixed(1)}% ${continuation ? "above" : "below"} the 50-day`
      const signal = `${continuation ? "Long-term uptrend" : "Pullback in a long-term uptrend"}: ${vs50}, 50-day ${trendGapPct.toFixed(1)}% over the 200-day; RSI(1d) ${rsi}`
      return [
        {
          instrument: f.symbol,
          symbol: f.symbol,
          strategy: "daily_trend",
          score,
          signal,
          features: candidateFeatures(f),
          stop_hint: stop,
          target_hint: f.price + 3 * (f.price - stop),
        },
      ]
    })
  },
}
