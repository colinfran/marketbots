import { boundedStop, candidateFeatures, clampScore, type CryptoStrategy } from "./types"

/**
 * Event driven: abnormal upside activity (a 24h move ≥ 2.5 typical daily moves, volume ≥ 2.5×
 * normal, or a 1h move ≥ 2 ATRs). Something happened; whether it's tradable depends entirely on
 * the AI finding and verifying the catalyst. Downside shocks in held assets trigger a position
 * review instead (spot is long-only).
 */
export const eventDrivenStrategy: CryptoStrategy = {
  id: "event_driven",
  screen: ({ features, settings }) =>
    features.flatMap((f) => {
      const z = f.move_zscore_24h ?? 0
      const volumeSpike = (f.volume_ratio_24h ?? 0) >= 2.5
      const hourShock = f.ret_1h_pct !== null && f.atr_pct_1h ? f.ret_1h_pct >= 2 * f.atr_pct_1h : false
      const up = (f.ret_24h_pct ?? 0) > 0
      if (!up || (z < 2.5 && !(volumeSpike && z > 1) && !hourShock)) return []
      const stop = boundedStop(f.price, 2 * (f.atr_1h ?? f.price * 0.015), settings)
      const reasons = [
        z >= 2.5 ? `24h move ${f.ret_24h_pct}% (z ${z})` : null,
        volumeSpike ? `volume ${f.volume_ratio_24h}× normal` : null,
        hourShock ? `1h move ${f.ret_1h_pct}%` : null,
      ].filter(Boolean)
      return [
        {
          instrument: f.symbol,
          symbol: f.symbol,
          strategy: "event_driven",
          score: clampScore(50 + z * 6 + (volumeSpike ? 10 : 0)),
          signal: `Abnormal activity: ${reasons.join(", ")}. Catalyst must be verified.`,
          features: candidateFeatures(f),
          stop_hint: stop,
          target_hint: f.price + 2.5 * (f.price - stop),
        },
      ]
    }),
}
