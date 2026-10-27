import type { WireSettingsBase, WireSummariesSettings } from "@mb/core/settings"
import type { WireArticle, WireItemDoc } from "@mb/core/wire"
import { silentLogger } from "@mb/engine-kit/log"
import { useMongoTestDb } from "@mb/engine-kit/testing/db"
import { json } from "@mb/engine-kit/testing/fetch"
import { httpClient } from "@mb/engine-kit/util/http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkSummary } from "../src/enrich/article"
import { ENRICH_SOURCE_ID, Enricher, inPauseHours, type EnrichCandidate } from "../src/enrich/enricher"
import { unmatchedNumbers } from "../src/enrich/numbers"
import { isEnglish, skipReason } from "../src/enrich/select"
import type { Lexicon } from "../src/types"
import { Wire } from "../src/wire"
import { WIRE_SETTINGS } from "./helpers"

const NOW = new Date("2026-10-27T12:00:00Z")
const SCRAPER_URL = "http://scraper:8790"
const LLM_URL = "http://llm:11434"
const SUMMARIES: WireSummariesSettings = WIRE_SETTINGS.summaries

/** After the spike's article #13 (Costco, foxbusiness.com). */
const ARTICLE =
  "Costco Wholesale said on Thursday that it received $184 million in tariff refunds during the quarter. Of that, $174 million was the refunds themselves and $10 million was interest. " +
  "The company said the amount represents a little over one-third of the total tariff refunds that it expects to receive, adding that it had already received a similar amount of refunds in the first quarter. " +
  "Costco said most of the money will go toward lower prices for its members, and that it has no plans to change its membership fees this year."

const GOOD = {
  summary: "Costco received $184 million in tariff refunds, a little over one-third of what it expects. It had already received a similar amount in the first quarter.",
  key_points: ["$174 million was refunds and $10 million was interest", "Most of the money goes toward lower prices"],
}

/** The spike's worst slip (llama3.2:3b, prompt v1): a total the article never states. */
const INVENTED = {
  summary: GOOD.summary,
  key_points: ["Costco expects to receive a similar amount of refunds in the first quarter, with the total tariff refunds expected to be around $600 million."],
}

const extracted = (over: Record<string, unknown> = {}) =>
  json({ status: "ok", url: "x", final_url: "x", title: "Costco receives $184M in tariff refunds", byline: null, published: "2026-10-27T10:00:00.000Z", lang: "en", text: ARTICLE, words: 497, rendered: false, truncated: false, ...over })
const replied = (reply: unknown) => json({ model: "llama3.2:3b", message: { role: "assistant", content: typeof reply === "string" ? reply : JSON.stringify(reply) }, done: true })
const onGpu = (vram = 2_500_000_000) => json({ models: [{ name: "llama3.2:3b", model: "llama3.2:3b", size: 2_500_000_000, size_vram: vram }] })

type Handler = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>

/** A fake scraper and Ollama behind global fetch, routed by path. */
const fakeHttp = (routes: { extract?: Handler; chat?: Handler; ps?: Handler } = {}) => {
  const handlers: Record<string, Handler> = { "/extract": routes.extract ?? (() => extracted()), "/api/chat": routes.chat ?? (() => replied(GOOD)), "/api/ps": routes.ps ?? (() => onGpu()) }
  const calls: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
      calls.push({ path: url.pathname, body, headers: (init.headers ?? {}) as Record<string, string> })
      const handler = handlers[url.pathname]
      if (!handler) throw new Error(`unexpected request ${url}`)
      return handler(body, init)
    }),
  )
  return {
    calls,
    count: (path: string) => calls.filter((c) => c.path === path).length,
    route: (path: "/extract" | "/api/chat" | "/api/ps", handler: Handler) => void (handlers[path] = handler),
  }
}

const item = (id: string, over: Partial<EnrichCandidate> = {}): EnrichCandidate => ({
  _id: id,
  cluster_id: id,
  kind: "news",
  title: "Costco receives $184M in tariff refunds",
  url: `https://www.foxbusiness.com/markets/${id}`,
  severity: 60,
  notable: false,
  first_seen_at: NOW,
  published_at: NOW,
  ...over,
})

