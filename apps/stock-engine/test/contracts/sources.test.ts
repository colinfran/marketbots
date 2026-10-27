import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import type { WireFetch } from "@mb/wire/fetch"
import { parseFeed } from "@mb/wire/kinds/rss"
import { MetricWatcher, type MetricRule, type Reading } from "@mb/wire/metrics"
import { afterAll, beforeAll, describe, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import { decodePricing } from "../../src/market/yahoo-stream"
import { CATALOG } from "../../src/wire/catalog"
import { apewisdomItems, APP_CHARTS, appRank, appstoreItems, BROKER_APPS, cnnFngItems, stocktwitsTrendingItems, tradestieItems } from "../../src/wire/sources/attention"
import { dividendItems, earningsItems as calendarEarningsItems, ipoItems } from "../../src/wire/sources/calendars"
import { buildDirectory } from "../../src/wire/sources/companies"
import { congressItems, parseFilingIndex, parsePtr, pdfText, unzip } from "../../src/wire/sources/congress"
import { edgarItem, parseEdgarItems, parseEdgarTitle } from "../../src/wire/sources/edgar"
import { eiaItem, eiaValues, EIA_REPORTS } from "../../src/wire/sources/eia"
import { agendaSponsor, approvalItems, trialItems, upcomingMeetings } from "../../src/wire/sources/fda"
import { parseHalts } from "../../src/wire/sources/halts"
import { finvizInsiderItems, InsiderClusters, openInsiderItems, parseFinvizInsider, parseOpenInsider } from "../../src/wire/sources/insiders"
import { earningsItems as marketbeatEarningsItems, parseEarnings, parseRatings, ratingItems } from "../../src/wire/sources/marketbeat"
import { kalshiMarkets, KALSHI_SERIES, polymarketMarkets } from "../../src/wire/sources/odds"
import { parseFinvizNews, taggedFeed } from "../../src/wire/sources/outlets"
import { fdaCalendarItems, parseFdaCalendar } from "../../src/wire/sources/pdufa"
import { parseShortVolume } from "../../src/wire/sources/positioning"
import { awardItems } from "../../src/wire/sources/usaspending"
import { auctionStats, parseYieldCurve, vixItems, weakAuctionItem, yieldItems, type Auction } from "../../src/wire/sources/vol-rates"
import type { SourceContext, SourceSpec, SymbolSets } from "../../src/wire/types"
import { checkNoOrphans, matchJson } from "./snapshot"

/**
 * Parsed items for every saved source payload in test/fixtures/wire. Where a fixture belongs to a
 * catalog entry with its own parser (json `map`, rss `refine`), that parser runs; otherwise the
 * exported source function the engine's poller calls. Sources that watch a metric get a recording
 * MetricWatcher: on a fresh watcher the first reading is only a baseline (no items), so the
 * snapshot also lists every reading the parser extracted (key, value, time, rules).
 *
 * Symbol sets are chosen so every row a parser reads reaches the output: functions that take a
 * set get one that contains every ticker, and functions that read the context's held and watched
 * symbols get the tickers the fixture itself contains.
 */

const DIR = join(__dirname, "..", "fixtures", "wire")
const text = (name: string) => readFileSync(join(DIR, name), "utf8")
const json = (name: string) => JSON.parse(text(name))
const bytes = (name: string) => new Uint8Array(readFileSync(join(DIR, name)))

/** The time the wire tests use; every parser gets it, and Date is pinned to it as well. */
const NOW = new Date("2026-10-27T15:00:00Z")
const SYMBOLS: SymbolSets = { universe: ["SPY", "QQQ", "IWM"], held: ["NVDA", "SOFI", "GPI"], focus: ["AAPL", "TSLA", "META", "RVI"] }

const makeCtx = ({ now = NOW, symbols = SYMBOLS }: { now?: Date; symbols?: SymbolSets } = {}) =>
  ({
    fetch: {} as unknown as WireFetch,
    log: silentLogger,
    env: {},
    symbols: () => symbols,
    now: () => now,
    settings: () => DEFAULT_SETTINGS.wire,
  }) satisfies SourceContext

/** Every ticker is tracked (functions that only call `.has`). */
const ALL = { has: () => true } as unknown as ReadonlySet<string>
const watching = (tickers: Iterable<string>, now = NOW) => makeCtx({ now, symbols: { universe: [], held: [], focus: [...new Set(tickers)].sort() } })

/** The company directory the FDA, trials and USAspending tests use (plus the built-in aliases). */
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

const spec = (id: string): SourceSpec => {
  const s = CATALOG.find((x) => x.id === id)
  if (!s) throw new Error(`no catalog entry ${id}`)
  return s
}

/** A MetricWatcher that records every reading it is given. */
const recordingWatcher = () => {
  const watcher = new MetricWatcher()
  const rules: Record<string, MetricRule> = {}
  const labels = new Map<string, string>()
  const label = (r: MetricRule) => {
    const key = JSON.stringify(r)
    let l = labels.get(key)
    if (!l) {
      l = r.id in rules ? `${r.id}#${labels.size}` : r.id
      labels.set(key, l)
      rules[l] = r
    }
    return l
  }
  const readings: unknown[] = []
  const observe = watcher.observe.bind(watcher)
  const backfill = watcher.backfill.bind(watcher)
  watcher.observe = (key: string, value: number, at: number, rs: MetricRule[]) => {
    readings.push({ key, value, at: new Date(at), rules: rs.map(label) })
    return observe(key, value, at, rs)
  }
  watcher.backfill = (key: string, points: Reading[], rs: MetricRule[]) => {
    readings.push({ key, backfill: points.map((p) => ({ value: p.value, at: new Date(p.at) })), rules: rs.map(label) })
    return backfill(key, points, rs)
  }
  return { watcher, observations: () => ({ readings, rules }) }
}

const watched = <T>(run: (w: MetricWatcher) => T) => {
  const { watcher, observations } = recordingWatcher()
  const output = run(watcher)
  return { output, observations: observations() }
}

/** An rss catalog entry: the feed parser, then the entry's `refine` when it has one. */
const rssSpec = (id: string, name: string) => {
  const s = spec(id)
  if (s.kind !== "rss") throw new Error(`${id} is not an rss entry`)
  const parsed = parseFeed(text(name))
  return s.refine ? { parser: `parseFeed + ${id}.refine`, parsed, output: s.refine(parsed, makeCtx()) } : { parser: `parseFeed (${id})`, output: parsed }
}

/** A json catalog entry's `map`. */
const jsonSpec = (id: string, name: string) => {
  const s = spec(id)
  if (s.kind !== "json" || !s.map) throw new Error(`${id} is not a json entry`)
  return { parser: `${id}.map`, output: s.map(json(name), makeCtx()) }
}

const HOUSE_ZIP = "house-fd-index.zip"
const houseIndex = () => parseFilingIndex(unzip(bytes(HOUSE_ZIP)).get("2026FD.txt")!.toString("utf8"))

const ptr = async (name: string, docId: string) => {
  const parsed = parsePtr(await pdfText(bytes(name)))
  const filing = houseIndex().find((f) => f.docId === docId)!
  return { parser: "pdfText + parsePtr, then congressItems (every ticker tracked)", filing, ptr: parsed, output: congressItems(filing, parsed, ALL) }
}

type Parsed = Record<string, unknown> & { parser: string }

const PARSERS: Record<string, () => Parsed | Promise<Parsed>> = {
  "apewisdom-stocks.json": () => ({ parser: "apewisdomItems (wsb:apewisdom), fresh watcher", ...watched((w) => apewisdomItems(json("apewisdom-stocks.json"), w, watching(["TSLA", "META", "SOFI", "NVDA", "AAPL"]))) }),
  "appstore-finance-stocks.json": () => {
    const body = json("appstore-finance-stocks.json")
    const finance = APP_CHARTS.find((c) => c.id === "finance")!
    return { parser: "appRank per broker app, appstoreItems (finance chart), fresh watcher", ranks: Object.fromEntries(BROKER_APPS.map((a) => [a.name, appRank(body, a)])), ...watched((w) => appstoreItems(finance, body, w, makeCtx())) }
  },
  "cboe-vix.json": () => ({ parser: "vixItems (vol_rates:vix), fresh watcher", ...watched((w) => vixItems(json("cboe-vix.json"), w, makeCtx())) }),
  "clinicaltrials.json": () => ({ parser: "trialItems for VRTX at 2026-10-15T12:00Z", output: trialItems(json("clinicaltrials.json"), "VRTX", DIRECTORY, new Date("2026-10-15T12:00:00Z")) }),
  "cnn-fng.json": () => ({ parser: "cnnFngItems (fng), fresh watcher", ...watched((w) => cnnFngItems(json("cnn-fng.json"), w, makeCtx())) }),
  "cot-equity.json": () => jsonSpec("cot", "cot-equity.json"),
  "edgar-8k.xml": () => {
    const entries = parseFeed(text("edgar-8k.xml"))
    const titles = entries.map((e) => parseEdgarTitle(e.title))
    const tickers = new Map(titles.flatMap((t, i) => (t ? [[t.cik, `EDG${String.fromCharCode(65 + i)}`] as const] : [])))
    return {
      parser: "parseFeed + parseEdgarTitle + parseEdgarItems, then edgarItem with each CIK mapped to EDGA, EDGB, …",
      entries: entries.map((e, i) => ({ entry: e, title: titles[i], items: parseEdgarItems(e.summary) })),
      output: entries.map((e) => edgarItem(e, tickers)),
    }
  },
  "eia-natgas.json": () => {
    const r = EIA_REPORTS.find((x) => x.id === "natgas")!
    const values = eiaValues(json("eia-natgas.json"), r)
    return { parser: "eiaValues + eiaItem (natgas, no forecast)", values, output: eiaItem(r, values, [], NOW) }
  },
  "eia-petroleum.json": () => {
    const r = EIA_REPORTS.find((x) => x.id === "crude")!
    const values = eiaValues(json("eia-petroleum.json"), r)
    const ff = [{ title: "Crude Oil Inventories", country: "USD", date: "2026-10-28T10:30:00-04:00", forecast: "1.5M" }]
    return { parser: "eiaValues + eiaItem (crude, with a ForexFactory forecast)", values, output: eiaItem(r, values, ff, NOW) }
  },
  "fda-adcomm-meeting.html": () => ({ parser: "agendaSponsor", output: agendaSponsor(text("fda-adcomm-meeting.html")) }),
  "fda-adcomm.json": () => ({ parser: "upcomingMeetings (next 7 days)", output: upcomingMeetings(json("fda-adcomm.json"), NOW) }),
  "fedreg-tariff.json": () => jsonSpec("fedreg:tariff", "fedreg-tariff.json"),
  "finnhub.json": () => ({ ...jsonSpec("finnhub", "finnhub.json"), finnhub_company: spec("finnhub_company").map!(json("finnhub.json"), makeCtx()) }),
  "finra-short.txt": () => ({ parser: "parseShortVolume (default minimum volume)", output: parseShortVolume(text("finra-short.txt")) }),
  "finviz-insider.html": () => {
    const trades = parseFinvizInsider(text("finviz-insider.html"))
    return { parser: "parseFinvizInsider + finvizInsiderItems (every ticker watched)", trades, output: finvizInsiderItems(trades, watching(trades.map((t) => t.ticker))) }
  },
  "finviz-news.html": () => ({ parser: "parseFinvizNews at 2026-10-27T03:00Z", output: parseFinvizNews(text("finviz-news.html"), new Date("2026-10-27T03:00:00Z")) }),
  "halts.xml": () => ({ parser: "parseHalts at 2026-10-27T02:00Z", output: parseHalts(text("halts.xml"), new Date("2026-10-27T02:00:00Z")) }),
  [HOUSE_ZIP]: () => {
    const files = unzip(bytes(HOUSE_ZIP))
    return { parser: "unzip + parseFilingIndex", files: Object.fromEntries([...files].map(([name, body]) => [name, body.length])), output: houseIndex() }
  },
  "house-ptr-20033725.pdf": () => ptr("house-ptr-20033725.pdf", "20033725"),
  "house-ptr-20035669.pdf": () => ptr("house-ptr-20035669.pdf", "20035669"),
  "house-ptr-20035700.pdf": () => ptr("house-ptr-20035700.pdf", "20035700"),
  "kalshi-cpi.json": () => ({ parser: `kalshiMarkets (${KALSHI_SERIES[1].series})`, series: KALSHI_SERIES[1], output: kalshiMarkets(json("kalshi-cpi.json").markets, KALSHI_SERIES[1]) }),
  "kalshi-recession.json": () => ({ parser: `kalshiMarkets (${KALSHI_SERIES[2].series})`, series: KALSHI_SERIES[2], output: kalshiMarkets(json("kalshi-recession.json").markets, KALSHI_SERIES[2]) }),
  "marketbeat-earnings.html": () => {
    const rows = parseEarnings(text("marketbeat-earnings.html"))
    return { parser: "parseEarnings + earningsItems (every ticker tracked, 2026-10-27T14:00Z)", rows, output: marketbeatEarningsItems(rows, watching(rows.map((r) => r.ticker), new Date("2026-10-27T14:00:00Z"))) }
  },
  "marketbeat-ratings.html": () => {
    const rows = parseRatings(text("marketbeat-ratings.html"))
    return { parser: "parseRatings + ratingItems (every ticker tracked)", rows, output: ratingItems(rows, watching(rows.map((r) => r.ticker))) }
  },
  "massive.json": () => jsonSpec("massive_news", "massive.json"),
  "nasdaq-dividends.json": () => ({ parser: "dividendItems (every ticker watched)", output: dividendItems(json("nasdaq-dividends.json"), ALL) }),
  "nasdaq-earnings.json": () => ({ parser: "earningsItems for 2026-10-27 (every ticker watched)", output: calendarEarningsItems(json("nasdaq-earnings.json"), "2026-10-27", ALL) }),
  "nasdaq-ipo.json": () => ({ parser: "ipoItems", output: ipoItems(json("nasdaq-ipo.json"), NOW) }),
  "openfda.json": () => ({ parser: "approvalItems 20261001–20261031", output: approvalItems(json("openfda.json"), DIRECTORY, "20261001", "20261031") }),
  "openinsider.html": () => {
    const trades = parseOpenInsider(text("openinsider.html"))
    return { parser: "parseOpenInsider + openInsiderItems (every ticker watched, fresh clusters)", trades, output: openInsiderItems(trades, new InsiderClusters(), watching(trades.map((t) => t.ticker))) }
  },
  "polymarket-econ.json": () => ({ parser: "polymarketMarkets", output: polymarketMarkets(json("polymarket-econ.json"), NOW) }),
  "rss-benzinga.xml": () => rssSpec("rss:benzinga", "rss-benzinga.xml"),
  "rss-cnbc.xml": () => rssSpec("rss:cnbc", "rss-cnbc.xml"),
  "rss-economist.xml": () => rssSpec("rss:economist", "rss-economist.xml"),
  "rss-foxbusiness.xml": () => rssSpec("rss:foxbusiness", "rss-foxbusiness.xml"),
  "rss-ft-markets.xml": () => rssSpec("rss:ft_markets", "rss-ft-markets.xml"),
  "rss-investing.xml": () => rssSpec("rss:investing", "rss-investing.xml"),
  "rss-marketwatch.xml": () => rssSpec("rss:marketwatch", "rss-marketwatch.xml"),
  "rss-nasdaq-aapl.xml": () => ({ parser: "taggedFeed for AAPL (persymbol:nasdaq, every ticker tracked)", output: taggedFeed(text("rss-nasdaq-aapl.xml"), ALL, "AAPL") }),
  "rss-nyt-business.xml": () => rssSpec("rss:nyt_business", "rss-nyt-business.xml"),
  "rss-politico.xml": () => rssSpec("rss:politico", "rss-politico.xml"),
  "rss-rttnews.xml": () => rssSpec("rss:rttnews", "rss-rttnews.xml"),
  "rss-seekingalpha.xml": () => ({ parser: "taggedFeed (rss:seekingalpha, every ticker tracked)", output: taggedFeed(text("rss-seekingalpha.xml"), ALL) }),
  "rss-wsj-markets.xml": () => rssSpec("rss:wsj_markets", "rss-wsj-markets.xml"),
  "rttnews-fda-calendar-p1.html": () => {
    const page = parseFdaCalendar(text("rttnews-fda-calendar-p1.html"))
    return { parser: "parseFdaCalendar + fdaCalendarItems (every ticker tracked, 2026-10-27T14:00Z)", page, output: fdaCalendarItems(page.rows, watching(page.rows.flatMap((r) => r.tickers), new Date("2026-10-27T14:00:00Z"))) }
  },
  "rttnews-fda-calendar.html": () => {
    const page = parseFdaCalendar(text("rttnews-fda-calendar.html"))
    return { parser: "parseFdaCalendar + fdaCalendarItems (every ticker tracked, 2026-10-27T14:00Z)", page, output: fdaCalendarItems(page.rows, watching(page.rows.flatMap((r) => r.tickers), new Date("2026-10-27T14:00:00Z"))) }
  },
  "stocktwits-trending-stocks.json": () => ({ parser: "stocktwitsTrendingItems (stocktwits), fresh watcher", ...watched((w) => stocktwitsTrendingItems(json("stocktwits-trending-stocks.json"), w, makeCtx())) }),
  "tradestie-wsb.json": () => ({ parser: "tradestieItems (wsb:tradestie), fresh watcher", ...watched((w) => tradestieItems(json("tradestie-wsb.json"), w, makeCtx())) }),
  "treasury-auctions.json": () => {
    const auctions = json("treasury-auctions.json") as Auction[]
    return { parser: "auctionStats + weakAuctionItem against the fixture as history (as treasuryPoll does)", stats: auctions.map(auctionStats), output: auctions.map((a) => weakAuctionItem(a, auctions)) }
  },
  "treasury-yields.xml": () => {
    const days = parseYieldCurve(text("treasury-yields.xml"))
    return { parser: "parseYieldCurve + yieldItems", days, output: yieldItems(days) }
  },
  "usaspending.json": () => ({ parser: "awardItems", output: awardItems(json("usaspending.json"), DIRECTORY) }),
  "yahoo-pricing.json": () => ({ parser: "decodePricing per message", output: (json("yahoo-pricing.json") as string[]).map(decodePricing) }),
}

describe("contracts: parsed source fixtures", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(NOW)
  })
  afterAll(() => {
    vi.useRealTimers()
  })

  const fixtures = readdirSync(DIR).sort()

  it("every fixture has a parser here", () => {
    const missing = fixtures.filter((f) => !(f in PARSERS))
    const stale = Object.keys(PARSERS).filter((f) => !fixtures.includes(f))
    if (missing.length || stale.length) throw new Error(`fixtures without a contract parser: ${missing.join(", ") || "none"}; parsers without a fixture: ${stale.join(", ") || "none"}`)
  })

  for (const name of Object.keys(PARSERS).sort()) {
    it(name, async () => {
      const { parser, ...rest } = await PARSERS[name]()
      matchJson(`parsed/${name}.json`, { fixture: name, parser, ...rest })
    })
  }

  it("no stale snapshots", () => checkNoOrphans("parsed", Object.keys(PARSERS).map((f) => `${f}.json`)))
})
