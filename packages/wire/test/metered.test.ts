import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it } from "vitest"
import type { RequestText } from "../src/fetch"
import { brightDataProvider, brightDataSearch, googleDate } from "../src/research/brightdata"
import { exaProvider } from "../src/research/exa"
import { allowanceSoFar, spendLedger } from "../src/research/metered"

const OCT_1 = new Date(Date.UTC(2026, 9, 1, 12))
const OPTS = { range: "week" as const, since: "2026-09-24", maxResults: 8, timeoutMs: 5_000 }

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** A RequestText answering every request with `answer`, keeping what was sent. */
const fakeRequest = (answer: () => { text: string; headers?: Record<string, string> }) => {
  const sent: Sent[] = []
  const request = (async (url: string, opts: { headers?: Record<string, string>; body?: string }) => {
    sent.push({ url, headers: opts.headers ?? {}, body: opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : {} })
    const a = answer()
    return { status: 200, text: a.text, headers: new Headers(a.headers) }
  }) as unknown as RequestText
  return { request, sent }
}

const GOOGLE = {
  general: { search_engine: "google" },
  top_stories: { items: [{ title: "Coinbase beats estimates", link: "https://www.reuters.com/business/coinbase-q3", source: "Reuters", date: "18 hours ago" }] },
  organic: [
    { link: "https://investor.coinbase.com/q3", title: "Coinbase Q3 2026 shareholder letter", description: "Our third quarter results.", extensions: [{ type: "text", text: "9 hours ago" }] },
    { link: "https://www.reuters.com/business/coinbase-q3", title: "Duplicate of the story", description: "Same URL." },
    { link: "https://www.cnn.com/coinbase", title: "Coinbase guidance", description: "Guidance for Q4.", extensions: [{ type: "text", text: "Oct 26, 2026" }] },
    { link: "https://www.facebook.com/post", title: "A post", description: "No date." },
  ],
}

describe("metered providers", () => {
  it("splits a month evenly, in whole searches or in dollars", () => {
    expect(allowanceSoFar(5_000, OCT_1)).toBe(161)
    expect(allowanceSoFar(5_000, new Date(Date.UTC(2026, 9, 31)))).toBe(4_991)
    expect(allowanceSoFar(10, OCT_1, false)).toBeCloseTo(10 / 31)
  })

  it("reads Google's dates, relative or absolute", () => {
    const now = new Date("2026-10-29T12:00:00Z")
    expect(googleDate("9 hours ago", now)).toBe("2026-10-29T03:00:00.000Z")
    expect(googleDate("1 day ago", now)).toBe("2026-10-28T12:00:00.000Z")
    expect(googleDate("3 mins ago", now)).toBe("2026-10-29T11:57:00.000Z")
    expect(googleDate("Yesterday", now)).toBe("2026-10-28T12:00:00.000Z")
    expect(googleDate("Oct 26, 2026", now)?.slice(0, 10)).toBe("2026-10-26")
    expect(googleDate("Rating: 4.5", now)).toBeNull()
    expect(googleDate("", now)).toBeNull()
  })

  it("searches Google through Bright Data's SERP zone: top stories first, then results, dated", async () => {
    const { request, sent } = fakeRequest(() => ({ text: JSON.stringify(GOOGLE) }))
    const now = new Date("2026-10-29T12:00:00Z")
    const results = await brightDataSearch(request, "bd-key-0123456789", "serp_api1", "Coinbase earnings guidance", OPTS, now)
    expect(sent[0].url).toBe("https://api.brightdata.com/request")
    expect(sent[0].headers.authorization).toBe("Bearer bd-key-0123456789")
    expect(sent[0].body).toEqual({ zone: "serp_api1", url: "https://www.google.com/search?q=Coinbase+earnings+guidance&tbs=qdr%3Aw&hl=en&gl=us&brd_json=1", format: "raw" })
    expect(results.map((r) => [r.url, r.published?.slice(0, 13) ?? null, r.snippet])).toEqual([
      ["https://www.reuters.com/business/coinbase-q3", "2026-10-28T18", "Reuters"],
      ["https://investor.coinbase.com/q3", "2026-10-29T03", "Our third quarter results."],
      ["https://www.cnn.com/coinbase", expect.stringMatching(/^2026-10-2[56]/), "Guidance for Q4."],
      ["https://www.facebook.com/post", null, "No date."],
    ])
  })

  it("treats Bright Data's failed searches, which still answer 200, as failures", async () => {
    const { request } = fakeRequest(() => ({ text: "", headers: { "x-brd-error": "redirect location was rejected" } }))
    await expect(brightDataSearch(request, "bd-key-0123456789", "serp_api1", "q", OPTS, OCT_1)).rejects.toThrow("Bright Data: redirect location was rejected")
  })

  it("keeps Bright Data to this engine's half of the even split: 80 requests on the 1st of a 31-day month", async () => {
    const { request, sent } = fakeRequest(() => ({ text: JSON.stringify(GOOGLE) }))
    const provider = brightDataProvider(request, "bd-key-0123456789", "serp_api1", spendLedger(undefined, silentLogger), () => OCT_1)
    let answered = 0
    for (let i = 0; i < 90; i++) if (await provider.search("q", OPTS)) answered++
    expect([answered, sent.length]).toEqual([80, 80])
  })

  it("searches Exa from the research's start date, with highlights for snippets, and paces it in dollars at the cost Exa reports", async () => {
    const answer = {
      results: [
        { title: "HyperLabs unstakes HYPE", url: "https://phemex.com/news/1", publishedDate: "2026-10-29T00:00:00.000Z", highlights: ["HyperLabs unstaked 179,706 HYPE.", "Worth $14.49M."] },
        { title: "No highlights", url: "https://example.com/2" },
      ],
      costDollars: { total: 0.007, search: { neural: 0.007 } },
    }
    const { request, sent } = fakeRequest(() => ({ text: JSON.stringify(answer) }))
    const ledger = spendLedger(undefined, silentLogger)
    const provider = exaProvider(request, "exa-key-0123456789", ledger, () => OCT_1)
    const first = await provider.search("HYPE unlock", OPTS)
    expect(sent[0].url).toBe("https://api.exa.ai/search")
    expect(sent[0].headers["x-api-key"]).toBe("exa-key-0123456789")
    expect(sent[0].body).toEqual({ query: "HYPE unlock", type: "auto", numResults: 8, startPublishedDate: "2026-09-24T00:00:00.000Z", contents: { highlights: { maxCharacters: 400 } } })
    expect(first?.map((r) => [r.url, r.snippet, r.published])).toEqual([
      ["https://phemex.com/news/1", "HyperLabs unstaked 179,706 HYPE. … Worth $14.49M.", "2026-10-29T00:00:00.000Z"],
      ["https://example.com/2", "", null],
    ])
    // Oct 1's share of $10 is $0.32; this engine's half, $0.16, buys 23 searches at $0.007.
    let answered = 1
    for (let i = 0; i < 40; i++) if (await provider.search("q", OPTS)) answered++
    expect(answered).toBe(23)
    expect(ledger.spent("exa")).toBeCloseTo(0.161)
  })

  it("settles an Exa search at what it really cost", async () => {
    const { request } = fakeRequest(() => ({ text: JSON.stringify({ results: [], costDollars: { total: 0.012 } }) }))
    const ledger = spendLedger(undefined, silentLogger)
    await exaProvider(request, "exa-key-0123456789", ledger, () => OCT_1).search("q", OPTS)
    expect(ledger.spent("exa")).toBeCloseTo(0.012)
  })
})