const makeEnricher = ({
  summaries = {},
  env = { SCRAPER_URL, LLM_URL },
  mode = "live",
  timeouts,
}: { summaries?: Partial<WireSummariesSettings>; env?: Record<string, string>; mode?: WireSettingsBase["mode"]; timeouts?: { chatMs?: number } } = {}) => {
  const clock = { now: NOW }
  const stored = new Map<string, WireArticle>()
  const states: string[] = []
  const settings = { mode, summaries: { ...SUMMARIES, ...summaries } }
  const enricher = new Enricher({
    store: async (id, article) => void stored.set(id, article),
    log: silentLogger,
    settings: () => settings,
    env,
    client: "crypto",
    request: httpClient("test").requestText,
    now: () => clock.now,
    onState: (state) => void states.push(state),
    timeouts,
  })
  return { enricher, stored, clock, states }
}

const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)

describe("which items get a summary", () => {
  const s = { min_severity: 55, skip_domains: ["example.com"] }
  const at = (url: string, over: Partial<EnrichCandidate> = {}) => skipReason(item("x", { url, ...over }), s)

  it("takes cluster roots at the minimum severity, or notable, with an article link", () => {
    expect(at("https://www.coindesk.com/policy/2026/10/26/occ")).toBeNull()
    expect(at("https://www.sec.gov/newsroom/press-releases/2026-100")).toBeNull()
    expect(at("https://www.bankofengland.co.uk/monetary-policy-summary-and-minutes/2026/september-2026", { kind: "macro" })).toBeNull()
    expect(at("https://a.test/1", { severity: 54 })).toBe("severity 54 below 55")
    expect(at("https://a.test/1", { severity: 40, notable: true })).toBeNull()
    expect(at("https://a.test/1", { cluster_id: "root" })).toBe("not the first item of its cluster")
    expect(at("https://a.test/1", { article: { status: "ok" } })).toBe("already summarized")
    expect(skipReason(item("x", { url: null }), s)).toBe("no article link")
  })

  it("leaves out what isn't an article: halts, filings, social posts, odds, videos, Google News links", () => {
    expect(at("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts", { kind: "venue" })).toBe("venue item")
    expect(at("https://www.sec.gov/Archives/edgar/data/320193/0000320193-26-000001-index.htm", { kind: "filing" })).toBe("filing item")
    expect(at("https://www.nasdaqtrader.com/Trader.aspx?id=TradeHalts")).toBe("trading halt")
    expect(at("https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K")).toBe("EDGAR filing page")
    expect(at("https://www.sec.gov/Archives/edgar/data/320193/x.htm")).toBe("EDGAR filing page")
    expect(at("https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process")).toBe("FDA database page")
    expect(at("https://x.com/whale_alert/status/1")).toBe("social post")
    expect(at("https://www.trumpstruth.org/statuses/123")).toBe("social post")
    expect(at("https://bsky.app/profile/a.bsky.social/post/3k")).toBe("social post")
    expect(at("https://t.me/s/WatcherGuru/1234")).toBe("social post")
    expect(at("https://kalshi.com/markets/kxcpi")).toBe("odds market")
    expect(at("https://polymarket.com/event/fed-decision")).toBe("odds market")
    expect(at("https://decrypt.co/videos/news/abc")).toBe("video")
    expect(at("https://www.youtube.com/watch?v=abc")).toBe("video")
    expect(at("https://news.google.com/rss/articles/CBMi")).toBe("Google News redirect")
    expect(at("https://www.federalreserve.gov/monetarypolicy/files/monetary20260916a1.pdf")).toBe("not a web page")
    expect(at("https://www.benzinga.com/news/26/10/123/x")).toBe("Benzinga (headline and link only)")
  })

  it("refuses the paywall list and the settings' skip list, subdomains included", () => {
    expect(at("https://www.wsj.com/finance/x")).toBe("skip list: wsj.com")
    expect(at("https://markets.ft.com/data/x")).toBe("skip list: ft.com")
    expect(at("https://news.example.com/x")).toBe("skip list: example.com")
    expect(at("https://notexample.com/x")).toBeNull()
  })

  it("wants English: a Latin-script title, then the article's language and words", () => {
    expect(skipReason(item("x", { title: "비트코인 거래소 해킹으로 출금 중단" }), s)).toBe("not English")
    const english = "The company said on Thursday that it has received the refunds and that most of the money will go to its members, which is what it had planned. ".repeat(3)
    const spanish = "La empresa dijo el jueves que recibió los reembolsos y que la mayor parte del dinero irá a sus socios, como lo había planeado desde el principio. ".repeat(3)
    expect(isEnglish(english, "en-US")).toBe(true)
    expect(isEnglish(english, null)).toBe(true)
    expect(isEnglish(english, "de")).toBe(false)
    expect(isEnglish(spanish, null)).toBe(false)
  })
})

