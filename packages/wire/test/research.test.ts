import { silentLogger } from "@mb/engine-kit/log"
import { json } from "@mb/engine-kit/testing/fetch"
import { httpClient } from "@mb/engine-kit/util/http"
import { describe, expect, it, vi } from "vitest"
import { localResearcher, MEMO_SYSTEM, memoBudget, PICK_SYSTEM, PLAN_SYSTEM, rangeFor } from "../src/research/local"
import type { RequestText } from "../src/fetch"
import { tavilyAllowance, tavilyPacer } from "../src/research/tavily"

const ENV = { LLM_URL: "http://llm:8080", SEARCH_URL: "http://search:8080", SCRAPER_URL: "http://scraper:8790" }
const TAVILY_ENV = { ...ENV, TAVILY_API_KEY: "tvly-test-key-0123456789" }
const MODEL = "local/qwen3.6-35b-a3b-q2"
const PROMPT = "You are the research desk. Use your live tools (x_search first, web_search to confirm) for these gaps:\n- HYPE/USD [candidate]: unexplained -6% in 4 h"
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

const FREE = "duckduckgo news,yahoo news"
const FREE_BY_RANGE = "bing news"
const PAID = "google cse"

const RESULTS = [
  { url: "https://www.coindesk.com/markets/2026/10/28/hype-unlock", title: "Hyperliquid unlocks 9.9M HYPE", content: "The team unlocked 9.9 million HYPE tokens on Tuesday.", engines: ["duckduckgo news", "bing news"], publishedDate: hoursAgo(5) },
  { url: "https://www.coingecko.com/en/coins/hyperliquid", title: "Hyperliquid price chart", content: "Live HYPE price.", engines: ["bing news"] },
  { url: "https://www.theblock.co/post/1/hyperliquid-outflows", title: "Hyperliquid sees $40M outflows", content: "Bridge outflows rose after the unlock.", engines: ["yahoo news"], publishedDate: hoursAgo(2) },
]

const MEMO = `- [FACT] Hyperliquid unlocked 9.9M HYPE on Tuesday (2026-10-28, https://www.coindesk.com/markets/2026/10/28/hype-unlock)
- [CLAIM] $40M of bridge outflows followed (2026-10-28, https://www.theblock.co/post/1/hyperliquid-outflows)
- X sentiment: none was searched.`

const completion = (content: string, usage = { prompt_tokens: 1_000, completion_tokens: 100 }) => json({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage })

type Call = { path: string; body: Record<string, unknown>; url: URL; headers: Record<string, string> }

const TAVILY_RESULTS = [
  { title: "HYPE unlock schedule", url: "https://hyperliquid.xyz/blog/unlock", content: "The official unlock schedule.", score: 0.9, published_date: hoursAgo(3) },
  { title: "Hyperliquid governance", url: "https://forum.hyperliquid.xyz/t/1", content: "A proposal on the unlock.", score: 0.8, published_date: null },
  { title: "HYPE explained", url: "https://www.theblock.co/post/2/hype", content: "What the unlock means.", score: 0.7 },
]

/** A fake model server, search service, scraper and Tavily (its paths prefixed "tavily") behind global fetch. */
const fakeServices = ({
  search = () => json({ results: RESULTS, unresponsive_engines: [["bing news", "parsing error"]] }),
  extract,
  tavilyUsage = () => json({ key: { usage: 0, limit: null }, account: { current_plan: "Researcher", plan_usage: 0, plan_limit: 1_000 } }),
  tavilySearch = () => json({ query: "", results: TAVILY_RESULTS, response_time: 0.8, usage: { credits: 1 } }),
}: { search?: (q: string, engines: string) => Response; extract?: (url: string) => Response; tavilyUsage?: () => Response; tavilySearch?: (query: string) => Response } = {}) => {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      const tavily = url.host === "api.tavily.com"
      calls.push({ path: `${tavily ? "tavily" : ""}${url.pathname}`, body, url, headers: (init.headers ?? {}) as Record<string, string> })
      if (tavily && url.pathname === "/usage") return tavilyUsage()
      if (tavily && url.pathname === "/search") return tavilySearch(String(body.query))
      if (url.pathname === "/search") return search(url.searchParams.get("q") ?? "", url.searchParams.get("engines") ?? "")
      if (url.pathname === "/extract") {
        const target = String(body.url)
        return extract ? extract(target) : json({ status: "ok", title: "Hyperliquid unlocks 9.9M HYPE", published: "2026-10-28T09:00:00Z", lang: "en", text: `Full article about ${target}. `.repeat(20), words: 400 })
      }
      if (url.pathname === "/v1/chat/completions") {
        const system = (body.messages as { content: string }[])[0].content
        if (system === PLAN_SYSTEM) return completion(JSON.stringify({ queries: ["Hyperliquid HYPE news", "HYPE token unlock", "HYPE token unlock"] }))
        if (system === PICK_SYSTEM) return completion(JSON.stringify({ read: [2, 0, 0, 99] }))
        if (system === MEMO_SYSTEM) return completion(MEMO, { prompt_tokens: 6_000, completion_tokens: 900 })
      }
      throw new Error(`unexpected request ${url}`)
    }),
  )
  return { calls, of: (path: string) => calls.filter((c) => c.path === path) }
}

