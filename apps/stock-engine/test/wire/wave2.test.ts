import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { afterEach, describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import { benzingaNews, CATALOG, centralBankDecisions, fedregItems } from "../../src/wire/catalog"
import { WireFetch } from "../../src/wire/fetch"
import { parseFeed } from "../../src/wire/kinds/rss"
import { stockLexicon } from "../../src/wire/lexicon"
import { MetricWatcher } from "../../src/wire/metrics"
import { stockRules } from "../../src/wire/policy"
import { appRank, appstoreItems, APP_CHARTS, apewisdomItems, BROKER_APPS, cnnFngItems, companyArticle, pageviewRatio, stocktwitsTrendingItems, tradestieItems } from "../../src/wire/sources/attention"
import { dividendItems, earningsItems, ipoItems } from "../../src/wire/sources/calendars"
import { BROWSER_HEADERS } from "../../src/wire/sources/common"
import { buildDirectory, normalizeName, resetCompanyDirectory, shortName } from "../../src/wire/sources/companies"
import { eiaItem, eiaPoll, eiaValues, EIA_REPORTS } from "../../src/wire/sources/eia"
import { adcommPoll, agendaSponsor, approvalItems, fdaDateTime, trialItems, upcomingMeetings } from "../../src/wire/sources/fda"
import { finvizInsiderItems, InsiderClusters, openInsiderItems, parseFinvizInsider, parseOpenInsider, roleLabel, tradeTitle } from "../../src/wire/sources/insiders"
import { kalshiMarkets, KALSHI_SERIES, polymarketMarkets, swingItems } from "../../src/wire/sources/odds"
import { finvizTime, gdeltItems, gdeltQuery, parseFinvizNews, taggedFeed } from "../../src/wire/sources/outlets"
import { cotItems, parseShortVolume, shortVolumeItems, type ShortDay } from "../../src/wire/sources/positioning"
import { awardItems, awardQuery } from "../../src/wire/sources/usaspending"
import { parseYieldCurve, vixItems, weakAuctionItem, yieldItems, type Auction } from "../../src/wire/sources/vol-rates"
import type { RawItem, SourceContext, SymbolSets } from "../../src/wire/types"
import type { WireItemDoc } from "@mb/stock-core/wire"

const fixture = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "wire", name), "utf8")
const json = (name: string) => JSON.parse(fixture(name))
const NOW = new Date("2026-10-27T15:00:00Z")
const MIN = 60_000

const makeCtx = ({ clock = { now: NOW }, fetch = {}, env = {}, symbols = { universe: ["SPY", "QQQ"], held: ["NVDA"], focus: ["AAPL"] } }: { clock?: { now: Date }; fetch?: Partial<Record<"json" | "get" | "postJson", unknown>>; env?: Record<string, string>; symbols?: SymbolSets } = {}) =>
  ({
    fetch: fetch as unknown as WireFetch,
    log: silentLogger,
    env,
    symbols: () => symbols,
    now: () => clock.now,
    settings: () => DEFAULT_SETTINGS.wire,
  }) satisfies SourceContext

