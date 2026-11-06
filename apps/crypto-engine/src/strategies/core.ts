import { roundTo } from "@mb/crypto-core/math"
import type { Settings } from "@mb/crypto-core/settings"
import type { Features } from "../market/features"
import { boundedStop, candidateFeatures, clampScore, type CryptoCandidate } from "./types"

/**
 * The trend core's rules (docs/CRYPTO.md, "The trend core"): pure, like the screens, but they
 * trade by themselves instead of waking the agent.
 *
 *   regime  new entries only while BTC trades above its 50-day average;
 *   entry   a pair above a 50-day average that is above the 200-day, up over 30 days and not
 *           overbought (daily RSI under 80), ranked by its 30-day return per unit of daily
 *           volatility (30-day % ÷ daily ATR %);
 *   stop    `core.stop_atr` daily ATRs below, inside the allowed range; it then trails winners at
 *           that distance (the protection loop);
 *   exit    the trailing stop, or the trend breaking: below the 50-day average at the daily close.
 */

/** Daily RSI at or above this is too stretched to start a position. */
const MAX_RSI_1D = 80

/** Whether the core may open positions: BTC above its 50-day average. */
export const coreRegime = (btc: Features | undefined): { on: boolean; detail: string } => {
  if (!btc || btc.sma50_1d === null) return { on: false, detail: "BTC's 50-day average is unknown" }
  const vs = roundTo((btc.price / btc.sma50_1d - 1) * 100, 2)
  return { on: btc.price > btc.sma50_1d, detail: `BTC ${vs >= 0 ? "+" : ""}${vs}% vs its 50-day average` }
}

/** Every pair that qualifies for the core, strongest first, with its stop. */
export const coreCandidates = (features: Features[], settings: Settings): CryptoCandidate[] =>
  features
    .flatMap((f) => {
      const { sma50_1d: sma50, sma200_1d: sma200, atr_pct_1d: atrPct, ret_30d_pct: ret30 } = f
      if (sma50 === null || sma200 === null || atrPct === null || !(atrPct > 0) || ret30 === null) return []
      if (!(f.price > sma50 && sma50 > sma200) || ret30 <= 0 || (f.rsi14_1d ?? 50) >= MAX_RSI_1D) return []
      const strength = ret30 / atrPct
      const stop = boundedStop(f.price, settings.core.stop_atr * (atrPct / 100) * f.price, settings)
      const signal = `Trend core: ${roundTo((f.price / sma50 - 1) * 100, 1)}% above a 50-day average ${roundTo((sma50 / sma200 - 1) * 100, 1)}% over the 200-day; 30-day ${ret30}% at ${atrPct}% daily ATR (strength ${roundTo(strength, 2)})`
      const candidate: CryptoCandidate = {
        instrument: f.symbol,
        symbol: f.symbol,
        strategy: "core",
        score: clampScore(50 + strength * 5),
        signal,
        features: { ...candidateFeatures(f), strength: roundTo(strength, 3) },
        stop_hint: stop,
        // No target: the trend runs until the trailing stop or the 50-day average ends it. Recorded for the decision only.
        target_hint: f.price + 3 * (f.price - stop),
      }
      return [{ candidate, strength }]
    })
    .sort((a, b) => b.strength - a.strength)
    .map((x) => x.candidate)

/** A core position's trend broke: the price below its 50-day average (checked at the daily close). */
export const coreTrendBroken = (f: Pick<Features, "price" | "sma50_1d">) => f.sma50_1d !== null && f.price < f.sma50_1d