describe("the number check", () => {
  it("rejects the spike's invented total and corrupted numbers", () => {
    expect(unmatchedNumbers(INVENTED.key_points, ARTICLE)).toEqual(["600"])
    // The spike's qwen3:4b slip: "Q3 2:026" for Q3 2026. The quarter checks out; the mangled year doesn't.
    expect(unmatchedNumbers(["Fortive reports Q3 2:026 results"], "Fortive will report third-quarter 2026 results on Oct. 29.")).toEqual(["2", "026"])
  })

  it("matches numbers by value, however they are written", () => {
    const article = "Revenue rose 3.75% to $1,200,000. The bank priced $2.0 billion of notes due 2028 through 2036 in the third quarter. Rates are at 3-3/4 to 4 percent."
    // A converted number is a new number.
    expect(unmatchedNumbers(["Revenue rose 3.75 percent to $1.2 million"], article)).toEqual(["1.2"])
    expect(unmatchedNumbers(["Revenue rose 3.75 percent to 1200000 dollars", "$2 billion of notes due 2028–2036, priced in Q3", "Rates are at 3-3/4 to 4 percent"], article)).toEqual([])
    expect(unmatchedNumbers(["Q4 sales"], "Sales rose in the third quarter.")).toEqual(["Q4"])
    expect(unmatchedNumbers(["7 analysts expect more"], "Seven analysts expect more.")).toEqual([])
    // Numbers inside names and codes aren't amounts.
    expect(unmatchedNumbers(["Web3 and B2B payments grow"], article)).toEqual([])
  })

  it("can't catch a real number pinned on the wrong thing (why summaries are labelled)", () => {
    const article = "Penalties are up to C$1 million for serious violations and up to C$10 million for very serious ones."
    expect(unmatchedNumbers(["Penalties for serious violations reach C$10 million"], article)).toEqual([])
  })

  it("checks the model's reply: JSON, the schema, the word limit, then the numbers", () => {
    const context = `Title: Costco receives $184M in tariff refunds\n\n${ARTICLE}`
    expect(checkSummary(JSON.stringify(GOOD), context)).toEqual({ status: "ok", ...GOOD })
    expect(checkSummary("not json", context)).toEqual({ status: "failed", reason: "the model's reply is not JSON" })
    expect(checkSummary(JSON.stringify({ summary: "x", key_points: [1] }), context)).toEqual({ status: "failed", reason: "the model's reply doesn't match the schema" })
    expect(checkSummary(JSON.stringify({ summary: "word ".repeat(81), key_points: [] }), context)).toEqual({ status: "rejected", reason: "summary has 81 words (max 80)" })
    expect(checkSummary(JSON.stringify(INVENTED), context)).toEqual({ status: "rejected", reason: "numbers not in the article: 600" })
  })
})