const DIRECTORY = buildDirectory([
  { cik: 1, ticker: "NVS", title: "Novartis AG" },
  { cik: 2, ticker: "MRK", title: "MERCK & CO INC" },
  { cik: 3, ticker: "AMRX", title: "Amneal Pharmaceuticals, Inc." },
  { cik: 4, ticker: "HII", title: "HUNTINGTON INGALLS INDUSTRIES, INC." },
  { cik: 5, ticker: "AAL", title: "American Airlines Group Inc." },
  { cik: 6, ticker: "LMT", title: "LOCKHEED MARTIN CORP" },
  { cik: 7, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" },
  { cik: 8, ticker: "VRTX", title: "VERTEX PHARMACEUTICALS INC / MA" },
  { cik: 9, ticker: "NVDA", title: "NVIDIA CORP" },
  { cik: 10, ticker: "SYDX", title: "Sydnexis, Inc." },
])

afterEach(() => resetCompanyDirectory())

describe("company names to tickers", () => {
  it("normalizes names on both sides and matches from the first word", () => {
    expect(normalizeName("ELI LILLY & Co")).toEqual(["ELI", "LILLY"])
    expect(normalizeName("VERTEX PHARMACEUTICALS INC / MA")).toEqual(["VERTEX", "PHARMACEUTICALS"])
    expect(DIRECTORY.resolve("NOVARTIS PHARMS CORP")).toBe("NVS")
    expect(DIRECTORY.resolve("AMNEAL PHARMS")).toBe("AMRX")
    expect(DIRECTORY.resolve("MERCK SHARP DOHME")).toBe("MRK")
    expect(DIRECTORY.resolve("HUNTINGTON INGALLS INCORPORATED")).toBe("HII")
    expect(DIRECTORY.resolve("LOCKHEED MARTIN CORPORATION")).toBe("LMT")
    expect(DIRECTORY.resolve("Vertex Pharmaceuticals Incorporated")).toBe("VRTX")
    // Subsidiaries filing under a parent, and names that must not match.
    expect(DIRECTORY.resolve("OPTUM PUBLIC SECTOR SOLUTIONS, INC.")).toBe("UNH")
    expect(DIRECTORY.resolve("JANSSEN BIOTECH INC")).toBe("JNJ")
    expect(DIRECTORY.resolve("AMERICAN REGENT INC")).toBeNull()
    expect(DIRECTORY.resolve("UCB INC")).toBeNull()
    expect(DIRECTORY.resolve("KINDOS")).toBeNull()
    expect(DIRECTORY.byCik.get(7)).toBe("BRK.B")
    expect(shortName("NVIDIA CORP")).toBe("Nvidia")
    expect(shortName("Amazon.com, Inc.")).toBe("Amazon")
  })
})

describe("vol_rates and treasury", () => {
  it("VIX: baseline first, then one risk-off item for a jump on the day", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    expect(vixItems(json("cboe-vix.json"), w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + MIN)
    expect(vixItems({ data: { current_price: 19, prev_day_close: 18.39, price_change_percent: 3.3 } }, w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + 2 * MIN)
    const [item] = vixItems({ data: { current_price: 23.5, prev_day_close: 18.39, price_change_percent: 27.8 } }, w, ctx)
    expect(item).toMatchObject({ category: "price_shock", kind: "derivatives", tier: 1, symbols: [], marketWide: true, polarity: -1, baseSeverity: 50 })
    expect(item.title).toBe("VIX at 23.50, +27.8% on the day, up 28% within the hour: risk-off (CBOE, delayed)")
    expect(item.meta).toMatchObject({ metric: "vix", rules: "hour,day" })
    // Still up: no repeat.
    clock.now = new Date(NOW.getTime() + 3 * MIN)
    expect(vixItems({ data: { current_price: 24, prev_day_close: 18.39, price_change_percent: 30.5 } }, w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + 4 * MIN)
    expect(vixItems({ data: { current_price: 31, prev_day_close: 18.39, price_change_percent: 68 } }, w, ctx)[0]).toMatchObject({ baseSeverity: 60, title: expect.stringContaining("at or above 30") })
  })

  it("Treasury yields: a 15 bp day in the 2-year or 10-year", () => {
    const days = parseYieldCurve(fixture("treasury-yields.xml"))
    expect(days).toEqual([
      { date: "2026-10-01", y2: 4.78, y10: 5.24 },
      expect.objectContaining({ date: "2026-10-02" }),
      expect.objectContaining({ date: expect.stringMatching(/^2026-10-0\d$/) }),
    ])
    expect(yieldItems(days.slice(0, 2))).toEqual([])
    const [item] = yieldItems([{ date: "2026-10-26", y2: 4.6, y10: 5.1 }, { date: "2026-10-27", y2: 4.81, y10: 5.22 }])
    expect(item).toMatchObject({ sourceId: "yields:2026-10-27", category: "macro_release", polarity: -1, baseSeverity: 45, title: "Treasury yields on 2026-10-27: 2-year +21 bp to 4.81%, 10-year +12 bp to 5.22%" })
    expect(item.meta).toMatchObject({ metric: "treasury:yields", d2_bp: 21, d10_bp: 12, spread_2s10s_bp: 41 })
  })

  it("Treasury auctions: weak bid-to-cover or dealers left holding it; bills and TIPS never", () => {
    const [two, bill, tips] = json("treasury-auctions.json") as Auction[]
    const past = (day: string, btc: number, dealerShare: number): Auction => ({ ...two, cusip: `X${day}`, competitiveAuctionCloseDate: `${day}T00:00:00`, bidToCoverRatio: String(btc), primaryDealersCompetitiveParAwarded: String(dealerShare * 100), directBiddersCompetitiveParAwarded: String((100 - dealerShare) * 50), indirectBiddersCompetitiveParAwarded: String((100 - dealerShare) * 50) })
    const history = [past("2026-04-27", 2.65, 12), past("2026-05-26", 2.64, 13), past("2026-06-23", 2.64, 12), past("2026-07-27", 2.66, 14), past("2026-08-25", 2.6, 13), past("2026-09-22", 2.63, 12)]
    // The real 2-year of 2026-10-26 (2.59, dealers 13%) was fine.
    expect(weakAuctionItem(two, history)).toBeNull()
    const weak = weakAuctionItem({ ...two, bidToCoverRatio: "2.31", primaryDealersCompetitiveParAwarded: "20000000000" }, history)!
    expect(weak).toMatchObject({ sourceId: "91282CRU7:2026-10-26", category: "macro_release", kind: "macro", marketWide: true, polarity: -1, baseSeverity: 55 })
    expect(weak.title).toMatch(/^Weak 2-Year Treasury note auction: bid-to-cover 2\.31 vs 2\.64 for the last 6, dealers took 25% \(usually 13%\), high yield 4\.708%$/)
    expect(weakAuctionItem(bill, history)).toBeNull()
    expect(weakAuctionItem(tips, history)).toBeNull()
    expect(weakAuctionItem(two, history.slice(0, 2))).toBeNull()
  })
})

describe("prediction markets", () => {
  it("selects liquid macro markets on Polymarket, never price bets", () => {
    const events = json("polymarket-econ.json")
    const extra = { id: "e9", slug: "largest", title: "Largest Company", markets: [{ id: "m9", question: "Will NVIDIA be the largest company in the world by market cap on October 31, 2026?", outcomes: '["Yes", "No"]', outcomePrices: '["0.91", "0.09"]', liquidityNum: 9e6, volume24hr: 9e5 }] }
    const markets = polymarketMarkets([...events, extra, events[0]], NOW)
    // December's 50 bp cut traded under $5K in 24 h: too thin.
    expect(markets.map((m) => m.key)).toEqual(["polymarket:2589810", "polymarket:2589811", "polymarket:2589812", "polymarket:3215006", "polymarket:3215007"])
    expect(markets.find((m) => m.key === "polymarket:2589812")).toMatchObject({ prob: expect.closeTo(93.8, 5), group: "polymarket:606422" })
    expect(markets.some((m) => m.key === "polymarket:m9")).toBe(false)
  })

  it("reads Kalshi CPI and recession markets with enough open interest", () => {
    const cpi = kalshiMarkets(json("kalshi-cpi.json").markets, KALSHI_SERIES[1])
    // The December 0.3% strike has 2,656 contracts open: too thin.
    expect(cpi.map((m) => m.key)).toEqual(["kalshi:KXCPI-26NOV-T0.4", "kalshi:KXCPI-26OCT-T1.0"])
    expect(cpi[0]).toMatchObject({ prob: expect.closeTo(21, 5), group: "kalshi:KXCPI-26NOV", url: "https://kalshi.com/markets/kxcpi" })
    expect(kalshiMarkets(json("kalshi-recession.json").markets, KALSHI_SERIES[2]).map((m) => m.question)).toEqual(["Will there be a recession in 2027?", "Will there be a recession in 2026?"])
  })

  it("reports a swing market-wide as odds_swing", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    const m = (prob: number) => [{ key: "kalshi:KXRECSSNBER-27", group: "kalshi:KXRECSSNBER-27", question: "Will there be a recession in 2027?", prob, url: "https://kalshi.com/markets/kxrecssnber", venue: "Kalshi" as const }]
    expect(swingItems(m(19), w, ctx)).toEqual([])
    clock.now = new Date(NOW.getTime() + 30 * MIN)
    expect(swingItems(m(41), w, ctx)).toEqual([expect.objectContaining({ title: "Kalshi odds: Will there be a recession in 2027? 19% → 41% in 60 min", category: "odds_swing", kind: "sentiment", symbols: [], marketWide: true, baseSeverity: 59 })])
  })
})

describe("attention", () => {
  const later = (clock: { now: Date }, min: number) => (clock.now = new Date(NOW.getTime() + min * MIN))

  it("CNN Fear & Greed: enters extreme fear at 25, leaves only past 30 and an hour later", () => {
    const w = new MetricWatcher()
    const ctx = makeCtx()
    const at = (h: number, score: number) => ({ fear_and_greed: { score, rating: score <= 25 ? "extreme fear" : "fear", timestamp: new Date(NOW.getTime() + h * 3_600_000).toISOString(), previous_close: 27 } })
    expect(cnnFngItems(json("cnn-fng.json"), w, ctx)).toEqual([])
    const [enter] = cnnFngItems(at(1, 21), w, ctx)
    expect(enter).toMatchObject({ title: "CNN Fear & Greed index enters extreme fear: 21 (previous close 27)", category: "sentiment_spike", tier: 3, marketWide: true })
    expect(cnnFngItems(at(1.5, 26), w, ctx)).toEqual([])
    expect(cnnFngItems(at(1.7, 24), w, ctx)).toEqual([])
    expect(cnnFngItems(at(3, 32), w, ctx)).toEqual([expect.objectContaining({ title: "CNN Fear & Greed index leaves extreme fear: 32 (fear)", meta: expect.objectContaining({ exit: true }) })])
    expect(cnnFngItems(json("cnn-fng.json"), new MetricWatcher(), ctx)).toEqual([])
  })

  it("StockTwits, ApeWisdom and Tradestie: held and watched stocks only", () => {
    const clock = { now: NOW }
    const ctx = makeCtx({ clock, symbols: { universe: [], held: ["SOFI"], focus: ["TSLA", "META"] } })
    const w = new MetricWatcher()
    expect(stocktwitsTrendingItems({ symbols: [] }, w, ctx)).toEqual([])
    later(clock, 3)
    expect(stocktwitsTrendingItems(json("stocktwits-trending-stocks.json"), w, ctx)).toEqual([expect.objectContaining({ symbols: ["SOFI"], title: "SOFI enters StockTwits trending (#1 of 3)", category: "sentiment_spike" })])
    const ape = new MetricWatcher()
    expect(apewisdomItems({ results: [] }, ape, ctx)).toEqual([])
    later(clock, 15)
    expect(apewisdomItems(json("apewisdom-stocks.json"), ape, ctx)).toEqual([expect.objectContaining({ symbols: ["TSLA"], title: "TSLA: 81 Reddit/4chan mentions in 24 h, 6.8× the day before (ApeWisdom)" })])
    const wsb = new MetricWatcher()
    expect(tradestieItems([], wsb, ctx)).toEqual([])
    later(clock, 30)
    // META is #2 but with 33 comments: not hot enough.
    expect(tradestieItems(json("tradestie-wsb.json"), wsb, ctx)).toEqual([])
    later(clock, 45)
    expect(tradestieItems([{ ticker: "META", sentiment: "Bearish", sentiment_score: -0.12, no_of_comments: 140 }], wsb, ctx)).toEqual([
      expect.objectContaining({ symbols: ["META"], title: "META is among r/wallstreetbets' most discussed: #1 with 140 comments, Bearish sentiment (-0.12) (Tradestie)" }),
    ])
  })

  it("App Store: Robinhood and Webull ranks; Wikipedia articles and views", () => {
    expect(appRank(json("appstore-finance-stocks.json"), BROKER_APPS[0])).toBe(3)
    expect(appRank(json("appstore-finance-stocks.json"), BROKER_APPS[1])).toBeNull()
    const clock = { now: NOW }
    const ctx = makeCtx({ clock })
    const w = new MetricWatcher()
    const top = (rank: number | null) => ({ feed: { results: Array.from({ length: 100 }, (_, i) => (rank === i + 1 ? { id: "1179213067", name: "Webull: Investing & Trading" } : { id: String(i), name: `App ${i}` })) } })
    expect(appstoreItems(APP_CHARTS[0], top(null), w, ctx)).toEqual([])
    later(clock, 60)
    expect(appstoreItems(APP_CHARTS[0], top(42), w, ctx)).toEqual([expect.objectContaining({ title: "Webull app enters the US App Store top 100 free apps (#42)", marketWide: true, symbols: [] })])
    expect(companyArticle({ query: { search: [{ title: "Apple" }, { title: "Apple Inc." }] } }, "Apple")).toBe("Apple")
    expect(companyArticle({ query: { search: [{ title: "Graphics card" }, { title: "Nvidia" }] } }, "Nvidia")).toBe("Nvidia")
    expect(companyArticle({ query: { search: [{ title: "Something else" }] } }, "Nvidia")).toBeNull()
    expect(companyArticle({ query: { search: [{ title: "Lockheed Corporation" }, { title: "Lockheed Martin" }] } }, "Lockheed Martin")).toBe("Lockheed_Martin")
    expect(companyArticle({ query: { search: [{ title: "The Coca-Cola Company" }, { title: "Coca-Cola" }] } }, "Coca Cola")).toBe("The_Coca-Cola_Company")
    expect(companyArticle({ query: { search: [{ title: "SoFi" }, { title: "SoFi Stadium" }] } }, "Sofi Technologies")).toBe("SoFi")
    const days = Array.from({ length: 30 }, (_, i) => ({ timestamp: `202610${String(i + 1).padStart(2, "0")}00`, views: i === 29 ? 9_000 : 2_000 }))
    expect(pageviewRatio({ items: days })).toMatchObject({ views: 9_000, median: 2_000, ratio: 4.5 })
  })
})

describe("calendars", () => {
  it("earnings and ex-dividend dates of held and watched stocks only, and mega IPOs market-wide", () => {
    const items = earningsItems(json("nasdaq-earnings.json"), "2026-10-27", new Set(["V", "HSBC"]))
    expect(items.map((i) => i.symbols)).toEqual([["V"], ["HSBC"]])
    expect(items[0]).toMatchObject({ kind: "calendar", category: "earnings", baseSeverity: 15, title: "Scheduled: V reports earnings 2026-10-27 after the close (quarter ending Sep/2026), EPS forecast $3.43 from 12 estimates" })
    // After the close is 16:05 New York time.
    expect(items[0].meta!.event_at).toBe("2026-10-27T20:05:00.000Z")
    expect(items[1].title).toContain("time not announced")
    const div = dividendItems(json("nasdaq-dividends.json"), new Set(["ASML"]))
    expect(div).toEqual([expect.objectContaining({ symbols: ["ASML"], title: "Scheduled: ASML goes ex-dividend 2026-10-27 ($2.1077 a share, paid 2026-11-04)" })])
    const ipo = json("nasdaq-ipo.json")
    expect(ipoItems(ipo, NOW)).toEqual([])
    ipo.data.upcoming.upcomingTable.rows.push({ dealID: "1", proposedTickerSymbol: "ANTH", companyName: "Anthropic PBC", proposedExchange: "NASDAQ Global Select", proposedSharePrice: "210.00", expectedPriceDate: "10/29/2026", dollarValueOfSharesOffered: "$12,600,000,000" })
    expect(ipoItems(ipo, NOW)).toEqual([expect.objectContaining({ marketWide: true, symbols: [], title: "Scheduled: Anthropic PBC IPO (ANTH, NASDAQ Global Select) expected 2026-10-29, raising $12.6B at $210.00" })])
  })
})

describe("FDA and trials", () => {
  it("keeps new NDA/BLA approvals and new indications of listed sponsors", () => {
    // The fixture's October approvals are a labeling supplement, a generic and an unlisted sponsor.
    expect(approvalItems(json("openfda.json"), DIRECTORY, "20261001", "20261031")).toEqual([])
    const app = { application_number: "NDA219001", sponsor_name: "VERTEX PHARMS INC", openfda: { brand_name: ["JOURNAVX"], generic_name: ["SUZETRIGINE"] }, submissions: [{ submission_type: "ORIG", submission_number: "1", submission_status: "AP", submission_status_date: "20261024", review_priority: "PRIORITY" }, { submission_type: "SUPPL", submission_number: "3", submission_status: "AP", submission_status_date: "20261025", submission_class_code: "EFFICACY" }, { submission_type: "SUPPL", submission_number: "4", submission_status: "AP", submission_status_date: "20261025", submission_class_code: "LABELING" }] }
    const items = approvalItems({ results: [app] }, DIRECTORY, "20261020", "20261027")
    expect(items).toEqual([
      expect.objectContaining({ symbols: ["VRTX"], category: "fda", tier: 1, polarity: 1, title: "VRTX: FDA approves Journavx (suzetrigine), Vertex Pharms Inc's new NDA, priority review", publishedAt: new Date("2026-10-24T00:00:00Z") }),
      expect.objectContaining({ baseSeverity: 55, title: "VRTX: FDA approves a new indication for Journavx (Vertex Pharms Inc, efficacy supplement)" }),
    ])
  })

  it("reads the advisory-committee calendar and the applicant from the meeting page", async () => {
    expect(fdaDateTime("10/30/2026 08:30 AM EDT")?.toISOString()).toBe("2026-10-30T12:30:00.000Z")
    const meetings = upcomingMeetings(json("fda-adcomm.json"), NOW)
    expect(meetings).toEqual([expect.objectContaining({ title: "October 30, 2026: Dermatologic and Ophthalmic Drugs Advisory Committee Meeting Announcement", path: expect.stringMatching(/^\/advisory-committees\//) })])
    expect(agendaSponsor(fixture("fda-adcomm-meeting.html"))).toBe("Sydnexis")
    expect(agendaSponsor("<body><h2>Agenda</h2><p>…the safety and effectiveness of MFLUSIVA (Influenza Vaccine, mRNA), manufactured by Moderna TX Inc., with a requested indication…</p></body>")).toBe("Moderna TX Inc")
    const tickers = { "0": { cik_str: 10, ticker: "SYDX", title: "Sydnexis, Inc." } }
    const fetchJson = vi.fn(async (url: string) => (url.includes("company_tickers") ? tickers : json("fda-adcomm.json")))
    const get = vi.fn(async () => ({ status: 200, text: fixture("fda-adcomm-meeting.html"), notModified: false }))
    const [item] = (await adcommPoll(makeCtx({ fetch: { json: fetchJson, get } }))())!
    expect(item).toMatchObject({ kind: "calendar", category: "fda", symbols: ["SYDX"], meta: expect.objectContaining({ event_at: "2026-10-30T12:30:00.000Z", sponsor: "Sydnexis" }) })
    expect(item.title).toBe("Scheduled: FDA advisory committee on Sydnexis's application (SYDX): October 30, 2026: Dermatologic and Ophthalmic Drugs Advisory Committee Meeting Announcement")
    expect(get.mock.calls[0]).toEqual([expect.stringMatching(/^https:\/\/www\.fda\.gov\/advisory-committees\//), expect.objectContaining({ headers: expect.objectContaining(BROWSER_HEADERS) })])
  })

  it("flags recent status changes on trials the company leads", () => {
    const at = new Date("2026-10-15T12:00:00Z")
    const items = trialItems(json("clinicaltrials.json"), "VRTX", DIRECTORY, at)
    // One completed in September; the 2025 completion and the INSERM-led trial are not news for VRTX.
    expect(items).toEqual([expect.objectContaining({ sourceId: "NCT05668741:COMPLETED", symbols: ["VRTX"], polarity: 0, baseSeverity: 20, title: expect.stringMatching(/^VRTX: phase 1\/2 trial NCT05668741 completed: A Phase 1\/2 Study of VX-522/) })])
    const halted = { studies: [{ protocolSection: { identificationModule: { nctId: "NCT1", briefTitle: "A Phase 3 trial" }, statusModule: { overallStatus: "SUSPENDED", whyStopped: "Safety review", completionDateStruct: { date: "2027-06" }, lastUpdatePostDateStruct: { date: "2026-10-15" } }, sponsorCollaboratorsModule: { leadSponsor: { name: "Vertex Pharmaceuticals Incorporated" } }, designModule: { phases: ["PHASE3"] } } }] }
    expect(trialItems(halted, "VRTX", DIRECTORY, at)).toEqual([expect.objectContaining({ polarity: -1, baseSeverity: 60, title: "VRTX: phase 3 trial NCT1 suspended (Safety review): A Phase 3 trial" })])
  })
})

describe("insiders", () => {
  it("parses openinsider purchases and Finviz insider rows into one title format", () => {
    const oi = parseOpenInsider(fixture("openinsider.html"))
    expect(oi.map((t) => t.ticker)).toEqual(["RVII", "GPI", "OPTU"])
    expect(oi[1]).toMatchObject({ insider: "Conifer Management, L.L.C.", role: "10% owner", value: 24_232_209, price: 242.32, tradeDate: "2026-10-22", filedAt: new Date("2026-10-27T01:00:00Z"), url: expect.stringMatching(/^http:\/\/www\.sec\.gov\//) })
    const fv = parseFinvizInsider(fixture("finviz-insider.html"))
    expect(fv.map((t) => [t.ticker, t.type])).toEqual([
      ["RVI", "buy"],
      ["PENG", "sale"],
    ])
    expect(tradeTitle(fv[0])).toBe("RVI: director Whitney Meredith buys $23K of stock at $23.49 (Form 4, traded 2026-10-23)")
    expect(roleLabel("Pres, CEO, 10%")).toBe("CEO")
    expect(roleLabel("See Remarks")).toBe("insider")
    const ctx = makeCtx({ symbols: { universe: [], held: ["GPI"], focus: ["RVI"] } })
    expect(openInsiderItems(oi, new InsiderClusters(), ctx)).toEqual([expect.objectContaining({ symbols: ["GPI"], category: "insider_buy", polarity: 1, tier: 2, meta: expect.objectContaining({ insider: true }) })])
    // RVI's buy is under the $100K floor for Finviz rows.
    expect(finvizInsiderItems(fv, ctx)).toEqual([])
  })

  it("reports two insiders buying one issuer within 5 days as one cluster", () => {
    const clusters = new InsiderClusters()
    const buy = (insider: string, tradeDate: string, value: number) => ({ ticker: "ACME", company: "Acme Corp", insider, role: "director", type: "buy" as const, price: 20, shares: value / 20, value, tradeDate, filedAt: null, url: null })
    expect(clusters.add([buy("A. Smith", "2026-10-23", 80_000)], NOW)).toEqual([])
    const [cluster] = clusters.add([buy("A. Smith", "2026-10-23", 80_000), buy("B. Jones", "2026-10-26", 60_000)], NOW)
    expect(cluster).toMatchObject({ sourceId: "cluster:ACME:2026-10-23", symbols: ["ACME"], category: "insider_buy", baseSeverity: 45, meta: expect.objectContaining({ insider: true, cluster: true, insiders: 2, value_usd: 140_000 }) })
    expect(cluster.title).toBe("ACME: insider cluster buy, 2 insiders bought $140K of stock within 5 days (A. Smith, B. Jones)")
    expect(clusters.add([buy("C. Lee", "2026-10-26", 50_000)], new Date(NOW.getTime() + 3_600_000))).toEqual([])
    // Too old, or one person buying twice, is not a cluster.
    expect(new InsiderClusters().add([buy("A. Smith", "2026-10-10", 80_000), buy("B. Jones", "2026-10-26", 80_000)], NOW)).toEqual([])
    expect(new InsiderClusters().add([buy("A. Smith", "2026-10-23", 80_000), buy("A. Smith", "2026-10-26", 80_000)], NOW)).toEqual([])
  })
})

describe("outlets", () => {
  it("parses the wave-2 feeds", () => {
    for (const f of ["rss-cnbc.xml", "rss-marketwatch.xml", "rss-wsj-markets.xml", "rss-foxbusiness.xml", "rss-nyt-business.xml", "rss-ft-markets.xml", "rss-politico.xml", "rss-economist.xml", "rss-investing.xml", "rss-rttnews.xml"]) {
      const items = parseFeed(fixture(f))
      expect(items.length, f).toBeGreaterThanOrEqual(2)
      for (const i of items) expect(i, f).toMatchObject({ title: expect.any(String), url: expect.stringMatching(/^https?:\/\//), publishedAt: expect.any(Date) })
    }
    expect(benzingaNews(parseFeed(fixture("rss-benzinga.xml")))).toEqual([])
    expect(benzingaNews([{ title: "Nvidia shares rise after earnings beat" }])).toHaveLength(1)
  })

  it("takes Seeking Alpha's and Nasdaq's ticker tags when they are few and tracked", () => {
    const sa = taggedFeed(fixture("rss-seekingalpha.xml"), new Set(["CDNS"]))
    expect(sa.map((i) => i.symbols)).toEqual([["CDNS"], undefined, undefined])
    // Nasdaq's per-symbol feed: only the symbol asked for. The first item is a listicle tagging four tickers: the lexicon decides it.
    const nq = taggedFeed(fixture("rss-nasdaq-aapl.xml"), new Set(["AAPL", "NVDA"]), "AAPL")
    expect(nq.map((i) => i.symbols)).toEqual([undefined, ["AAPL"], ["AAPL"]])
  })

  it("parses Finviz's news and blog columns", () => {
    const now = new Date("2026-10-27T03:00:00Z")
    const items = parseFinvizNews(fixture("finviz-news.html"), now)
    expect(items.map((i) => i.tier)).toEqual([2, 2, 3])
    expect(items[0]).toMatchObject({ title: "Indian shares seen lower as oil stays near six-month high, Fed in focus", url: expect.stringMatching(/^https:\/\/www\.reuters\.com\//), meta: { outlet: "reuters" } })
    // 10:28 PM New York on Oct 26 is 02:28Z on Oct 27.
    expect(items[0].publishedAt?.toISOString()).toBe("2026-10-27T02:28:00.000Z")
    // A time later than now was yesterday's.
    expect(finvizTime("11:59PM", now)?.toISOString()).toBe("2026-10-26T03:59:00.000Z")
    expect(finvizTime("Oct-25", now)?.toISOString()).toBe("2026-10-25T13:30:00.000Z")
  })

  it("queries GDELT by company name and tags what the titles name", () => {
    expect(gdeltQuery(["Nvidia", "Vertex Pharmaceuticals"])).toBe('("Nvidia" OR "Vertex Pharmaceuticals") sourcelang:english')
    const items = gdeltItems(
      [
        { url: "https://x.test/1", title: "Nvidia shares slide as chip curbs widen", seendate: "20261027T023000Z" },
        { url: "https://x.test/2", title: "Nvidiaesque startups raise money" },
      ],
      [{ symbol: "NVDA", name: "Nvidia" }],
    )
    expect(items[0]).toMatchObject({ symbols: ["NVDA"], publishedAt: new Date("2026-10-27T02:30:00Z") })
    expect(items[1].symbols).toBeUndefined()
  })
})

describe("macro, energy, positioning and contracts", () => {
  it("Federal Register: paperwork and trade-remedy cases dropped, weighted by document type", () => {
    expect(fedregItems(json("fedreg-tariff.json"))).toEqual([])
    const doc = (type: string, title: string) => ({ document_number: title, title, type, html_url: "https://www.federalregister.gov/d/x", publication_date: "2026-10-27" })
    const items = fedregItems({ results: [doc("Presidential Document", "Adjusting Imports of Semiconductors Into the United States"), doc("Proposed Rule", "Section 301 Tariff Modifications"), doc("Notice", "Notice of Action: Section 301 Tariffs on Ships")] })
    expect(items.map((i) => i.baseSeverity)).toEqual([undefined, 50, 35])
    expect(CATALOG.find((s) => s.id === "fedreg:tariff")).toMatchObject({ kind: "json", tier: 1, category_hint: "policy_shock" })
    expect(stockLexicon.classify(items[2].title)).toBe("policy_shock")
  })

  it("central banks: rate decisions only, market-wide", () => {
    const kept = centralBankDecisions([{ title: "Bank Rate reduced to 3.75% - November 2026" }, { title: "Monetary policy decisions" }, { title: "Speech by the Governor" }])
    expect(kept.map((i) => i.title)).toEqual(["Bank Rate reduced to 3.75% - November 2026", "Monetary policy decisions"])
    expect(kept[0]).toMatchObject({ symbols: [], marketWide: true, category: "macro_release", kind: "macro" })
  })

  it("EIA: the week's change with the forecast and surprise", () => {
    const crude = EIA_REPORTS[0]
    const values = eiaValues(json("eia-petroleum.json"), crude)
    expect(values.map((v) => v.period)).toEqual(["2026-10-16", "2026-10-09", "2026-10-02"])
    const ff = [{ title: "Crude Oil Inventories", country: "USD", date: "2026-10-28T10:30:00-04:00", forecast: "1.5M" }]
    expect(eiaItem(crude, values, ff, NOW)).toMatchObject({
      sourceId: "crude:2026-10-16",
      title: "EIA crude inventories -3.1M barrels to 412.5M in the week to Oct 16 (prior week -8.6M barrels; forecast +1.5M barrels, surprise -4.6M barrels)",
      category: "macro_release",
      marketWide: true,
      tier: 1,
      baseSeverity: 30,
      meta: expect.objectContaining({ metric: "eia:crude", change: -3.06, forecast: 1.5 }),
    })
    const gas = eiaItem(EIA_REPORTS[1], eiaValues(json("eia-natgas.json"), EIA_REPORTS[1]), [], NOW)!
    expect(gas.title).toBe("EIA natural gas storage +77.0 Bcf to 3644 Bcf in the week to Oct 16 (prior week +67.0 Bcf)")
  })

  it("EIA: learns the latest week at boot, then polls only in the release window until a new week appears", async () => {
    const clock = { now: new Date("2026-10-27T15:00:00Z") }
    const petroleum = json("eia-petroleum.json")
    const next = structuredClone(petroleum)
    next.response.data.unshift({ period: "2026-10-23", value: "410000" })
    let body = petroleum
    const fetchJson = vi.fn(async (url: string) => (url.includes("faireconomy") ? [] : url.includes("petroleum") ? body : json("eia-natgas.json")))
    const poll = eiaPoll(makeCtx({ clock, fetch: { json: fetchJson }, env: { EIA_API_KEY: "k" } }))
    expect(await poll()).toEqual([])
    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(await poll()).toEqual([])
    expect(fetchJson).toHaveBeenCalledTimes(2)
    // Wednesday 10:31 ET: the petroleum report is due.
    clock.now = new Date("2026-10-28T14:31:00Z")
    expect(await poll()).toEqual([])
    body = next
    clock.now = new Date("2026-10-28T14:32:00Z")
    expect(await poll()).toEqual([expect.objectContaining({ sourceId: "crude:2026-10-23", title: expect.stringMatching(/^EIA crude inventories -2\.5M barrels to 410\.0M in the week to Oct 23/) })])
    // Reported: no more petroleum polls today (natural gas is still watched on Wednesdays for holiday weeks).
    const petroleumCalls = () => fetchJson.mock.calls.filter(([url]) => url.includes("petroleum")).length
    const calls = petroleumCalls()
    clock.now = new Date("2026-10-28T14:40:00Z")
    expect(await poll()).toEqual([])
    expect(petroleumCalls()).toBe(calls)
  })

  it("COT for the full-size equity and VIX futures, and FINRA short volume against its own history", () => {
    const cot = cotItems(json("cot-equity.json"))
    expect(cot.map((i) => i.sourceId)).toEqual(["2026-10-20:ES", "2026-10-20:NQ", "2026-10-20:VX"])
    expect(cot[0]).toMatchObject({ symbols: [], marketWide: true, baseSeverity: 20, title: "CFTC COT (2026-10-20): E-mini S&P 500, leveraged funds net -371,245 contracts (+37,481 on the week), asset managers net +901,377 (-14,458)" })
    const day = parseShortVolume(fixture("finra-short.txt"), 0)!
    expect(day.day).toBe("2026-10-23")
    expect(day.rows.get("NVDA")).toEqual({ short: 9498803.375829, total: 32380765.151177 })
    const past = (d: string, ratio: number): ShortDay => ({ day: d, rows: new Map([["NVDA", { short: ratio * 30e6, total: 30e6 }], ["AAPL", { short: 0.6 * 13e6, total: 13e6 }]]) })
    const history = ["2026-10-22", "2026-10-21", "2026-10-20", "2026-10-19", "2026-10-16"].map((d) => past(d, 0.3))
    expect(shortVolumeItems(day, history, ["NVDA", "AAPL"])).toEqual([])
    const hot: ShortDay = { day: "2026-10-23", rows: new Map([["NVDA", { short: 0.62 * 32e6, total: 32e6 }]]) }
    expect(shortVolumeItems(hot, history, ["NVDA"])).toEqual([expect.objectContaining({ symbols: ["NVDA"], polarity: 0, title: "NVDA: short volume 62% of FINRA-reported volume on 2026-10-23 (10-day median 30%, 32.0M shares)", meta: expect.objectContaining({ metric: "finra_short:NVDA" }) })])
    expect(shortVolumeItems(hot, history.slice(0, 4), ["NVDA"])).toEqual([])
  })

  it("USAspending: large new contracts to listed recipients", () => {
    expect(awardQuery(NOW).filters.time_period[0]).toEqual({ date_type: "date_signed", start_date: "2026-09-27", end_date: "2026-10-27" })
    expect(awardItems(json("usaspending.json"), DIRECTORY)).toEqual([
      expect.objectContaining({ symbols: ["UNH"], tier: 1, polarity: 1, baseSeverity: 45, publishedAt: new Date("2026-09-30T00:00:00Z"), title: "UNH: Department of Veterans Affairs contract to Optum Public Sector Solutions, Inc. worth $1.1B (36C10G26K0298, signed 2026-09-30)" }),
    ])
  })
})

describe("wave-2 catalog and plumbing", () => {
  it("registers every wave-2 source once, with the plan's tiers", () => {
    const ids = CATALOG.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ["vol_rates:vix", "vol_rates:yields", "treasury", "odds:kalshi", "odds:polymarket", "fng", "rss:cnbc", "rss:seekingalpha", "persymbol:nasdaq", "rss:benzinga", "fda:approvals", "fda:adcomm", "calendar:earnings", "calendar:dividends", "calendar:ipo", "insiders", "finviz", "finviz:insider", "stocktwits", "macro_actuals", "fedreg:tariff", "fedreg:export", "wsb:apewisdom", "wsb:tradestie", "gdelt", "eia", "cot", "finra_short", "usaspending", "clinicaltrials", "cb:ecb", "cb:boe", "cb:boj", "appstore", "wikipedia"]) {
      expect(ids, id).toContain(id)
    }
    const tier = (id: string) => CATALOG.find((s) => s.id === id)!.tier
    expect(["rss:cnbc", "rss:wsj_markets", "rss:ft_markets", "rss:seekingalpha", "persymbol:nasdaq"].map(tier)).toEqual([2, 2, 2, 2, 2])
    expect(["rss:investing", "rss:rttnews", "rss:benzinga", "gdelt", "wsb:apewisdom", "fng"].map(tier)).toEqual([3, 3, 3, 3, 3, 3])
    expect(["vol_rates:vix", "treasury", "eia", "fda:approvals", "macro_actuals", "cb:ecb"].map(tier)).toEqual([1, 1, 1, 1, 1, 1])
    expect(CATALOG.find((s) => s.id === "vol_rates:yields")!.interval_s).toBeGreaterThanOrEqual(3_600)
    expect(CATALOG.filter((s) => ["eia", "fda:approvals"].includes(s.id)).map((s) => s.key_env)).toEqual(["EIA_API_KEY", "OPENFDA_API_KEY"])
  })

  it("a spec's browser User-Agent replaces the wire's own", async () => {
    const request = vi.fn(async () => ({ status: 200, text: "{}", headers: new Headers() }))
    const f = new WireFetch({ take: async () => undefined }, "StockMarketBot/1 a@b.c", request)
    await f.get("https://api.nasdaq.com/api/calendar/earnings?date=2026-10-27", { headers: { ...BROWSER_HEADERS, accept: "application/json" } })
    const headers = (request.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers
    expect(headers["user-agent"]).toBe(BROWSER_HEADERS["user-agent"])
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === "user-agent")).toHaveLength(1)
  })

  it("a polled reading source stays quiet on its first poll", async () => {
    const spec = CATALOG.find((s) => s.id === "vol_rates:vix")!
    const fetchJson = vi.fn().mockResolvedValueOnce({ data: { current_price: 31, prev_day_close: 18, price_change_percent: 72 } }).mockResolvedValue({ data: { current_price: 31.2, prev_day_close: 18, price_change_percent: 73 } })
    const source = spec.create!(spec, makeCtx({ fetch: { json: fetchJson } }))
    const emit = vi.fn(async (_items: RawItem[], _opts?: { backfill?: boolean }) => undefined)
    const tick = (source as unknown as { tick: (e: typeof emit) => Promise<void> }).tick.bind(source)
    await tick(emit)
    await tick(emit)
    expect(emit).not.toHaveBeenCalled()
  })

  it("the policy leaves every wave-2 reading in the dossier", async () => {
    const base: WireItemDoc = {
      _id: "x",
      cluster_id: "x",
      source: "vol_rates:vix",
      tier: 1,
      kind: "derivatives",
      category: "price_shock",
      title: "VIX at 31",
      summary: null,
      url: null,
      domain: null,
      symbols: [],
      published_at: NOW,
      first_seen_at: NOW,
      polarity: -1,
      severity: 90,
      severity_parts: {},
      confirmations: [],
      price_at_seen: {},
      meta: { metric: "vix" },
      notable: false,
      notable_reasons: [],
      expires_at: NOW,
    }
    const ctx = { held: new Set(["NVDA"]), universe: new Set(["NVDA"]), settings: DEFAULT_SETTINGS, now: NOW, hasRecentNews: async () => false }
    expect(await stockRules(base, ctx)).toEqual([])
    expect(await stockRules({ ...base, source: "treasury", kind: "macro", category: "macro_release", meta: { metric: "treasury:auction:10-Year" } }, ctx)).toEqual([])
    expect(await stockRules({ ...base, source: "finra_short", symbols: ["NVDA"], category: "general", polarity: 0, meta: { metric: "finra_short:NVDA" } }, ctx)).toEqual([])
  })
})
