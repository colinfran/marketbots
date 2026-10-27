import { readFileSync } from "node:fs"
import { join } from "node:path"
import { silentLogger } from "@mb/engine-kit/log"
import { DEFAULT_SETTINGS, type Settings } from "@mb/stock-core/settings"
import { describe, expect, it, vi } from "vitest"
import type { Alpaca } from "../../src/alpaca/client"
import { MarketStream, type MinuteBar } from "../../src/alpaca/market-stream"
import { loadSettings } from "../../src/state/stores"
import { CATALOG } from "../../src/wire/catalog"
import { parseFeed } from "../../src/wire/kinds/rss"
import { stockLexicon } from "../../src/wire/lexicon"
import { alpacaNewsSpec, moversSpec } from "../../src/wire/sources/alpaca"
import { edgarItem, parseEdgarItems, parseEdgarTitle } from "../../src/wire/sources/edgar"
import { parseHalts } from "../../src/wire/sources/halts"
import { stockSignalItem } from "../../src/wire/sources/stock-market"
import type { RawItem, SourceContext } from "../../src/wire/types"
import { Wire } from "../../src/wire/wire"
import { makeBus } from "../helpers/ctx"
import { useTestDb } from "../helpers/db"

const fixture = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "wire", name), "latin1")
const spec = (id: string) => CATALOG.find((s) => s.id === id)!
const NOW = new Date("2026-10-27T15:00:00Z")
const ctx = { now: () => NOW, log: silentLogger, env: {}, symbols: () => ({ universe: [], held: ["NVDA"], focus: [] }) } as unknown as SourceContext

describe("stock lexicon", () => {
  const tag = (t: string, s = ["NVDA", "AAPL", "IT", "ON", "F"]) => stockLexicon.tag(t, s)
  it("tags cashtags, exchange tags and capitalized tickers, not everyday words", () => {
    expect(tag("NVDA tops estimates as AAPL slips")).toEqual(["NVDA", "AAPL"])
    expect(tag("Is IT time to buy? Prices are ON the rise")).toEqual([])
    expect(tag("Gartner (NYSE: IT) and ON Semiconductor ($ON) report")).toEqual(["IT", "ON"])
    expect(tag("nvda in lower case and NVDAX are other things")).toEqual([])
  })

  it("classifies the stock categories and finds direction", () => {
    expect(stockLexicon.classify("Acme files for Chapter 11 bankruptcy protection")).toBe("bankruptcy")
    expect(stockLexicon.classify("FDA approves Acme's new drug")).toBe("fda")
    expect(stockLexicon.classify("Acme to acquire Beta in $5B deal")).toBe("m_and_a")
    expect(stockLexicon.classify("Acme prices $300M public offering")).toBe("offering")
    expect(stockLexicon.classify("Acme set to join the S&P 500")).toBe("index_change")
    expect(stockLexicon.classify("US imposes new tariffs on chips")).toBe("policy_shock")
    expect(stockLexicon.classify("Mali-Related Sanctions")).toBe("general")
    expect(stockLexicon.marketWide("Mali-Related Sanctions", "general")).toBe(false)
    expect(stockLexicon.classify("Analyst downgrades Acme to underweight")).toBe("analyst_action")
    expect(stockLexicon.polarity("Acme misses estimates and cuts guidance")).toBe(-1)
    expect(stockLexicon.polarity("Acme beats and raises")).toBe(1)
    expect(stockLexicon.marketWide("Fed holds interest rates steady", "general")).toBe(true)
    expect(stockLexicon.marketWide("Acme opens a new store", "general")).toBe(false)
  })
})

