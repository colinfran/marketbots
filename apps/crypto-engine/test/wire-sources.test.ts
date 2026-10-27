import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SETTINGS, settingsSchema } from "@mb/crypto-core/settings"
import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import { binanceAnnouncements, CATALOG, centralBankDecisions, cotItems, githubReleases } from "../src/wire/catalog"
import { WireFetch } from "../src/wire/fetch"
import { diffEntries, diffPoller } from "../src/wire/kinds/diff"
import { headlessPoller, type Rendered } from "../src/wire/kinds/headless"
import { parseFeed } from "../src/wire/kinds/rss"
import { parseStatuspage } from "../src/wire/kinds/statuspage"
import { parseTelegram } from "../src/wire/kinds/telegram"
import { cryptoLexicon } from "../src/wire/lexicon"
import { rateFor } from "../src/wire/limiter"
import { crossingMeta, MetricWatcher, type MetricRule } from "../src/wire/metrics"
import { apewisdomItems, appstoreItems, coinbaseRank, coingeckoItems, fngItems, messageRate, pageviewRatio, stocktwitsRateItems, stocktwitsTrendingItems } from "../src/wire/sources/attention"
import { btcFeeItems, ethGasItems } from "../src/wire/sources/chain"
import { CoinbasePremium } from "../src/wire/sources/coinbase-ws"
import { chainReadings, stableItems, tvlItems } from "../src/wire/sources/defillama"
import { slowmistItems } from "../src/wire/sources/hacks"
import { bithumbAlertItems, bithumbNoticeItems, upbitDescribe, upbitEntries } from "../src/wire/sources/korea"
import { coinalyzeFunding, coinalyzeLiquidations, coinalyzeSymbols, deribitFundingAnnualPct, hyperliquidReadings, krakenFuturesReadings, latestDvol, perpItems } from "../src/wire/sources/derivatives"
import { blsFigures, fredValues, macroActualsPoll, referenceMonth } from "../src/wire/sources/macro-actuals"
import { kalshiFedEvents, kalshiMarkets, polymarketMarkets, swingBase, swingItems, yesProbability } from "../src/wire/sources/odds"
import type { RawItem, SourceContext, SourceSpec } from "../src/wire/types"
import { Wire } from "../src/wire/wire"

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "wire", name), "utf8")
const json = (name: string) => JSON.parse(fixture(name))
const spec = (id: string) => CATALOG.find((s) => s.id === id)!
const NOW = new Date("2026-10-27T12:00:00Z")
const MIN = 60_000
const UNIVERSE = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD", "ADA/USD", "LINK/USD", "AVAX/USD", "LTC/USD", "DOT/USD"]

const makeCtx = ({ clock = { now: NOW }, fetch = {}, env = {}, wire = {} }: { clock?: { now: Date }; fetch?: Partial<Record<"json" | "get" | "postJson", unknown>>; env?: Record<string, string>; wire?: Partial<typeof DEFAULT_SETTINGS.wire> } = {}) =>
  ({
    fetch: fetch as unknown as WireFetch,
    log: silentLogger,
    env,
    symbols: () => ({ universe: UNIVERSE, held: [], focus: [] }),
    now: () => clock.now,
    settings: () => ({ ...DEFAULT_SETTINGS.wire, ...wire }),
  }) satisfies SourceContext

describe("metric watcher", () => {
  const level: MetricRule = { id: "lvl", kind: "level", abs: 100 }

  it("treats the first reading as a baseline and fires once per excursion", () => {
    const w = new MetricWatcher()
    // Already extreme at boot: nothing fires, and this excursion never does.
    expect(w.observe("k", 150, 0, [level])).toEqual([])
    expect(w.observe("k", 160, MIN, [level])).toEqual([])
    // Back below half the threshold, but too soon to re-arm.
    expect(w.observe("k", 20, 2 * MIN, [level])).toEqual([])
    expect(w.observe("k", 120, 3 * MIN, [level])).toEqual([])
    expect(w.observe("k", 20, 20 * MIN, [level])).toEqual([])
    const [c] = w.observe("k", -130, 21 * MIN, [level])
    expect(c).toMatchObject({ key: "k", rule: "lvl", kind: "level", value: -130, exit: false })
    expect(w.observe("k", -140, 22 * MIN, [level])).toEqual([])
    // A reading that isn't newer than the last is ignored.
    expect(w.observe("k", 500, 22 * MIN, [level])).toEqual([])
  })

  it("measures changes within the window from its low or high, one way if asked", () => {
    const w = new MetricWatcher()
    const drop: MetricRule = { id: "drop", kind: "change", windowMin: 60, pct: 15, direction: "down" }
    w.observe("tvl", 100, 0, [drop])
    expect(w.observe("tvl", 110, 10 * MIN, [drop])).toEqual([])
    expect(w.observe("tvl", 130, 20 * MIN, [drop])).toEqual([])
    const [c] = w.observe("tvl", 105, 30 * MIN, [drop])
    expect(c).toMatchObject({ ref: 130, delta: -25, windowMin: 60 })
    expect(c.pct).toBeCloseTo(-19.23, 2)
    // Outside the window the old high no longer counts.
    const w2 = new MetricWatcher()
    w2.observe("tvl", 130, 0, [drop])
    expect(w2.observe("tvl", 100, 61 * MIN, [drop])).toEqual([])
    const pts: MetricRule = { id: "swing", kind: "change", windowMin: 60, points: 15 }
    w2.observe("odds", 40, 0, [pts])
    expect(w2.observe("odds", 56, 30 * MIN, [pts])[0]).toMatchObject({ ref: 40, delta: 16 })
  })

  it("compares spikes with the trailing median, needs enough samples, and skips tiny values", () => {
    const w = new MetricWatcher()
    const spike: MetricRule = { id: "s", kind: "spike", windowMin: 24 * 60, ratio: 5, minSamples: 5, min: 20 }
    for (let i = 0; i < 4; i++) w.observe("fee", 4, i * MIN, [spike])
    expect(w.observe("fee", 40, 4 * MIN, [spike])).toEqual([])
    for (let i = 5; i < 10; i++) w.observe("fee", 4, i * MIN, [spike])
    expect(w.observe("fee", 15, 10 * MIN, [spike])).toEqual([]) // 3.75× and below the floor
    expect(w.observe("fee", 30, 11 * MIN, [spike])[0]).toMatchObject({ ref: 4, ratio: 7.5 })
  })

  it("holds a level for a while, reports exits, and backfills silently", () => {
    const w = new MetricWatcher()
    const held: MetricRule = { id: "p", kind: "level", abs: 0.3, forMin: 5 }
    w.observe("prem", 0.5, 0, [held])
    expect(w.observe("prem", 0.5, 4 * MIN, [held])).toEqual([])
    expect(w.observe("prem", -0.5, 5 * MIN, [held])).toEqual([]) // flipped side: not held
    expect(w.observe("prem", -0.6, 11 * MIN, [held])[0]).toMatchObject({ value: -0.6, windowMin: 5 })
    const extreme: MetricRule = { id: "x", kind: "level", abs: 1, rearmAt: 1, rearmMs: 0, exits: true }
    w.backfill("fng", [{ at: 0, value: 0 }, { at: 1, value: -1 }], [extreme])
    expect(w.observe("fng", -1, 2, [extreme])).toEqual([])
    expect(w.observe("fng", 0, 3, [extreme])).toEqual([expect.objectContaining({ exit: true })])
    expect(w.observe("fng", 1, 4, [extreme])).toEqual([expect.objectContaining({ exit: false, value: 1 })])
  })

  it("keeps memory bounded and marks items as readings", () => {
    const w = new MetricWatcher({ maxPoints: 10, maxKeys: 3 })
    for (let i = 0; i < 50; i++) w.observe("a", i, i, [])
    for (const k of ["b", "c", "d"]) w.observe(k, 1, 1, [])
    expect(w.size).toBe(3)
    expect(w.last("a")).toBeNull()
    const [c] = (() => {
      const x = new MetricWatcher()
      x.observe("m", 0, 0, [{ id: "l", kind: "level", abs: 1 }])
      return x.observe("m", 2, MIN, [{ id: "l", kind: "level", abs: 1 }])
    })()
    expect(crossingMeta(c)).toMatchObject({ metric: "m", rule: "l", value: 2 })
  })
})