describe("the summary queue", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("extracts, summarizes and stores only the summary, once per item", async () => {
    const http = fakeHttp()
    const { enricher, stored } = makeEnricher()
    enricher.offer(item("a"))
    await enricher.idle()
    // Ollama's GPU residency before and after the call, the article in between.
    expect(http.calls.map((c) => c.path)).toEqual(["/api/ps", "/extract", "/api/chat", "/api/ps"])
    const [, extract, chat] = http.calls
    expect(extract.body).toEqual({ url: "https://www.foxbusiness.com/markets/a", render: "auto", skip_domains: SUMMARIES.skip_domains, max_chars: 12_000 })
    expect(extract.headers["x-client"]).toBe("crypto")
    expect(chat.body).toMatchObject({ model: "llama3.2:3b", format: { type: "object", required: ["summary", "key_points"] }, options: { temperature: 0, num_ctx: 4096 }, keep_alive: "5m", stream: false })
    const [system, user] = chat.body.messages as { role: string; content: string }[]
    expect(system.content).toMatch(/Never calculate, total, convert or estimate a new number/)
    expect(user.content).toContain('<untrusted source="article">')
    expect(user.content).toContain("Source: foxbusiness.com")
    expect(user.content).toContain(ARTICLE.slice(0, 80))
    const article = stored.get("a")!
    expect(article).toEqual({ status: "ok", summary: GOOD.summary, key_points: GOOD.key_points, words: 497, model: "llama3.2:3b", ms: 0, at: NOW })
    expect(enricher.health()).toMatchObject({ id: ENRICH_SOURCE_ID, state: "ok", items_24h: 1, dropped_24h: 0, last_item_at: NOW, last_error: null })
    // Offered again (a confirmation, a notable mark), or already summarized: never twice.
    enricher.offer(item("a"))
    enricher.offer(item("b", { article }))
    await enricher.idle()
    expect(http.count("/extract")).toBe(1)
  })

  it("stores why an article was skipped, without asking the model", async () => {
    const http = fakeHttp({
      extract: (body) => {
        const url = String(body.url)
        if (url.endsWith("/short")) return extracted({ words: 120 })
        if (url.endsWith("/german")) return extracted({ lang: "de" })
        if (url.endsWith("/robots")) return json({ status: "skipped", reason: "robots.txt disallows /markets/robots" })
        return json({ status: "failed", reason: "http 403" })
      },
    })
    const { enricher, stored } = makeEnricher()
    for (const id of ["short", "german", "robots", "blocked"]) enricher.offer(item(id))
    await enricher.idle()
    expect(Object.fromEntries([...stored].map(([id, a]) => [id, [a.status, a.reason, a.summary]]))).toEqual({
      short: ["skipped", "too short (120 words)", undefined],
      german: ["skipped", "not English (de)", undefined],
      robots: ["skipped", "robots.txt disallows /markets/robots", undefined],
      blocked: ["failed", "http 403", undefined],
    })
    expect(http.count("/api/chat")).toBe(0)
    expect(enricher.health()).toMatchObject({ state: "ok", items_24h: 0, dropped_24h: 4 })
  })

  it("rejects a summary with a number the article doesn't have, and keeps none of it", async () => {
    fakeHttp({ chat: () => replied(INVENTED) })
    const { enricher, stored } = makeEnricher()
    enricher.offer(item("costco"))
    await enricher.idle()
    expect(stored.get("costco")).toEqual({ status: "rejected", reason: "numbers not in the article: 600", words: 497, model: "llama3.2:3b", ms: 0, at: NOW })
  })

  it("pauses for 30 minutes when a call left the model partly outside GPU memory, so it doesn't keep running on the CPU", async () => {
    let ps = 0
    // Not loaded before the first call; the call loads it only partly onto the GPU.
    const http = fakeHttp({ ps: () => (ps++ === 0 ? json({ models: [] }) : onGpu(1_200_000_000)) })
    const { enricher, stored, clock, states } = makeEnricher()
    enricher.offer(item("a"))
    await enricher.idle()
    expect(stored.get("a")?.status).toBe("ok")
    expect(enricher.health()).toMatchObject({ state: "degraded", last_error: "llama3.2:3b not fully on the GPU (1,144 of 2,384 MB): paused for 30 min" })
    enricher.offer(item("b"))
    await enricher.idle()
    expect(http.count("/extract")).toBe(1)
    http.route("/api/ps", () => onGpu())
    clock.now = minutes(31)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await enricher.idle()
    expect(stored.get("b")?.status).toBe("ok")
    expect(enricher.health()).toMatchObject({ state: "ok", last_error: null })
    expect(states).toEqual(["degraded", "ok"])
  })

  it("doesn't start an article while the model sits partly on the CPU (the other engine may have loaded it)", async () => {
    const http = fakeHttp({ ps: () => onGpu(2_000_000_000) })
    const { enricher, stored } = makeEnricher()
    enricher.offer(item("a"))
    await enricher.idle()
    expect(http.calls.map((c) => c.path)).toEqual(["/api/ps"])
    expect(stored.size).toBe(0)
    expect(enricher.health()).toMatchObject({ state: "degraded", detail: expect.stringMatching(/1 queued/), last_error: expect.stringMatching(/not fully on the GPU/) })
    enricher.stop()
  })

  it("keeps to the hourly cap", async () => {
    fakeHttp()
    const { enricher, stored, clock } = makeEnricher({ summaries: { max_per_hour: 2 } })
    for (const id of ["a", "b", "c"]) enricher.offer(item(id))
    await enricher.idle()
    expect(stored.size).toBe(2)
    expect(enricher.health().detail).toMatch(/1 queued · hourly cap \(2\) reached/)
    clock.now = minutes(60)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await enricher.idle()
    expect(stored.size).toBe(3)
  })

  it("waits out the pause hours (UTC)", async () => {
    expect([22, 23, 0, 5].every((h) => inPauseHours(h, ["22-6"]))).toBe(true)
    expect([6, 12, 21].some((h) => inPauseHours(h, ["22-6"]))).toBe(false)
    expect(inPauseHours(17, ["9-17"])).toBe(false)
    expect(inPauseHours(23, ["0-24"])).toBe(true)
    fakeHttp()
    const { enricher, stored, clock } = makeEnricher({ summaries: { pause_hours: ["11-13"] } })
    enricher.offer(item("a"))
    await enricher.idle()
    expect(stored.size).toBe(0)
    expect(enricher.health().detail).toMatch(/1 queued · pause hours/)
    clock.now = minutes(60)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await enricher.idle()
    expect(stored.get("a")?.status).toBe("ok")
  })

  it("keeps the most severe items when the queue is full", async () => {
    fakeHttp()
    const { enricher, stored, clock } = makeEnricher({ summaries: { max_per_hour: 1 } })
    enricher.offer(item("first"))
    await enricher.idle()
    for (let i = 0; i < 50; i++) enricher.offer(item(`low${i}`, { severity: 56 }))
    enricher.offer(item("high", { severity: 90 }))
    enricher.offer(item("lower", { severity: 55 }))
    expect(enricher.health().detail).toMatch(/50 queued/)
    clock.now = minutes(60)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await enricher.idle()
    expect([...stored.keys()]).toEqual(["first", "high"])
  })

  it("backs off when the scraper is unreachable, then tries the item again", async () => {
    const http = fakeHttp({
      extract: () => {
        throw new TypeError("fetch failed")
      },
    })
    const { enricher, stored, clock } = makeEnricher()
    enricher.offer(item("a"))
    await enricher.idle()
    expect(stored.size).toBe(0)
    expect(enricher.health()).toMatchObject({ state: "degraded", last_error: "scraper: POST /extract outcome unknown: fetch failed" })
    http.route("/extract", () => extracted())
    clock.now = minutes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await enricher.idle()
    expect(stored.get("a")?.status).toBe("ok")
    expect(enricher.health()).toMatchObject({ state: "ok", last_error: null })
  })

  it("treats a model that errors or stalls as an outage, not as the article's fault", async () => {
    const http = fakeHttp({ chat: () => json({ error: "model 'llama3.2:3b' not found" }, { status: 404 }) })
    const a = makeEnricher()
    a.enricher.offer(item("a"))
    await a.enricher.idle()
    expect(a.stored.size).toBe(0)
    expect(a.enricher.health()).toMatchObject({ state: "degraded", last_error: expect.stringMatching(/^local model: POST \/api\/chat failed \(404\)/) })
    // Tried once more after the backoff, then given up.
    a.clock.now = minutes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    await a.enricher.idle()
    expect(http.count("/api/chat")).toBe(2)
    expect(a.stored.size).toBe(0)
    a.enricher.stop()

    // Ollama unreachable: the scraper isn't spent on the article.
    http.route("/api/ps", () => {
      throw new TypeError("fetch failed")
    })
    const c = makeEnricher()
    c.enricher.offer(item("c"))
    await c.enricher.idle()
    expect(c.enricher.health().last_error).toBe("local model: fetch failed")
    expect(http.count("/extract")).toBe(2)
    c.enricher.stop()
    http.route("/api/ps", () => onGpu())

    http.route("/api/chat", (_body, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason))))
    const b = makeEnricher({ timeouts: { chatMs: 50 } })
    b.enricher.offer(item("b"))
    await b.enricher.idle()
    expect(b.stored.size).toBe(0)
    expect(b.enricher.health().last_error).toMatch(/^local model: POST \/api\/chat outcome unknown: .*(timeout|aborted)/i)
    b.enricher.stop()
  })

  it("is off without LLM_URL or SCRAPER_URL, when switched off, or when the wire is off", async () => {
    const http = fakeHttp()
    expect(makeEnricher({ env: { SCRAPER_URL } }).enricher.health()).toMatchObject({ id: ENRICH_SOURCE_ID, state: "disabled", last_error: "LLM_URL not set (no local model)" })
    expect(makeEnricher({ env: { LLM_URL } }).enricher.health().last_error).toBe("SCRAPER_URL not set (no scraper sidecar)")
    expect(makeEnricher({ mode: "off" }).enricher.health().last_error).toBe("wire is off")
    const off = makeEnricher({ summaries: { enabled: false } })
    expect(off.enricher.health()).toMatchObject({ state: "disabled", last_error: "off in settings" })
    off.enricher.offer(item("a"))
    await off.enricher.idle()
    expect(http.calls).toEqual([])
  })
})

