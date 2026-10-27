import { dailyTrendStrategy } from "./daily-trend"
import { eventDrivenStrategy } from "./event-driven"
import { meanReversionStrategy } from "./mean-reversion"
import { momentumStrategy } from "./momentum"
import { trendStrategy } from "./trend"
import type { CryptoCandidate, CryptoStrategy, StrategyContext } from "./types"

export const CRYPTO_STRATEGIES: CryptoStrategy[] = [trendStrategy, dailyTrendStrategy, meanReversionStrategy, momentumStrategy, eventDrivenStrategy]

/**
 * Runs every enabled crypto strategy and merges the results: one candidate per symbol (the
 * highest-scoring signal wins, the others are noted), held symbols excluded (they get reviewed,
 * not re-entered), ranked by score.
 */
export const screenCrypto = (ctx: StrategyContext): CryptoCandidate[] => {
  const bySymbol = new Map<string, CryptoCandidate>()
  for (const strategy of CRYPTO_STRATEGIES) {
    if (!ctx.settings.strategies[strategy.id].enabled) continue
    for (const candidate of strategy.screen(ctx)) {
      if (ctx.held.has(candidate.symbol)) continue
      const existing = bySymbol.get(candidate.symbol)
      if (!existing) bySymbol.set(candidate.symbol, candidate)
      else if (candidate.score > existing.score) {
        bySymbol.set(candidate.symbol, { ...candidate, signal: `${candidate.signal} (also: ${existing.strategy})` })
      } else {
        existing.signal = `${existing.signal} (also: ${candidate.strategy})`
      }
    }
  }
  return [...bySymbol.values()].sort((a, b) => b.score - a.score)
}