describe("wave-2 feeds and catalog parsers", () => {
  it("parses the new outlets' feeds", () => {
    for (const f of ["rss-bitcoinmagazine.xml", "rss-dlnews.xml", "rss-beincrypto.xml", "blog-kraken.xml"]) {
      const items = parseFeed(fixture(f))
      expect(items.length).toBeGreaterThanOrEqual(2)
      for (const i of items) expect(i).toMatchObject({ title: expect.any(String), url: expect.stringMatching(/^https:\/\//), publishedAt: expect.any(Date) })
    }
  })

  it("keeps final client releases only, tagged to their chain", () => {
    const ctx = makeCtx()
    const btc = githubReleases("BTC", "Bitcoin Core")(parseFeed(fixture("gh-bitcoin.xml")), ctx)
    expect(btc.map((i) => i.title)).not.toContainEqual(expect.stringMatching(/rc\d/))
    expect(btc[0]).toMatchObject({ title: "v32.1: Bitcoin Core 32.1 final", symbols: ["BTC/USD"], category: "upgrade", baseSeverity: 20, summary: null })
    expect(btc.find((i) => /v32\.0:/.test(i.title))).toMatchObject({ baseSeverity: 30 })
    const xrp = githubReleases("XRP", "rippled (XRP Ledger)")(parseFeed(fixture("gh-rippled.xml")), ctx)
    expect(xrp.map((i) => i.title)).toEqual(["rippled (XRP Ledger) release 3.4.1"])
    expect(spec("gh:geth")).toMatchObject({ kind: "rss", tier: 1, category_hint: "upgrade" })
  })

  it("keeps only central-bank rate decisions, market-wide", () => {
    expect(centralBankDecisions(parseFeed(fixture("cb-boe.xml")))).toEqual([])
    const kept = centralBankDecisions([{ title: "Bank Rate reduced to 3.75% - November 2026" }, { title: "Monetary policy decisions" }, { title: "Statement on Monetary Policy" }, { title: "Monetary Policy Committee dates for 2027" }])
    expect(kept.map((i) => i.title)).toEqual(["Bank Rate reduced to 3.75% - November 2026", "Monetary policy decisions", "Statement on Monetary Policy"])
    expect(kept[0]).toMatchObject({ symbols: [], marketWide: true, category: "macro_release", kind: "macro" })
  })

  it("drops Binance promotions and plumbing, and files listings", () => {
    const items = binanceAnnouncements(parseTelegram(fixture("telegram-binance.html"), "binance_announcements"))
    expect(items.map((i) => i.sourceId)).toEqual(["binance_announcements/9068"])
    expect(items[0].marketWide).toBe(false)
    expect(binanceAnnouncements([{ title: "Binance Will List Chainlink (LINK) with Seed Tag Applied" }])[0]).toMatchObject({ category: "listing_major", polarity: 1 })
    expect(spec("binance_announcements")).toMatchObject({ kind: "telegram", channel: "binance_announcements", tier: 1 })
  })

  it("maps Federal Register documents, GDELT articles and the CFTC report", () => {
    const ctx = makeCtx()
    // The fixture holds a paperwork notice (dropped) and a final rule (kept at the regulatory base).
    const fr = spec("fedreg").map!(json("fedreg.json"), ctx)
    expect(fr).toHaveLength(1)
    expect(fr[0]).toMatchObject({ sourceId: expect.any(String), url: expect.stringMatching(/^https:\/\/www\.federalregister\.gov\//), publishedAt: expect.any(Date), meta: { document_type: "Rule" } })
    expect(fr[0].baseSeverity).toBeUndefined()
    const proposed = spec("fedreg").map!({ results: [{ document_number: "1", title: "Crypto Asset Custody", type: "Proposed Rule", html_url: "https://www.federalregister.gov/d/1", publication_date: "2026-10-26" }, { document_number: "2", title: "Digital asset notice", type: "Notice", html_url: "https://www.federalregister.gov/d/2", publication_date: "2026-10-26" }] }, ctx)
    expect(proposed.map((d) => d.baseSeverity)).toEqual([50, 35])
    const gd = spec("gdelt").map!({ articles: [{ url: "https://x.test/a", title: "Bitcoin ETF flows", seendate: "20261027T023000Z", domain: "x.test", language: "English" }] }, ctx)
    expect(gd[0]).toMatchObject({ title: "Bitcoin ETF flows", publishedAt: new Date("2026-10-27T02:30:00Z") })
    expect(spec("gdelt").url).toContain("sourcelang%3Aenglish")
    const rows = json("cot.json")
    const eth = { ...rows[1], market_and_exchange_names: "ETHER CASH SETTLED - CHICAGO MERCANTILE EXCHANGE", contract_market_name: "ETHER CASH SETTLED" }
    const cot = cotItems([...rows, eth], ctx)
    expect(cot.map((i) => i.symbols)).toEqual([["BTC/USD"], ["ETH/USD"]])
    // 5,466 − 10,408 leveraged-fund contracts, change −54 − (−956).
    expect(cot[0]).toMatchObject({ sourceId: "2026-10-20:BTC", baseSeverity: 20, meta: expect.objectContaining({ lev_net: -4_942, lev_net_change: 902, asset_mgr_net: 2_999 }) })
    expect(cot[0].title).toContain("leveraged funds net -4,942 contracts (+902 on the week)")
  })

  it("diffs Coinbase products: universe listings and status changes only", async () => {
    const body = json("coinbase-products.json")
    expect([...spec("coinbase_products").entries!(body).keys()]).toEqual(["ETH/USD", "SOL/USD", "SENT/USD"])
    const next = structuredClone(body)
    next.push({ ...body[0], id: "LINK-USD", base_currency: "LINK" }, { ...body[0], id: "NEW-USD", base_currency: "NEW" })
    next[1].trading_disabled = true
    const json_ = vi.fn().mockResolvedValueOnce(body).mockResolvedValueOnce(next)
    const poll = diffPoller(spec("coinbase_products"), makeCtx({ fetch: { json: json_ } }))
    expect(await poll()).toEqual([])
    const items = (await poll())!
    expect(items).toEqual([
      expect.objectContaining({ symbols: ["SOL/USD"], category: "venue_status", polarity: -1, title: "Coinbase SOL/USD status changed from online to online, trading disabled" }),
      expect.objectContaining({ symbols: ["LINK/USD"], category: "listing_major", polarity: 1 }),
    ])
  })

  it("reads Solana's status page", () => {
    expect(parseStatuspage(json("solana-status.json"), "status_solana", NOW)).toEqual([])
    const incident = parseStatuspage({ page: { name: "Solana" }, incidents: [{ id: "i1", name: "Mainnet Beta degraded performance", status: "investigating", impact: "major", updated_at: NOW.toISOString(), created_at: NOW.toISOString() }] }, "status_solana", NOW)
    expect(cryptoLexicon.tag(incident[0].title, UNIVERSE)).toEqual(["SOL/USD"])
  })
})

describe("derivatives sources", () => {
  it("reads Kraken Futures linear perps (XBT is bitcoin) and Hyperliquid contexts", () => {
    const universe = new Map(UNIVERSE.map((s) => [s.split("/")[0], s]))
    const kf = krakenFuturesReadings(json("kraken-futures.json"), universe)
    expect(kf.map((r) => r.symbol).sort()).toEqual(["BTC/USD", "DOT/USD", "ETH/USD", "SOL/USD"])
    const btc = kf.find((r) => r.symbol === "BTC/USD")!
    expect(btc.fundingAnnualPct).toBeCloseTo(11.94, 1)
    expect(btc.openInterestUsd).toBeGreaterThan(1e8)
    const hl = hyperliquidReadings(json("hyperliquid.json"), universe)
    expect(hl.map((r) => r.symbol)).toEqual(["BTC/USD", "ETH/USD", "SOL/USD"])
    expect(hl[2].fundingAnnualPct).toBeCloseTo(10.95, 2)
    expect(() => hyperliquidReadings({}, universe)).toThrow(/unexpected/)
  })

  it("turns extreme funding and open-interest jumps into items, never on the first poll", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    const venue = { id: "hyperliquid", label: "Hyperliquid", url: () => "https://app.hyperliquid.xyz" }
    const read = (funding: number, oi: number) => [{ symbol: "SOL/USD", fundingAnnualPct: funding, openInterest: oi, openInterestUsd: oi * 200 }]
    // Extreme at boot: a baseline, not news.
    expect(perpItems(venue, read(150, 1e6), w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + MIN)
    expect(perpItems(venue, read(40, 1e6), w, ctx)).toEqual([])
    // Back to normal for 15 minutes re-arms it.
    clock.now = new Date(NOW.getTime() + 16 * MIN)
    expect(perpItems(venue, read(40, 1e6), w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + 20 * MIN)
    const items = perpItems(venue, read(130, 1.3e6), w, ctx)
    expect(items.map((i) => i.meta!.signal)).toEqual(["funding", "open_interest"])
    expect(items[0]).toMatchObject({ title: "SOL/USD perp funding at +130%/yr on Hyperliquid (longs pay shorts)", category: "funding_extreme", kind: "derivatives", symbols: ["SOL/USD"], meta: expect.objectContaining({ metric: "hyperliquid:funding:SOL/USD" }) })
    expect(items[1].title).toBe("SOL/USD open interest on Hyperliquid up 30% in 60 min ($260.0M)")
    // A thin market's funding is ignored.
    expect(perpItems(venue, [{ symbol: "DOT/USD", fundingAnnualPct: 900, openInterest: 1, openInterestUsd: 1e5 }], w, ctx)).toEqual([])
  })

  it("reads Deribit DVOL and funding, and Coinalyze markets, funding and liquidations", () => {
    expect(latestDvol(json("deribit-dvol.json"))).toBe(38.17)
    expect(deribitFundingAnnualPct(json("deribit-perp.json"))).toBeCloseTo(7.28, 2)
    const symbols = coinalyzeSymbols(json("coinalyze-markets.json"), ["BTC", "ETH", "SOL"])
    expect(Object.fromEntries(symbols)).toEqual({ BTC: ["BTCUSDT.6", "BTCUSDT_PERP.A"], ETH: ["ETHUSDT_PERP.A"] })
    const bySymbol = new Map([["BTCUSDT_PERP.A", "BTC"], ["ETHUSDT_PERP.A", "ETH"]])
    const funding = coinalyzeFunding(json("coinalyze-funding.json"), bySymbol)
    expect(funding.get("BTC")).toBeCloseTo(10.95, 2)
    const liq = coinalyzeLiquidations(json("coinalyze-liq.json"), bySymbol, 1793067000 * 1000)
    expect(liq.get("BTC")!.longs).toBeCloseTo(7605.12 + 187830.565 + 3035.307 + 12058.8751, 2)
  })

  it("runs as a polled source: baseline first, then only what crossed", async () => {
    const body = json("kraken-futures.json")
    const hot = structuredClone(body)
    hot.tickers.find((t: { symbol: string }) => t.symbol === "PF_SOLUSD").relativeFundingRate = 0.0002
    const json_ = vi.fn().mockResolvedValueOnce(body).mockResolvedValue(hot)
    const clock = { now: NOW }
    const ctx = makeCtx({ clock, fetch: { json: json_ } })
    const source = spec("kraken_futures").create!(spec("kraken_futures"), ctx)
    const emit = vi.fn(async (_items: RawItem[], _opts?: { backfill?: boolean }) => undefined)
    await (source as unknown as { tick: (e: typeof emit) => Promise<void> }).tick(emit)
    expect(emit).not.toHaveBeenCalled()
    clock.now = new Date(NOW.getTime() + MIN)
    await (source as unknown as { tick: (e: typeof emit) => Promise<void> }).tick(emit)
    expect(emit).toHaveBeenCalledWith([expect.objectContaining({ symbols: ["SOL/USD"], title: expect.stringContaining("+175%/yr on Kraken Futures") })], { backfill: false })
  })
})

describe("DefiLlama", () => {
  it("maps chains to universe assets and watches big other chains market-wide", () => {
    const readings = chainReadings(json("defillama-chains.json"), new Map(UNIVERSE.map((s) => [s.split("/")[0], s])))
    // Litecoin's chain is too small to watch; Base has no universe asset but is big.
    expect(readings.map((r) => [r.chain, r.symbol]).sort()).toEqual([
      ["Base", null],
      ["Ethereum", "ETH/USD"],
      ["Solana", "SOL/USD"],
    ])
  })

  it("flags a TVL drop within an hour, and large stablecoin supply changes", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    const chains = json("defillama-chains.json")
    expect(tvlItems(chains, w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + 30 * MIN)
    const solana = chains.map((c: { name: string; tvl: number }) => (c.name === "Solana" ? { ...c, tvl: c.tvl * 0.8 } : c))
    const [item] = tvlItems(solana, w, ctx)
    expect(item).toMatchObject({ symbols: ["SOL/USD"], category: "tvl_drop", polarity: -1, title: expect.stringMatching(/^Solana TVL down 20% in 60 min/) })
    const stables = json("defillama-stables.json")
    const w2 = new MetricWatcher()
    expect(stableItems(stables, w2, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + 60 * MIN)
    stables.peggedAssets[0].circulating.peggedUSD = stables.peggedAssets[0].circulatingPrevDay.peggedUSD + 1.5e9
    expect(stableItems(stables, w2, ctx)).toEqual([expect.objectContaining({ title: expect.stringMatching(/^USDT supply up \$1\.5B in 24 h/), marketWide: true, baseSeverity: 25, polarity: 1 })])
  })
})

describe("prediction markets", () => {
  it("selects liquid Fed markets and crypto-policy markets, never price bets", () => {
    const fed = polymarketMarkets(json("polymarket-fed.json"), "fed", NOW)
    expect(fed).toHaveLength(3)
    expect(fed[2]).toMatchObject({ prob: expect.closeTo(93.55, 5), group: "polymarket:606422", fed: true })
    expect(polymarketMarkets(json("polymarket-crypto.json"), "crypto", NOW)).toEqual([])
    const policy = [{ id: "e", slug: "sol-etf", title: "SOL ETF", markets: [{ id: "m", question: "Will the SEC approve a spot Solana ETF by December 31?", outcomes: '["Yes", "No"]', outcomePrices: '["0.4", "0.6"]', liquidityNum: 60_000, volume24hr: 9_000 }] }]
    expect(polymarketMarkets(policy, "crypto", NOW)).toEqual([expect.objectContaining({ prob: expect.closeTo(40, 5), fed: false })])
    const thin = structuredClone(policy)
    thin[0].markets[0].liquidityNum = 5_000
    expect(polymarketMarkets(thin, "crypto", NOW)).toEqual([])
    expect(yesProbability({ outcomes: '["No", "Yes"]', outcomePrices: '["0.7", "0.3"]' })).toBeCloseTo(30)
  })

  it("reads Kalshi KXFED for the next two meetings, liquid strikes only", () => {
    expect(kalshiFedEvents(NOW)).toEqual(["KXFED-26OCT", "KXFED-26DEC"])
    expect(kalshiMarkets(json("kalshi-fed.json").markets)).toEqual([expect.objectContaining({ key: "kalshi:KXFED-27DEC-T5.50", prob: expect.closeTo(22, 5) })])
  })

  it("reports the biggest swing per event, scaled by its size", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    const m = (key: string, prob: number) => ({ key, group: "polymarket:1", question: `Q ${key}`, prob, url: "https://polymarket.com/event/x", fed: true, venue: "Polymarket" as const })
    expect(swingItems([m("a", 90), m("b", 8)], w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + 20 * MIN)
    const items = swingItems([m("a", 60), m("b", 35)], w, ctx)
    expect(items).toEqual([expect.objectContaining({ title: "Polymarket odds: Q a 90% → 60% in 60 min", category: "odds_swing", symbols: [], marketWide: true, baseSeverity: 80 })])
    expect(swingBase(40, 15)).toBe(100)
  })
})

describe("attention sources", () => {
  const universe = new Map(UNIVERSE.map((s) => [s.split("/")[0], s]))
  const later = (clock: { now: Date }, min: number) => (clock.now = new Date(NOW.getTime() + min * MIN))

  it("ApeWisdom mention jumps need a floor and a 3× rise", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    const body = json("apewisdom.json")
    expect(apewisdomItems(body, w, ctx)).toEqual([])
    later(clock, 15)
    expect(apewisdomItems({ results: [{ ticker: "XRP.X", name: "XRP", rank: 1, mentions: 12, mentions_24h_ago: 2 }] }, w, ctx)).toEqual([])
    later(clock, 30)
    expect(apewisdomItems({ results: [{ ticker: "XRP.X", name: "XRP", rank: 1, mentions: 90, mentions_24h_ago: 20 }] }, w, ctx)).toEqual([
      expect.objectContaining({ symbols: ["XRP/USD"], category: "sentiment_spike", tier: 3, title: "XRP/USD: 90 Reddit/4chan mentions in 24 h, 4.5× the day before (ApeWisdom)" }),
    ])
  })

  it("StockTwits trending entries and message-rate spikes", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    expect(stocktwitsTrendingItems(json("stocktwits-trending.json"), w, ctx)).toEqual([])
    later(clock, 3)
    expect(stocktwitsTrendingItems({ symbols: [{ symbol: "NVDA" }, { symbol: "ETH.X" }] }, w, ctx)).toEqual([expect.objectContaining({ symbols: ["ETH/USD"], title: "ETH/USD enters StockTwits trending (#2 of 2)" })])
    const messages = json("stocktwits-btc.json").messages
    expect(messageRate(messages)).toBeCloseTo(4 / ((Date.parse(messages[0].created_at) - Date.parse(messages[4].created_at)) / 3_600_000), 5)
    const at = (i: number, perHour: number) => ({ messages: Array.from({ length: 30 }, (_, k) => ({ id: k, created_at: new Date(NOW.getTime() + i * 3 * MIN - (k * 3_600_000) / perHour).toISOString() })) })
    for (let i = 0; i < 40; i++) {
      clock.now = new Date(NOW.getTime() + i * 3 * MIN)
      expect(stocktwitsRateItems("BTC", at(i, 40), w, ctx)).toEqual([])
    }
    clock.now = new Date(NOW.getTime() + 40 * 3 * MIN)
    expect(stocktwitsRateItems("BTC", at(40, 400), w, ctx)).toEqual([expect.objectContaining({ symbols: ["BTC/USD"], title: expect.stringMatching(/^BTC\/USD: StockTwits message rate 400\/h, 10\.0× its 24-hour median$/) })])
  })

  it("CoinGecko trending entries, once per absence", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    const body = json("coingecko-trending.json")
    expect(coingeckoItems(body, w, ctx)).toEqual([])
    const sol = { coins: [{ item: { id: "solana", symbol: "SOL", name: "Solana" } }] }
    later(clock, 15)
    expect(coingeckoItems(sol, w, ctx)).toEqual([expect.objectContaining({ symbols: ["SOL/USD"], title: "SOL/USD is trending on CoinGecko (#1 of 1)" })])
    later(clock, 30)
    coingeckoItems({ coins: [] }, w, ctx)
    later(clock, 45)
    expect(coingeckoItems(sol, w, ctx)).toEqual([]) // back within 6 h: not new
  })

  it("App Store: Coinbase entering the top 100 or climbing the Finance chart", () => {
    expect(coinbaseRank(json("appstore-top.json"))).toBeNull()
    expect(coinbaseRank(json("appstore-finance.json"))).toBeNull()
    const top = (rank: number | null) => ({ feed: { results: Array.from({ length: 100 }, (_, i) => (rank === i + 1 ? { id: "886427730", name: "Coinbase: Buy Bitcoin & Ether" } : { id: String(i), name: `App ${i}` })) } })
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const chart = { id: "top", label: "top 100 free apps", url: "", rules: [{ id: "entry", kind: "level", abs: 1, rearmMs: 24 * 3_600_000 }, { id: "climb", kind: "change", windowMin: 24 * 60, points: 25, direction: "up" }] as MetricRule[] }
    // Entering the chart is one item (not also a climb).
    const w = new MetricWatcher()
    expect(appstoreItems(chart, top(null), w, ctx)).toEqual([])
    later(clock, 60)
    expect(appstoreItems(chart, top(60), w, ctx)).toEqual([expect.objectContaining({ title: "Coinbase app enters the US App Store top 100 free apps (#60)", marketWide: true, symbols: [] })])
    // Already on the chart: a climb of 30 places.
    clock.now = NOW
    const w2 = new MetricWatcher()
    expect(appstoreItems(chart, top(80), w2, ctx)).toEqual([])
    later(clock, 60)
    expect(appstoreItems(chart, top(50), w2, ctx)).toEqual([expect.objectContaining({ title: "Coinbase app up 30 places in 24 h to #50 in the US App Store top 100 free apps" })])
  })

  it("Wikipedia views against the 4-week median, and Fear & Greed extremes", () => {
    const body = json("wikipedia.json")
    const r = pageviewRatio(body)!
    expect(r).toMatchObject({ views: 2044, at: Date.UTC(2026, 9, 25), median: (2071 + 2235) / 2 })
    expect(r.ratio).toBeCloseTo(2044 / 2153, 3)
    const ctx = makeCtx()
    const w = new MetricWatcher()
    expect(fngItems(json("fng.json"), w, ctx)).toEqual([])
    expect(fngItems({ data: [{ value: "18", value_classification: "Extreme Fear", timestamp: "1793145600" }] }, w, ctx)).toEqual([expect.objectContaining({ title: "Crypto Fear & Greed index enters Extreme Fear: 18", marketWide: true })])
    expect(fngItems({ data: [{ value: "18", value_classification: "Extreme Fear", timestamp: "1793145600" }] }, w, ctx)).toEqual([])
    expect(fngItems({ data: [{ value: "30", value_classification: "Fear", timestamp: "1793232000" }] }, w, ctx)).toEqual([expect.objectContaining({ title: "Crypto Fear & Greed index leaves the extreme: 30 (Fear)" })])
    void universe
  })
})

describe("chain and macro", () => {
  it("flags fee spikes far above the day's median, and surfaces Etherscan errors", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    for (let i = 0; i < 12; i++) {
      clock.now = new Date(NOW.getTime() + i * 5 * MIN)
      expect(btcFeeItems(json("mempool-fees.json"), w, ctx)).toEqual([])
    }
    clock.now = new Date(NOW.getTime() + 60 * MIN)
    expect(btcFeeItems({ fastestFee: 45 }, w, ctx)).toEqual([expect.objectContaining({ symbols: ["BTC/USD"], category: "volume_shock", baseSeverity: 20, title: "Bitcoin network fees at 45 sat/vB, 22.5× the 24-hour median (mempool.space)" })])
    expect(ethGasItems(json("etherscan-gas.json"), w, ctx)).toEqual([])
    expect(() => ethGasItems({ status: "0", message: "NOTOK", result: "Max rate limit reached" }, w, ctx)).toThrow(/rate limit/)
  })

  it("reads BLS and FRED for the reference month", () => {
    expect(referenceMonth("CPI (October 2026)")).toEqual({ year: 2026, month: 10 })
    expect(referenceMonth("FOMC rate decision")).toBeNull()
    const bls = json("bls.json")
    // The fixture holds only the latest month: no year-ago CPI or previous payrolls yet.
    expect(blsFigures("cpi", bls, { year: 2026, month: 9 })).toBeNull()
    bls.Results.series[0].data.push({ year: "2025", period: "M09", value: "326.000" })
    bls.Results.series[1].data.push({ year: "2026", period: "M08", value: "158900" })
    expect(blsFigures("cpi", bls, { year: 2026, month: 9 })!.map((f) => f.text)).toEqual(["3.4% y/y"])
    expect(blsFigures("jobs", bls, { year: 2026, month: 9 })!.map((f) => f.text)).toEqual(["payrolls +144K", "unemployment 4.2%"])
    expect(blsFigures("cpi", bls, { year: 2026, month: 10 })).toBeNull()
    expect(() => blsFigures("cpi", { status: "REQUEST_NOT_PROCESSED", message: ["daily threshold"] }, { year: 2026, month: 9 })).toThrow(/threshold/)
    expect(fredValues(json("fred.json"), { year: 2026, month: 9 })).toEqual([336.298, 334.131])
    expect(fredValues(json("fred.json"), { year: 2026, month: 10 })).toBeNull()
  })

  it("polls only in a release window, until the new number appears, with the forecast", async () => {
    const release = { kind: "cpi" as const, title: "CPI (September 2026)", at: new Date("2026-10-27T12:30:00Z"), source: "bls" }
    const clock = { now: NOW }
    const bls = json("bls.json")
    bls.Results.series[0].data.push({ year: "2025", period: "M09", value: "326.000" })
    const old = structuredClone(bls)
    old.Results.series[0].data = [{ year: "2026", period: "M08", value: "335.000" }]
    const postJson = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(bls)
    const ff = [
      { title: "CPI m/m", country: "USD", date: "2026-10-27T08:30:00-04:00", forecast: "0.3%" },
      { title: "CPI y/y", country: "USD", date: "2026-10-27T08:30:00-04:00", forecast: "3.2%" },
      { title: "CPI y/y", country: "EUR", date: "2026-10-27T08:30:00-04:00", forecast: "9%" },
    ]
    const jsonFetch = vi.fn(async (url: string) => (url.includes("stlouisfed") ? json("fred.json") : url.includes("faireconomy") ? ff : null))
    const poll = macroActualsPoll(makeCtx({ clock, fetch: { postJson, json: jsonFetch }, env: { BLS_API_KEY: "k", FRED_API_KEY: "f" } }), [release])
    expect(await poll()).toEqual([])
    expect(postJson).not.toHaveBeenCalled()
    clock.now = new Date("2026-10-27T12:30:30Z")
    expect(await poll()).toEqual([])
    clock.now = new Date("2026-10-27T12:31:00Z")
    const [item] = await poll()
    expect(item).toMatchObject({ sourceId: "cpi:2026-09", title: "CPI (September 2026): 0.6% m/m (forecast 0.3%), 3.4% y/y (forecast 3.2%)", category: "macro_release", kind: "macro", tier: 1, marketWide: true })
    expect(item.meta).toMatchObject({ cpi_yoy: 3.36, cpi_yoy_forecast: "3.2%", cpi_yoy_surprise: 0.16 })
    expect(postJson.mock.calls[0][1]).toMatchObject({ seriesid: ["CUUR0000SA0"], startyear: "2025", endyear: "2026", registrationkey: "k" })
    clock.now = new Date("2026-10-27T12:32:00Z")
    expect(await poll()).toEqual([])
    expect(postJson).toHaveBeenCalledTimes(2)
  })
})

describe("Coinbase premium", () => {
  it("needs a premium held for 5 minutes and reports it once", () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
    expect(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, wire: { ...DEFAULT_SETTINGS.wire, coinbase_premium_pct: 0 } }).success).toBe(false)
    const cb = new CoinbasePremium((s) => (s === "BTC/USD" ? 80_000 : null), () => DEFAULT_SETTINGS, silentLogger)
    const items: RawItem[][] = []
    const t0 = NOW.getTime()
    for (let i = 0; i <= 12; i++) {
      const at = t0 + i * 30_000
      cb.handle(JSON.stringify({ type: "ticker", product_id: "BTC-USD", best_bid: "80300", best_ask: "80320", price: "80310" }), at)
      items.push(cb.check(at))
    }
    expect(items.slice(0, 10).flat()).toEqual([])
    expect(items[10]).toEqual([expect.objectContaining({ symbols: ["BTC/USD"], category: "coinbase_premium", polarity: 1, title: "Coinbase premium on BTC/USD: +0.39% vs Kraken for 5+ min" })])
    expect(items.slice(11).flat()).toEqual([])
    cb.handle("not json")
    cb.handle(JSON.stringify({ type: "error", message: "Failed to subscribe", reason: "bad product" }))
    expect(cb.health()).toMatchObject({ id: "coinbase_ws", state: "disabled", last_error: "Failed to subscribe: bad product" })
    expect(DEFAULT_SETTINGS.wire.coinbase_premium_pct).toBe(0.3)
  })
})

describe("wave-2 plumbing", () => {
  it("spaces GDELT requests 5 s apart, POSTs JSON queries, and registers every wave-2 source", async () => {
    expect(rateFor("api.gdeltproject.org")).toEqual({ key: "gdeltproject.org", rate: { capacity: 1, perSecond: 0.2 } })
    const request = vi.fn(async () => ({ status: 200, text: '{"ok":true}', headers: new Headers() }))
    const f = new WireFetch({ take: async () => undefined }, "Test/1 a@b.c", request)
    expect(await f.postJson("https://api.hyperliquid.xyz/info", { type: "metaAndAssetCtxs" })).toEqual({ ok: true })
    expect(request.mock.calls[0]).toEqual(["https://api.hyperliquid.xyz/info", expect.objectContaining({ method: "POST", body: '{"type":"metaAndAssetCtxs"}', attempts: 1, headers: expect.objectContaining({ "user-agent": "Test/1 a@b.c", "content-type": "application/json" }) })])
    const ids = CATALOG.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ["coinbase_products", "kraken_futures", "hyperliquid", "deribit", "defillama", "defillama:stables", "odds:polymarket", "odds:kalshi", "fng", "coingecko", "chain:btc_fees", "chain:eth_gas", "status_solana", "gh:bitcoin", "rss:bitcoinmagazine", "rss:unchained", "binance_announcements", "macro_actuals", "fedreg", "coinalyze", "apewisdom", "gdelt", "appstore", "wikipedia", "blog:kraken", "cb:ecb", "cb:boe", "cb:boj", "cot", "stocktwits"]) {
      expect(ids).toContain(id)
    }
    const tiers = (prefix: string) => CATALOG.filter((s: SourceSpec) => s.id.startsWith(prefix)).map((s) => `${s.id}:${s.tier}`)
    expect(tiers("rss:").filter((t) => /bitcoinmagazine|cryptoslate|dlnews|protos|unchained/.test(t))).toEqual(["rss:bitcoinmagazine:2", "rss:cryptoslate:2", "rss:dlnews:2", "rss:protos:2", "rss:unchained:2"])
    expect(tiers("rss:").filter((t) => /cryptobriefing|beincrypto|bitcoinist|newsbtc|dailyhodl/.test(t)).every((t) => t.endsWith(":3"))).toBe(true)
  })

  it("keeps the government DOGE out of Dogecoin", () => {
    expect(cryptoLexicon.tag("Elon Musk's DOGE Staffers Went From Jobless to Hacking Anthropic", UNIVERSE)).toEqual([])
    expect(cryptoLexicon.tag("Department of Government Efficiency (DOGE) cuts more contracts", UNIVERSE)).toEqual([])
    expect(cryptoLexicon.tag("DOGE jumps 12% as Musk teases X payments", UNIVERSE)).toEqual(["DOGE/USD"])
    expect(cryptoLexicon.tag("Dogecoin rallies while DOGE staffers testify", UNIVERSE)).toEqual(["DOGE/USD"])
  })
})