describe("summaries in the wire", () => {
  const db = useMongoTestDb({ prefix: "wire_enrich", indexes: {}, collections: (d) => ({ wireItems: d.collection<WireItemDoc<string>>("wire_items") }) })
  const lexicon: Lexicon = { tag: () => [], classify: () => "general", polarity: () => 0, marketWide: () => true, volumeAnomalyPoints: 10 }

  it("never holds up the pipeline or its trigger handlers, and reports as a source", async () => {
    let release: (r: Response) => void = () => undefined
    let first = true
    const http = fakeHttp({
      extract: () => {
        if (!first) return json({ status: "skipped", reason: "paywall teaser" })
        first = false
        return new Promise<Response>((resolve) => (release = resolve))
      },
    })
    const wire = new Wire<string, WireSettingsBase>({
      col: db.col,
      bus: { emit: vi.fn() },
      log: silentLogger,
      settings: () => WIRE_SETTINGS,
      catalog: [{ id: "rss:a", kind: "rss", url: "https://a.test/feed", interval_s: 60, tier: 1, default_enabled: true }],
      lexicon,
      categoryBase: { general: 40, venue_outage: 80, venue_status: 50 },
      env: { SCRAPER_URL, LLM_URL },
      symbols: () => ({ universe: [], held: [], focus: [] }),
      price: () => null,
      userAgent: "test",
      request: httpClient("test").requestText,
      now: () => NOW,
      enrich: { client: "stock" },
    })
    const handled: string[] = []
    wire.onItem((e) => void handled.push(e.item.title))
    const a = await wire.ingest("rss:a", [{ title: "Costco receives $184M in tariff refunds", url: "https://www.foxbusiness.com/markets/costco", baseSeverity: 70 }])
    await vi.waitFor(() => expect(http.count("/extract")).toBe(1))
    // The scraper is holding the first article; the pipeline and its handlers carry on regardless.
    const b = await wire.ingest("rss:a", [{ title: "Fed holds rates steady", url: "https://news.test/fed", baseSeverity: 70 }])
    expect([a.stored.length, b.stored.length]).toEqual([1, 1])
    expect(handled).toEqual(["Costco receives $184M in tariff refunds", "Fed holds rates steady"])
    expect(http.calls.find((c) => c.path === "/extract")!.headers["x-client"]).toBe("stock")
    release(extracted())
    await vi.waitFor(async () => expect((await db.col.wireItems.find({ article: { $exists: true } }).toArray()).length).toBe(2), { timeout: 5_000 })
    const docs = await db.col.wireItems.find({}).toArray()
    expect(Object.fromEntries(docs.map((d) => [d.title, d.article?.status]))).toEqual({ "Costco receives $184M in tariff refunds": "ok", "Fed holds rates steady": "skipped" })
    const sources = wire.health().sources
    expect(sources.map((s) => s.id)).toEqual(["rss:a", ENRICH_SOURCE_ID])
    expect(sources[1]).toMatchObject({ state: "ok", items_24h: 1, dropped_24h: 1 })
    wire.stop()
  })
})
