import { correlation, logReturns } from "../market/indicators"

/**
 * Pairwise correlation of hourly log returns over the last 14 days. Used by the risk engine to
 * treat highly correlated holdings as one bet: five alts that all move with BTC are not five
 * diversified positions.
 */

const WINDOW = 14 * 24

export type CorrelationMatrix = Map<string, Map<string, number>>

export const correlationMatrix = (closesBySymbol: Map<string, number[]>): CorrelationMatrix => {
  const returns = new Map([...closesBySymbol].map(([s, c]) => [s, logReturns(c.slice(-(WINDOW + 1)))]))
  const matrix: CorrelationMatrix = new Map()
  const symbols = [...returns.keys()]
  for (const a of symbols) matrix.set(a, new Map([[a, 1]]))
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const c = correlation(returns.get(symbols[i])!, returns.get(symbols[j])!)
      if (c === null) continue
      matrix.get(symbols[i])!.set(symbols[j], c)
      matrix.get(symbols[j])!.set(symbols[i], c)
    }
  }
  return matrix
}

/**
 * Held symbols that move with `symbol` (correlation ≥ threshold). If correlation is unknown
 * (not enough data), the asset is assumed correlated: when in doubt, count it against the limit.
 */
export const correlatedWith = (symbol: string, held: string[], matrix: CorrelationMatrix, threshold: number) =>
  held.filter((h) => h !== symbol && (matrix.get(symbol)?.get(h) ?? 1) >= threshold)