describe("headless sources (scraper sidecar)", () => {
  const page = (over: Partial<SourceSpec> = {}): SourceSpec => ({ id: "headless:test", kind: "headless", url: "https://js.test/list", interval_s: 600, tier: 3, default_enabled: true, ...over })
  const rendered = (over: Partial<Rendered> = {}): Rendered => ({ status: 200, url: "https://js.test/list", html: "", captured: [], ...over })
  const env = { SCRAPER_URL: "http://scraper:8790/" }

  it("sends the render job to the sidecar and reads the rendered HTML with selectors", async () => {
    const postJson = vi.fn(async () => rendered({ html: '<ul><li class="row"><a href="/n/1">Upbit lists XRP</a><time datetime="2026-10-27T11:00:00Z"></time></li></ul>' }))
    const items = await headlessPoller(page({ selectors: { item: "li.row", title: "a", time: "time" }, render: { wait_for: "li.row", timeout_ms: 20_000 } }), makeCtx({ fetch: { postJson }, env }))()
    expect(postJson).toHaveBeenCalledWith("http://scraper:8790/render", { url: "https://js.test/list", wait_for: "li.row", timeout_ms: 20_000, capture: [] }, { timeoutMs: 50_000 })
    expect(items).toEqual([{ title: "Upbit lists XRP", url: "https://js.test/n/1", summary: null, publishedAt: new Date("2026-10-27T11:00:00Z") }])
  })

  it("hands the page's captured JSON responses to map", async () => {
    const captured = [{ url: "https://js.test/api/notices?page=1", status: 200, body: JSON.stringify({ notices: [{ id: 7, title: "Investment warning: XYZ" }] }) }]
    const postJson = vi.fn(async () => rendered({ captured }))
    const map = vi.fn((body: unknown) => (body as typeof captured).flatMap((c) => (JSON.parse(c.body) as { notices: { id: number; title: string }[] }).notices.map((n): RawItem => ({ sourceId: String(n.id), title: n.title }))))
    const items = await headlessPoller(page({ render: { capture: ["/api/notices"] }, map }), makeCtx({ fetch: { postJson }, env }))()
    expect(postJson).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ capture: ["/api/notices"], wait_for: null, timeout_ms: 30_000 }), expect.anything())
    expect(items).toEqual([{ sourceId: "7", title: "Investment warning: XYZ" }])
  })

  it("treats the site's own 403 as a block, so the source degrades like a plain fetch", async () => {
    const postJson = vi.fn(async () => rendered({ status: 403, html: "<title>Access denied</title>" }))
    await expect(headlessPoller(page({ mapHtml: () => [] }), makeCtx({ fetch: { postJson }, env }))()).rejects.toMatchObject({ status: 403 })
  })

  it("needs a way to read the page, and stays off without a sidecar", () => {
    expect(() => headlessPoller(page(), makeCtx({ env }))).toThrow(/needs map/)
    expect(() => headlessPoller(page({ render: { capture: ["/api"] }, mapHtml: () => [] }), makeCtx({ env }))).toThrow(/needs map/)
    const spec = page({ mapHtml: () => [] })
    const wireWith = (e: Record<string, string>) => new Wire({ col: {} as never, bus: {} as never, log: silentLogger, settings: () => DEFAULT_SETTINGS.wire, catalog: [spec], lexicon: cryptoLexicon, env: e, symbols: () => ({ universe: UNIVERSE, held: [], focus: [] }), price: () => null, userAgent: "test" })
    expect(wireWith({}).disabledReason(spec)).toMatch(/SCRAPER_URL not set/)
    expect(wireWith(env).disabledReason(spec)).toBeNull()
  })
})