describe("EDGAR", () => {
  it("reads form, company, CIK and 8-K items, and maps the CIK to a ticker", () => {
    expect(parseEdgarTitle("8-K - PERPETUA RESOURCES CORP. (0001526243) (Filer)")).toEqual({ form: "8-K", company: "PERPETUA RESOURCES CORP.", cik: 1526243, role: "Filer" })
    const entries = parseFeed(fixture("edgar-8k.xml"))
    expect(entries).toHaveLength(4)
    expect(parseEdgarItems(entries[0].summary).map((i) => i.item).length).toBeGreaterThan(0)
    const cik = parseEdgarTitle(entries[0].title)!.cik
    const item = edgarItem(entries[0], new Map([[cik, "PPTA"]]))!
    expect(item).toMatchObject({ symbols: ["PPTA"], tier: 1, kind: "filing", title: expect.stringMatching(/^PPTA 8-K: /) })
    expect(edgarItem(entries[0], new Map())).toBeNull()
    const results = edgarItem({ title: "8-K - ACME (0000000001) (Filer)", summary: "<b>Filed:</b> x<br>Item 2.02: Results of Operations and Financial Condition<br>Item 9.01: Financial Statements and Exhibits", url: "https://sec.gov/x" }, new Map([[1, "ACME"]]))
    expect(results).toMatchObject({ category: "earnings", title: "ACME 8-K: 2.02 Results of Operations and Financial Condition" })
    expect(edgarItem({ title: "8-K - ACME (0000000001) (Filer)", summary: "Item 1.03: Bankruptcy or Receivership<br>Item 2.02: Results", url: null }, new Map([[1, "ACME"]]))?.category).toBe("bankruptcy")
  })
})

describe("stock sources", () => {
  it("parses Nasdaq halts and resumptions", () => {
    const items = parseHalts(fixture("halts.xml"), new Date("2026-10-27T02:00:00Z"))
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ category: "halt", tier: 1, kind: "venue", symbols: [expect.stringMatching(/^[A-Z.]+$/)] })
    expect(items[0].title).toMatch(/halted|resumes/)
    // 10/26/2026 19:50 ET is 23:50Z.
    expect(items[0].publishedAt?.toISOString()).toBe("2026-10-26T23:50:00.000Z")
    // Halts that have lasted for days are not news.
    expect(parseHalts(fixture("halts.xml"), new Date("2026-10-30T00:00:00Z"))).toHaveLength(0)
  })

  it("maps Finnhub and Massive payloads", () => {
    const fh = spec("finnhub").map!(JSON.parse(fixture("finnhub.json")), ctx)
    expect(fh[0]).toMatchObject({ sourceId: expect.any(String), title: expect.any(String), publishedAt: expect.any(Date) })
    const massive = spec("massive_news").map!(JSON.parse(fixture("massive.json")), ctx)
    expect(massive).toHaveLength(2)
    expect(massive[0]).toMatchObject({ url: expect.stringMatching(/^https?:/), symbols: expect.any(Array) })
  })

  it("keeps Alpaca headlines without Benzinga summaries, skips round-ups, and lists big movers only in session", async () => {
    const getNews = vi.fn(async () => [
      { id: 1, headline: "NVDA rallies", summary: "Long Benzinga text", source: "benzinga", url: "https://b.com/1", symbols: ["NVDA"], created_at: "2026-10-27T14:59:00Z" },
      { id: 2, headline: "10 stocks to watch", summary: "", source: "benzinga", url: "https://b.com/2", symbols: ["A", "B", "C", "D", "E", "F", "G"], created_at: "2026-10-27T14:58:00Z" },
    ])
    const source = alpacaNewsSpec({ getNews } as unknown as Pick<Alpaca, "getNews">).create!(alpacaNewsSpec({ getNews } as never), ctx)
    const emitted: RawItem[][] = []
    await (source as unknown as { tick: (e: (i: RawItem[]) => Promise<void>) => Promise<void> }).tick(async (i) => void emitted.push(i))
    expect(emitted[0]).toEqual([expect.objectContaining({ sourceId: "1", summary: null, symbols: ["NVDA"] })])

    let open = false
    const getMovers = vi.fn(async () => ({ gainers: [{ symbol: "ACME", price: 12, change: 3, percent_change: 33 }, { symbol: "TINY", price: 1, change: 1, percent_change: 90 }], losers: [{ symbol: "BETA", price: 50, change: -4, percent_change: -8 }] }))
    const movers = moversSpec({ getMovers } as never, () => DEFAULT_SETTINGS, () => open).create!(moversSpec({ getMovers } as never, () => DEFAULT_SETTINGS, () => open), ctx)
    const got: RawItem[][] = []
    const tick = (movers as unknown as { tick: (e: (i: RawItem[]) => Promise<void>) => Promise<void> }).tick.bind(movers)
    await tick(async (i) => void got.push(i))
    expect(getMovers).not.toHaveBeenCalled()
    open = true
    await tick(async (i) => void got.push(i))
    expect(got.flat()).toEqual([expect.objectContaining({ symbols: ["ACME"], kind: "anomaly", polarity: 1, meta: expect.objectContaining({ anomaly: "mover" }) })])
  })

  it("builds anomaly items with SPY as the market reference", () => {
    expect(stockSignalItem({ symbol: "SPY", kind: "market", at: NOW.getTime(), z: -6, window_min: 5, ret_pct: -1.2, volume_multiple: null }, 4)).toMatchObject({ symbols: [], marketWide: true, polarity: -1, title: expect.stringContaining("SPY") })
    expect(stockSignalItem({ symbol: "NVDA", kind: "price", at: NOW.getTime(), z: 5, window_min: 1, ret_pct: 2.1, volume_multiple: null }, 4)).toMatchObject({ symbols: ["NVDA"], category: "price_shock", meta: expect.objectContaining({ anomaly: "price" }) })
  })
})

