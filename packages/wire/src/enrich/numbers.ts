/**
 * The number check (PHASE10_SPIKE "Plan changes" 3): every number in a machine summary must occur
 * in the article it summarizes. It catches invented or computed totals ("around $600 million") and
 * corrupted numbers ("2:026"). It can't catch a number the article does have but the summary pins on
 * the wrong thing (C$10M for "serious" instead of "very serious" violations); that is why summaries
 * are shown as machine summaries, with the article's link.
 *
 * Numbers compare by value once thousands separators are gone ("1,200" = "1200", "2.0" = "2"), so
 * units and signs ($, %, "million") don't matter. A zero-padded number keeps its digits ("026").
 */

/** Any number in the article, separators allowed. */
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g

/** A number in the summary: not inside a word or code (Web3, B2B, G7), optionally a quarter or half (Q3, H1). */
const SUMMARY_NUMBER = /(?<![\p{L}\d.,])([QH])?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/giu

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]
const ORDINALS = ["first", "second", "third", "fourth"]

const QUARTER = /\b(?:q([1-4])|([1-4])q|(first|second|third|fourth)[- ]quarter)\b/gi
const HALF = /\b(?:h([12])|(first|second)[- ]half)\b/gi

const canonical = (raw: string) => {
  const plain = raw.replace(/,/g, "")
  return /^0\d/.test(plain) ? plain : String(Number(plain))
}

/** What the article offers to match against: its numbers (also written as words up to twelve), quarters and halves. */
export const articleFacts = (text: string) => {
  const numbers = new Set<string>()
  for (const m of text.matchAll(NUMBER)) {
    numbers.add(m[0].replace(/,/g, ""))
    numbers.add(canonical(m[0]))
  }
  const lower = text.toLowerCase()
  WORDS.forEach((w, n) => {
    if (new RegExp(`\\b${w}\\b`).test(lower)) numbers.add(String(n))
  })
  const periods = new Set<string>()
  for (const m of text.matchAll(QUARTER)) periods.add(`Q${m[1] ?? m[2] ?? ORDINALS.indexOf(m[3].toLowerCase()) + 1}`)
  for (const m of text.matchAll(HALF)) periods.add(`H${m[1] ?? ORDINALS.indexOf(m[2].toLowerCase()) + 1}`)
  return { numbers, periods }
}

/** The numbers in `texts` (as written) that the article doesn't contain; empty when all check out. */
export const unmatchedNumbers = (texts: string[], article: string): string[] => {
  const facts = articleFacts(article)
  const missing = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(SUMMARY_NUMBER)) {
      const period = m[1] ? `${m[1].toUpperCase()}${m[2]}` : null
      if (period && facts.periods.has(period)) continue
      if (facts.numbers.has(canonical(m[2]))) continue
      missing.add(m[0])
    }
  }
  return [...missing]
}
