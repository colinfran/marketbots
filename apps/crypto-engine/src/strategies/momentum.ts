import { boundedStop, candidateFeatures, clampScore, type CryptoStrategy } from "./types"

/**
 * Relative strength: rank the universe by volatility-adjusted returns (7d plus half of 30d,
 * divided by the daily ATR %) and propose the top two leaders with positive 7d and 30d returns
 * and an intact 4h uptrend. Skipped in risk-off regimes, where leadership tends to collapse.
 */
export const momentumStrategy: CryptoStrategy = {
  id: "momentum",
  screen: ({ features, regime, settings }) => {
    if (regime.label === "risk_off_trend") return []
    const ranked = features
      .map((f) => {
        const vol = f.atr_pct_1d ?? null
        const raw = (f.ret_7d_pct ?? 0) + (f.ret_30d_pct ?? 0) / 2
        return { f, strength: vol && vol > 0 ? raw / vol : null }
      })
      .filter((r): r is { f: (typeof features)[number]; strength: number } => r.strength !== null)
      .sort((a, b) => b.strength - a.strength)
    return ranked.slice(0, 2).flatMap(({ f, strength }, rank) => {
      if ((f.ret_7d_pct ?? 0) <= 0 || (f.ret_30d_pct ?? 0) <= 0 || f.trend_4h !== "up") return []
      const atr4h = ((f.atr_pct_4h ?? 2) / 100) * f.price
      const stop = boundedStop(f.price, 2.5 * atr4h, settings)
      return [
        {
          instrument: f.symbol,
          symbol: f.symbol,
          strategy: "momentum",
          score: clampScore(55 + strength * 4 - rank * 5),
          signal: `Relative-strength leader #${rank + 1}: 7d ${f.ret_7d_pct}%, 30d ${f.ret_30d_pct}% (vol-adjusted ${strength.toFixed(2)})`,
          features: candidateFeatures(f),
          stop_hint: stop,
          target_hint: f.price + 2 * (f.price - stop),
        },
      ]
    })
  },
}