describe("market stream bars", () => {
  type Sent = { action: string; bars?: string[]; trades?: string[] }
  const stream = () => {
    const bars: MinuteBar[] = []
    const s = new MarketStream({ keyId: "k", secret: "s" }, silentLogger, { onTrade: () => undefined, onQuote: () => undefined, onBar: (b) => bars.push(b) })
    const sent: Sent[] = []
    const ws = { readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) }
    const s2 = s as unknown as { ws: typeof ws; onMessage: (ws: unknown, raw: Buffer) => void }
    s2.ws = ws
    const msg = (m: unknown) => s2.onMessage(ws, Buffer.from(JSON.stringify([m])))
    return { s, bars, sent, msg }
  }

  it("subscribes all-symbol minute bars on its own and parses them", () => {
    const { s, bars, sent, msg } = stream()
    s.setSymbols(["NVDA"])
    msg({ T: "success", msg: "authenticated" })
    expect(sent).toEqual([expect.objectContaining({ action: "subscribe", trades: ["NVDA"] }), { action: "subscribe", bars: ["*"] }])
    msg({ T: "b", S: "AAPL", o: 1, h: 2, l: 1, c: 1.5, v: 300, t: "2026-10-27T14:31:00Z" })
    expect(bars).toEqual([{ symbol: "AAPL", t: Date.parse("2026-10-27T14:31:00Z"), open: 1, high: 2, low: 1, close: 1.5, volume: 300 }])
  })

  it("turns bars off for good when the plan rejects them, without touching trades", () => {
    const { s, sent, msg } = stream()
    msg({ T: "success", msg: "authenticated" })
    msg({ T: "error", code: 405, msg: "symbol limit exceeded" })
    expect(s.barsRejected).toBe(true)
    s.setSymbols(["NVDA"])
    expect(sent.filter((m) => m.bars)).toHaveLength(1)
  })
})

describe("stock wire pipeline", () => {
  const db = useTestDb()
  it("stores ticker news and market-wide policy, drops unrelated items, and migrates old settings", async () => {
    const bus = await makeBus(db.col)
    const wire = new Wire({
      col: db.col,
      bus,
      log: silentLogger,
      settings: () => DEFAULT_SETTINGS.wire,
      catalog: [{ id: "rss:x", kind: "rss", url: "https://x.test", interval_s: 60, tier: 2, default_enabled: true }],
      lexicon: stockLexicon,
      env: {},
      symbols: () => ({ universe: ["SPY"], held: ["NVDA"], focus: [] }),
      price: () => 100,
      userAgent: "test",
      now: () => NOW,
    })
    const r = await wire.ingest("rss:x", [
      { title: "NVDA cuts guidance on weak demand", url: "https://x.test/1" },
      { title: "White House announces new tariffs on semiconductors", url: "https://x.test/2" },
      { title: "Local bakery wins award", url: "https://x.test/3" },
    ])
    expect(r.stored.map((i) => [i.symbols, i.category])).toEqual([
      [["NVDA"], "guidance"],
      [[], "policy_shock"],
    ])
    expect(r.dropped).toBe(1)
    await bus.stop()

    const { wire: _w, ...old } = DEFAULT_SETTINGS
    await db.col.settings.insertOne({ _id: "current", settings: old as Settings, version: 3, updated_at: NOW, updated_by: "owner" })
    const store = await loadSettings(db.col, { GROK_RESEARCH_MODEL: null, GROK_DECISION_MODEL: null } as never, silentLogger)
    expect(store.current.wire).toEqual(DEFAULT_SETTINGS.wire)
  })
})
