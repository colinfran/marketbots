import { describe, expect, it, vi } from "vitest"
import { escapeRegExp, makeLexicon } from "../src/lexicon"

describe("lexicon skeleton", () => {
  it("builds one matcher per symbol, falls back to the hint then general, and votes on polarity", () => {
    expect(escapeRegExp("BRK.B (x+y)?")).toBe("BRK\\.B \\(x\\+y\\)\\?")
    const matcher = vi.fn((symbol: string) => {
      const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`)
      return (text: string) => re.test(text)
    })
    const lx = makeLexicon({
      matcher,
      categories: [["exploit", /\bhack(ed)?\b/i] as const, ["listing", /\blists?\b/i] as const],
      negative: /\b(hacked|falls)\b/i,
      positive: /\b(lists|rallies)\b/i,
      marketWide: (_text, category) => category === "exploit",
      volumeAnomalyPoints: 5,
    })
    expect(lx.tag("AB rallies, CD falls", ["AB", "CD", "EF"])).toEqual(["AB", "CD"])
    expect(lx.tag("AB again", ["AB"])).toEqual(["AB"])
    expect(matcher.mock.calls.map(([s]) => s)).toEqual(["AB", "CD", "EF"])
    expect(lx.classify("Exchange hacked")).toBe("exploit")
    expect(lx.classify("Weekly recap", "listing")).toBe("listing")
    expect(lx.classify("Weekly recap")).toBe("general")
    expect([lx.polarity("Exchange hacked"), lx.polarity("Coinbase lists X"), lx.polarity("X rallies as Y falls"), lx.polarity("Nothing")]).toEqual([-1, 1, 0, 0])
    expect(lx.marketWide("x", "exploit")).toBe(true)
    expect(lx.volumeAnomalyPoints).toBe(5)
    expect("baseSeverity" in lx).toBe(false)
  })
})
