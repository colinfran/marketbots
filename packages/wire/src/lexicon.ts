import type { Lexicon } from "./types"

/**
 * The skeleton of a bot's lexicon (its language rules, in wire/lexicon.ts of each engine). The bot
 * supplies the rules: how to spot one of its symbols in a text, its category patterns (first match
 * wins, so the most specific come first), its negative and positive words, what counts as
 * market-wide and, optionally, a text-dependent base severity. This builds the rest the same way
 * for both: one cached matcher per symbol, the category fallback, and the polarity vote (only one
 * side matching gives a direction; both or neither is neutral).
 */

/** Escapes a literal for use inside a RegExp. */
export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export type LexiconRules<C extends string> = {
  /** Builds the test for one bot symbol; called once per symbol, then cached. */
  matcher: (symbol: string) => (text: string) => boolean
  /** Category patterns, most specific first. Nothing matching: the source's hint, else "general". */
  categories: readonly (readonly [C, RegExp])[]
  negative: RegExp
  positive: RegExp
  marketWide: Lexicon<C>["marketWide"]
  volumeAnomalyPoints: number
  baseSeverity?: Lexicon<C>["baseSeverity"]
}

export const makeLexicon = <C extends string>(r: LexiconRules<C>): Lexicon<C | "general"> => {
  const matchers = new Map<string, (text: string) => boolean>()
  const matcherFor = (symbol: string) => {
    const cached = matchers.get(symbol)
    if (cached) return cached
    const fn = r.matcher(symbol)
    matchers.set(symbol, fn)
    return fn
  }
  return {
    tag: (text, symbols) => symbols.filter((s) => matcherFor(s)(text)),
    classify: (text, hint) => r.categories.find(([, re]) => re.test(text))?.[0] ?? hint ?? "general",
    polarity: (text) => {
      const neg = r.negative.test(text)
      const pos = r.positive.test(text)
      return neg === pos ? 0 : neg ? -1 : 1
    },
    marketWide: r.marketWide,
    volumeAnomalyPoints: r.volumeAnomalyPoints,
    ...(r.baseSeverity ? { baseSeverity: r.baseSeverity } : {}),
  }
}