const researcher = (env: Record<string, string | undefined> = ENV, paidSearchesPerDay?: number) => localResearcher({ request: httpClient("test").requestText, env, client: "crypto", log: silentLogger, paidSearchesPerDay })
const job = (over = {}) => ({ model: MODEL, prompt: PROMPT, fromDate: yesterday(), timeoutMs: 120_000, ...over })

describe("local research", () => {
  it("plans searches, runs them, reads the picks, and writes a memo from them alone", async () => {
    const http = fakeServices()
    const progress = { onQuery: vi.fn(), onSource: vi.fn(), onText: vi.fn() }
    const r = await researcher()({ ...job(), progress })
    expect(r.error).toBeNull()
    expect(r.memo).toBe(MEMO)
    // The repeated query runs once.
    expect(r.queries).toEqual(["Hyperliquid HYPE news", "HYPE token unlock"])
    expect(progress.onQuery.mock.calls).toEqual([
      ["Hyperliquid HYPE news", "web_search"],
      ["HYPE token unlock", "web_search"],
    ])
    // The free engines only: Bing News filters by date itself, the others are dated here. They found enough, so no paid search.
    const searches = http.of("/search").map((c) => Object.fromEntries(c.url.searchParams))
    expect(searches).toHaveLength(4)
    expect(searches).toEqual(
      expect.arrayContaining(
        ["Hyperliquid HYPE news", "HYPE token unlock"].flatMap((q) => [
          { q, format: "json", engines: FREE_BY_RANGE, time_range: "day", language: "en" },
          { q, format: "json", engines: FREE, language: "en" },
        ]),
      ),
    )
    // The picks, best first and once each (an index out of range is dropped), go to the scraper as this bot.
    expect(http.of("/extract").map((c) => [c.body.url, c.headers["x-client"]])).toEqual([
      ["https://www.theblock.co/post/1/hyperliquid-outflows", "crypto"],
      ["https://www.coindesk.com/markets/2026/10/28/hype-unlock", "crypto"],
    ])
    expect(progress.onSource).toHaveBeenCalledTimes(2)
    // Planning and picking don't think; the memo thinks a little.
    const [plan, pick, memo] = http.of("/v1/chat/completions").map((c) => c.body)
    expect(plan).toMatchObject({ model: "qwen3.6-35b-a3b-q2", chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none", response_format: { type: "json_schema" } })
    expect(pick).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema" } })
    expect(memo).toMatchObject({ chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: 1_024 })
    expect(memo).not.toHaveProperty("response_format")
    const user = (memo.messages as { content: string }[])[1].content
    expect(user).toContain(PROMPT)
    expect(user).toContain('<untrusted source="search results">')
    expect(user).toContain('<untrusted source="article">')
    // The sources: the two articles read; the price page is neither read nor cited.
    expect(r.sources.map((s) => s.domain)).toEqual(["theblock.co", "coindesk.com"])
    expect(r.usage).toEqual({ input: 8_000, output: 1_100, total: 9_100 })
  })

  it("cites a result it didn't read when the memo uses it", async () => {
    fakeServices({ extract: () => json({ status: "skipped", reason: "paywall" }) })
    const r = await researcher()(job())
    expect(r.error).toBeNull()
    expect(r.sources.map((s) => s.url)).toEqual(["https://www.coindesk.com/markets/2026/10/28/hype-unlock", "https://www.theblock.co/post/1/hyperliquid-outflows"])
  })

  it("reports a search that finds nothing in the memo, not as a failure", async () => {
    const http = fakeServices({ search: () => json({ results: [], unresponsive_engines: [["duckduckgo", "CAPTCHA"]] }) })
    const r = await researcher()(job())
    expect(r).toMatchObject({ error: null, sources: [], memo: "Web search found nothing for: Hyperliquid HYPE news; HYPE token unlock. No other research this cycle: decide from WIRE and the market data." })
    expect(http.of("/v1/chat/completions")).toHaveLength(1)
  })

  it("searches the paid engines only for a query the free ones found too little for, and keeps only results dated since the request's date", async () => {
    const old = { url: "https://example.com/old", title: "Old news", content: "", engines: ["yahoo news"], publishedDate: hoursAgo(24 * 5) }
    const undated = { url: "https://example.com/undated", title: "Undated", content: "", engines: ["duckduckgo news"] }
    const web = { url: "https://hyperliquid.xyz/blog/unlock", title: "Unlock schedule", content: "The official schedule.", engines: ["google cse"] }
    const http = fakeServices({
      search: (q, engines) => {
        if (engines === PAID) return json({ results: [web], unresponsive_engines: [] })
        if (q !== "HYPE token unlock") return json({ results: RESULTS, unresponsive_engines: [] })
        return json({ results: engines === FREE ? [old, undated, RESULTS[2]] : [], unresponsive_engines: [] })
      },
    })
    expect((await researcher()(job())).error).toBeNull()
    const paid = http.of("/search").filter((c) => c.url.searchParams.get("engines") === PAID)
    expect(paid.map((c) => Object.fromEntries(c.url.searchParams))).toEqual([{ q: "HYPE token unlock", format: "json", engines: PAID, time_range: "day", language: "en" }])
    // The model picks from what's left: the free results, then the paid one, without the old or undated ones.
    const listing = (http.of("/v1/chat/completions")[1].body.messages as { content: string }[])[1].content
    expect(listing).toContain("https://hyperliquid.xyz/blog/unlock")
    expect(listing).not.toContain("example.com")
  })

  it("stops searching the paid engines at the day's limit", async () => {
    const http = fakeServices({ search: () => json({ results: [], unresponsive_engines: [] }) })
    const research = researcher(ENV, 1)
    await research(job())
    await research(job())
    // Two runs of two queries the free engines found nothing for: one paid search in all.
    expect(http.of("/search").filter((c) => c.url.searchParams.get("engines") === PAID)).toHaveLength(1)
  })

  it("splits Tavily's month evenly over its days", () => {
    expect([1, 31].map((day) => tavilyAllowance(1_000, new Date(Date.UTC(2026, 9, day, 12))))).toEqual([32, 992])
    expect(tavilyAllowance(1_000, new Date(Date.UTC(2026, 10, 30, 23, 59)))).toBe(990)
    expect(tavilyAllowance(1_000, new Date(Date.UTC(2027, 1, 28)))).toBe(980)
  })

  it("asks Tavily before the paid engine for a query the free ones found too little for, reading the month's usage once", async () => {
    const http = fakeServices({ search: () => json({ results: [], unresponsive_engines: [] }) })
    const r = await researcher(TAVILY_ENV)(job())
    expect(r.error).toBeNull()
    const asked = http.of("tavily/search")
    expect(asked.map((c) => c.body)).toEqual(
      expect.arrayContaining(
        ["Hyperliquid HYPE news", "HYPE token unlock"].map((query) => ({ query, search_depth: "basic", topic: "general", time_range: "day", max_results: 8, include_published_date: true, include_answer: false, include_raw_content: false, include_images: false })),
      ),
    )
    expect(asked[0].headers.authorization).toBe("Bearer tvly-test-key-0123456789")
    expect(http.of("tavily/usage")).toHaveLength(1)
    // Tavily found enough: the proxy isn't used.
    expect(http.of("/search").filter((c) => c.url.searchParams.get("engines") === PAID)).toHaveLength(0)
    const listing = (http.of("/v1/chat/completions")[1].body.messages as { content: string }[])[1].content
    expect(listing).toContain("https://hyperliquid.xyz/blog/unlock")
  })

  it("doesn't search Tavily past the month's even split so far, or when its usage can't be read: the paid engine does", async () => {
    for (const tavilyUsage of [
      () => json({ account: { plan_usage: tavilyAllowance(1_000, new Date()), plan_limit: 1_000 } }),
      () => new Response("down", { status: 500 }),
    ]) {
      const http = fakeServices({ search: () => json({ results: [], unresponsive_engines: [] }), tavilyUsage })
      expect((await researcher(TAVILY_ENV)(job())).error).toBeNull()
      expect(http.of("tavily/search")).toHaveLength(0)
      expect(http.of("/search").filter((c) => c.url.searchParams.get("engines") === PAID)).toHaveLength(2)
    }
  })

  it("keeps counting its own Tavily searches while Tavily's count lags, and starts over with the month", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 1, 0, 30) })
    try {
      const reads: number[] = []
      const request = (async () => {
        reads.push(Date.now())
        return { status: 200, text: JSON.stringify({ account: { plan_usage: 0, plan_limit: 1_000 } }), headers: new Headers() }
      }) as unknown as RequestText
      const pacer = tavilyPacer(request, "tvly-test-key-0123456789")
      const day = async (searches: number) => {
        let taken = 0
        for (let i = 0; i < searches; i++) {
          if (await pacer.take()) taken++
          vi.setSystemTime(Date.now() + 60_000) // a minute apart: a new reading every five
        }
        return taken
      }
      // Oct 1: this engine's half of 32 credits, though Tavily still says 0 after every search.
      expect(await day(40)).toBe(16)
      expect(reads.length).toBeGreaterThan(5)
      // Oct 2: the next 16.
      vi.setSystemTime(Date.UTC(2026, 9, 2, 1))
      expect(await day(40)).toBe(16)
      // Nov 1: a new month, a new count (Tavily's 0 is believed again): half of 33.
      vi.setSystemTime(Date.UTC(2026, 10, 1, 1))
      expect(await day(40)).toBe(16)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops at the account's allowance when Tavily's count shows the other engine's searches", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 1, 12) })
    try {
      // Tavily counts 20 of Oct 1's 32 credits spent elsewhere: this engine gets the 12 left, under its own 16.
      const request = (async () => ({ status: 200, text: JSON.stringify({ account: { plan_usage: 20, plan_limit: 1_000 } }), headers: new Headers() })) as unknown as RequestText
      const pacer = tavilyPacer(request, "tvly-test-key-0123456789")
      let taken = 0
      for (let i = 0; i < 40; i++) if (await pacer.take()) taken++
      expect(taken).toBe(12)
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops searching Tavily after it refuses for lack of credits", async () => {
    const http = fakeServices({ search: () => json({ results: [], unresponsive_engines: [] }), tavilySearch: () => json({ detail: { error: "This request exceeds your plan's set usage limit." } }, { status: 432 }) })
    const research = researcher(TAVILY_ENV)
    await research(job())
    await research(job())
    // The first run's two searches were refused; the second run doesn't try.
    expect(http.of("tavily/search")).toHaveLength(2)
  })

  it("keeps what one free request found when the other fails", async () => {
    fakeServices({ search: (_q, engines) => (engines === FREE_BY_RANGE ? new Response("bad gateway", { status: 502 }) : json({ results: engines === FREE ? RESULTS : [], unresponsive_engines: [] })) })
    const r = await researcher()(job())
    expect(r.error).toBeNull()
    expect(r.sources.map((s) => s.domain)).toEqual(["coindesk.com", "theblock.co"])
  })

  it("fails when the search service is unreachable, or isn't configured", async () => {
    fakeServices({
      search: () => {
        throw new TypeError("fetch failed")
      },
    })
    expect(await researcher()(job())).toMatchObject({ memo: "", error: "the search service is unreachable", queries: ["Hyperliquid HYPE news", "HYPE token unlock"] })
    expect(await researcher({ ...ENV, SEARCH_URL: undefined })(job())).toMatchObject({ memo: "", error: "local research needs LLM_URL and SEARCH_URL" })
  })

  it("thinks over the memo only with the time writing it leaves, and keeps it to what that time can write", async () => {
    expect([memoBudget(160_000), memoBudget(66_000), memoBudget(40_000), memoBudget(20_000)]).toEqual([
      { think: 1_024, maxTokens: 3_000 },
      { think: 1_024, maxTokens: 2_240 },
      { think: 0, maxTokens: 1_200 },
      { think: 0, maxTokens: 400 },
    ])
    // A 60 s gap fill reaches its memo with ~40 s left: a memo without thinking, not a timeout.
    const http = fakeServices()
    expect((await researcher()(job({ timeoutMs: 41_000 }))).error).toBeNull()
    const memo = http.of("/v1/chat/completions")[2].body
    expect(memo).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none" })
    expect(memo.max_tokens).toBeLessThanOrEqual(1_200)
  })

  it("searches the last day for yesterday's research, the last week for a few days'", () => {
    const now = new Date("2026-10-28T21:00:00Z")
    expect([rangeFor("2026-10-27", now), rangeFor("2026-10-25", now), rangeFor("2026-10-10", now)]).toEqual(["day", "week", "month"])
  })
})