describe("wave 3: Korean exchanges and SlowMist", () => {
  const KOREAN = ["INIT/USD", "EGLD/USD", "FET/USD", "XAI/USD", "CAMP/USD", "ZK/USD", "AXIS/USD", "CTR/USD", "GAS/USD", "CSPR/USD", "XEC/USD"]
  const koreanCtx = (now = NOW) => ({ ...makeCtx({ clock: { now } }), symbols: () => ({ universe: KOREAN, held: [], focus: [] }) })

  it("Upbit: diffs KRW markets and reports warnings, cautions and removals for universe coins only", () => {
    const before = upbitEntries(json("korea-upbit-markets.json"))
    expect([...before.keys()].every((k) => k.startsWith("KRW-"))).toBe(true)
    expect(before.has("KRW-XRP")).toBe(true)
    const markets = json("korea-upbit-markets.json") as { market: string; market_event: { warning: boolean; caution: Record<string, boolean> } }[]
    const xrp = markets.find((m) => m.market === "KRW-XRP")!
    xrp.market_event.warning = true
    const sol = markets.find((m) => m.market === "KRW-SOL")!
    sol.market_event.caution.DEPOSIT_AMOUNT_SOARING = true
    const fil = markets.find((m) => m.market === "KRW-FIL")!
    fil.market_event.warning = true
    const after = upbitEntries(markets.filter((m) => m.market !== "KRW-DOGE"))
    const items = diffEntries(before, after)
      .map((c) => upbitDescribe(c, makeCtx()))
      .filter((i): i is RawItem => i !== null)
    expect(items.map((i) => [i.symbols, i.category, i.polarity, i.baseSeverity, i.title])).toEqual([
      [["XRP/USD"], "venue_status", -1, 60, "Upbit designates XRP (XRP) an investment warning"],
      [["SOL/USD"], "general", 0, 25, "Upbit flags Solana (SOL) for deposits soaring"],
      [["DOGE/USD"], "venue_status", -1, 75, "Upbit removes Dogecoin (DOGE) from its KRW market"],
    ])
    expect(items[0].sourceId).toBe("KRW-XRP|warning|2026-10-27")
  })

  it("Bithumb notices: classifies by category, tags tickers in parentheses, drops promotions", () => {
    const items = bithumbNoticeItems(json("korea-bithumb-notices.json"), koreanCtx())
    const by = (t: string) => items.find((i) => i.title.includes(t))!
    expect(by("이니시아(INIT) 거래유의종목 지정")).toMatchObject({ symbols: ["INIT/USD"], category: "venue_status", polarity: -1, baseSeverity: 60, title: "Bithumb (trading caution): 이니시아(INIT) 거래유의종목 지정" })
    expect(by("거래유의종목 지정 연장")).toMatchObject({ symbols: ["EGLD/USD", "FET/USD"], category: "venue_status" })
    expect(by("자이(XAI)")).toMatchObject({ category: "general", polarity: 1, baseSeverity: 30 })
    expect(by("캠프 네트워크(CAMP)")).toMatchObject({ category: "venue_status", polarity: -1, baseSeverity: 75 })
    expect(by("지케이싱크(ZK)")).toMatchObject({ category: "general", polarity: 0, baseSeverity: 20, publishedAt: new Date("2026-10-26T07:10:00Z") })
    expect(by("유의 촉구")).toMatchObject({ symbols: ["INIT/USD"], polarity: -1, baseSeverity: 35 })
    expect(items.some((i) => i.title.includes("에어드랍 이벤트"))).toBe(false)
    expect(bithumbNoticeItems(json("korea-bithumb-notices.json"), makeCtx())).toEqual([])
  })

  it("Bithumb alerts: one item per market, type, step and end date, for universe coins only", () => {
    const items = bithumbAlertItems(json("korea-bithumb-alerts.json"), koreanCtx())
    const cspr = items.filter((i) => i.symbols?.[0] === "CSPR/USD")
    expect(cspr.map((i) => i.title)).toEqual([
      "Bithumb alert on CSPR: specific account high transaction (warning, until 2026-10-28 01:59:59 KST)",
      "Bithumb alert on CSPR: trading volume sudden fluctuation (danger, until 2026-10-28 01:59:59 KST)",
    ])
    expect(cspr.map((i) => i.baseSeverity)).toEqual([30, 35])
    expect(items.every((i) => i.category === "general" && i.polarity === 0)).toBe(true)
    expect(bithumbAlertItems(json("korea-bithumb-alerts.json"), koreanCtx(new Date("2026-10-30T00:00:00Z")))).toEqual([])
    expect(bithumbAlertItems(json("korea-bithumb-alerts.json"), makeCtx())).toEqual([])
  })

  it("SlowMist: keeps hacks of a universe asset or $10M+ (market-wide), never tags the chain a protocol runs on", () => {
    const html = fixture("slowmist.html")
    const items = slowmistItems(html, makeCtx())
    expect(items.map((i) => [i.title.split(":")[0], i.symbols, i.marketWide, i.meta?.loss_usd])).toEqual([["Pirate Chain hacked", [], true, 10_746_000]])
    expect(items[0]).toMatchObject({ category: "exploit", polarity: -1, publishedAt: new Date("2026-10-14T00:00:00Z") })
    expect(items[0].title).toMatch(/^Pirate Chain hacked: \$10,746,000 lost \(.+\)$/)
    const solana = slowmistItems(html.replace("</em>Bloom Trading</h3>", "</em>Solana</h3>"), makeCtx())
    expect(solana.find((i) => i.symbols?.length)).toMatchObject({ symbols: ["SOL/USD"], marketWide: false, title: "Solana hacked: $947,000 lost (Supply Chain Attack)" })
  })
})
