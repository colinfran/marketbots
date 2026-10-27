import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SETTINGS, type Settings } from "@mb/crypto-core/settings"
import type { WireFetch } from "@mb/wire/fetch"
import { diffEntries, diffPoller } from "@mb/wire/kinds/diff"
import { parseFeed } from "@mb/wire/kinds/rss"
import { parseStatuspage } from "@mb/wire/kinds/statuspage"
import { parseTelegram } from "@mb/wire/kinds/telegram"
import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import { loadSettings } from "../src/state/stores"
import { CATALOG } from "../src/wire/catalog"
import { cryptoLexicon, largestAmountUsd } from "../src/wire/lexicon"
import type { SourceContext } from "../src/wire/types"
import { Wire } from "../src/wire/wire"
import { useTestDb } from "./helpers/db"
import { makeBus } from "./helpers/fakes"

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "wire", name), "utf8")
const spec = (id: string) => CATALOG.find((s) => s.id === id)!
const NOW = new Date("2026-10-27T12:00:00Z")
const UNIVERSE = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD", "ADA/USD", "LINK/USD", "AVAX/USD", "LTC/USD", "DOT/USD"]

describe("crypto lexicon", () => {
  const tag = (t: string) => cryptoLexicon.tag(t, UNIVERSE)
  it("tags by name or cashtag and ignores ambiguous words", () => {
    expect(tag("Bitcoin and Ether rally")).toEqual(["BTC/USD", "ETH/USD"])
    expect(tag("$SOL breaks out as Solana DEX volume jumps")).toEqual(["SOL/USD"])
    expect(tag("Click the link to see the dot plot; sol is the sun; Ada Lovelace")).toEqual([])
    expect(tag("Chainlink and Polkadot upgrades")).toEqual(["LINK/USD", "DOT/USD"])
    expect(cryptoLexicon.tag("UNI surges after the vote", ["UNI/USD"])).toEqual(["UNI/USD"])
  })

  it("classifies, finds direction, and keeps only crypto-relevant regulation market-wide", () => {
    expect(cryptoLexicon.classify("Protocol drained of $40M in bridge exploit")).toBe("exploit")
    expect(cryptoLexicon.classify("SEC approves spot Solana ETF")).toBe("etf_decision")
    expect(cryptoLexicon.classify("Coinbase will list SUI")).toBe("listing_major")
    expect(cryptoLexicon.classify("Weekly recap", "macro_release")).toBe("macro_release")
    expect(cryptoLexicon.polarity("Exchange hacked, withdrawals halted")).toBe(-1)
    expect(cryptoLexicon.polarity("ETF approval sends prices soaring")).toBe(1)
    expect(cryptoLexicon.marketWide("SEC charges crypto exchange with fraud", "regulatory_action")).toBe(true)
    expect(cryptoLexicon.marketWide("SEC charges investment adviser with fraud", "regulatory_action")).toBe(false)
    expect(cryptoLexicon.marketWide("President imposes new tariffs on imports", "regulatory_action")).toBe(true)
    expect(cryptoLexicon.marketWide("Federal Reserve Board announces termination of enforcement action", "regulatory_action")).toBe(false)
  })

  it("scales exploit severity by the amount lost", () => {
    expect(largestAmountUsd("Bloom drained of $947,000 in SOL")).toBe(947_000)
    expect(largestAmountUsd("Exploit drains over $2.6M, then $40 million more")).toBe(40e6)
    expect(largestAmountUsd("X100 exploit nets 4.85 million USDT")).toBe(4.85e6)
    expect(largestAmountUsd("No amount here")).toBeNull()
    expect(cryptoLexicon.baseSeverity!("Exchange hacked for $1.4B", "exploit")).toBe(90)
    expect(cryptoLexicon.baseSeverity!("Wallet drained of $947,000", "exploit")).toBe(40)
    // No amount: an early report, or security research and fixes rather than an attack.
    expect(cryptoLexicon.baseSeverity!("Exchange hacked", "exploit")).toBe(60)
    expect(cryptoLexicon.baseSeverity!("Bitcoin wallet fixes critical flaw that redirected funds to attackers", "exploit")).toBe(30)
    expect(cryptoLexicon.baseSeverity!("Researcher cracks 'Steal My Bitcoin' challenge with PHP exploit", "exploit")).toBe(30)
    expect(cryptoLexicon.baseSeverity!("ETF sees $1B inflows", "etf_decision")).toBeUndefined()
  })
})

describe("source kinds (real payloads)", () => {
  it("parses RSS and Atom feeds", () => {
    const rss = parseFeed(fixture("coindesk.xml"))
    expect(rss).toHaveLength(3)
    expect(rss[0]).toMatchObject({ title: expect.any(String), url: expect.stringMatching(/^https:\/\/www\.coindesk\.com\//) })
    expect(rss[0].publishedAt?.getTime()).toBeGreaterThan(Date.UTC(2026, 0, 1))
    const atom = parseFeed(fixture("blockworks.xml"))
    expect(atom).toHaveLength(3)
    expect(atom[0].url).toMatch(/^https:\/\/blockworks\.com\//)
  })

  it("parses Statuspage incidents and maintenance with impact-based severity", () => {
    const items = parseStatuspage(JSON.parse(fixture("kraken-status.json")), "status_kraken", new Date("2026-10-27T09:30:00Z"))
    expect(items.length).toBeGreaterThan(0)
    for (const i of items) expect(i).toMatchObject({ kind: "venue", marketWide: true, url: expect.any(String) })
    expect(items.find((i) => /Order Entry/.test(i.title))?.baseSeverity).toBe(45)
    expect(items.filter((i) => i.category === "venue_outage").every((i) => i.baseSeverity === 25)).toBe(true)
  })

  it("parses Telegram channel previews", () => {
    const items = parseTelegram(fixture("telegram.html"), "whale_alert_io")
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ sourceId: expect.stringMatching(/^whale_alert_io\/\d+$/), url: expect.stringMatching(/^https:\/\/t\.me\//) })
  })

  it("maps Finnhub, DOJ and ForexFactory payloads", () => {
    const ctx = {} as SourceContext
    const fh = spec("finnhub_crypto").map!(JSON.parse(fixture("finnhub.json")), ctx)
    expect(fh).toHaveLength(3)
    expect(fh[0]).toMatchObject({ sourceId: expect.any(String), title: expect.any(String), publishedAt: expect.any(Date) })
    const doj = spec("gov:doj").map!(JSON.parse(fixture("doj.json")), ctx)
    expect(doj[0].publishedAt!.getTime()).toBeGreaterThan(Date.UTC(2026, 0, 1))
    const ff = spec("macro_ff").map!(JSON.parse(fixture("ff.json")), ctx)
    expect(ff).toHaveLength(2)
    expect(ff[0]).toMatchObject({ kind: "calendar", marketWide: true, baseSeverity: 15 })
  })

  it("diffs Kraken pairs: baseline first, then only changes", async () => {
    const body = JSON.parse(fixture("kraken-pairs.json"))
    expect([...spec("kraken_pairs").entries!(body).keys()]).toEqual(expect.arrayContaining(["BTC/USD", "ETH/USD"]))
    const json = vi.fn().mockResolvedValueOnce(body)
    const changed = structuredClone(body)
    changed.result.XXBTZUSD.status = "cancel_only"
    json.mockResolvedValueOnce(changed)
    const poll = diffPoller(spec("kraken_pairs"), { fetch: { json } as unknown as WireFetch, env: {} } as SourceContext)
    expect(await poll()).toEqual([])
    const items = (await poll())!
    expect(items).toEqual([expect.objectContaining({ symbols: ["BTC/USD"], category: "venue_status", polarity: -1 })])
    expect(diffEntries(new Map([["a", "1"]]), new Map([["b", "1"]])).map((c) => c.type).sort()).toEqual(["added", "removed"])
  })
})

describe("wire pipeline", () => {
  const db = useTestDb()

  const makeWire = async (held: string[] = [], settings: Settings["wire"] = DEFAULT_SETTINGS.wire, clock = { now: NOW }) => {
    const bus = await makeBus(db.col)
    const emitted: string[] = []
    const emit = vi.spyOn(bus, "emit")
    emit.mockImplementation(((type: string) => {
      emitted.push(type)
      return null as never
    }) as never)
    const wire = new Wire({
      col: db.col,
      bus,
      log: silentLogger,
      settings: () => settings,
      catalog: [{ id: "rss:a", kind: "rss", url: "https://a.test/feed", interval_s: 60, tier: 2, default_enabled: true }, { id: "rss:b", kind: "rss", url: "https://b.test/feed", interval_s: 60, tier: 2, default_enabled: true }],
      lexicon: cryptoLexicon,
      env: {},
      symbols: () => ({ universe: UNIVERSE, held, focus: [] }),
      price: (s) => (s === "BTC/USD" ? 80_000 : null),
      userAgent: "test",
      now: () => clock.now,
    })
    return { wire, emitted }
  }

  it("stores relevant items with tags, severity and price, and drops the rest", async () => {
    const { wire, emitted } = await makeWire(["BTC/USD"])
    const r = await wire.ingest("rss:a", [
      { title: "Bitcoin exchange hacked, $200M drained", url: "https://a.test/1" },
      { title: "Celebrity launches a perfume line", url: "https://a.test/2" },
      { title: "SEC sues crypto lender over unregistered offering", url: "https://a.test/3" },
    ])
    expect(r.stored.map((d) => d.title)).toEqual(["Bitcoin exchange hacked, $200M drained", "SEC sues crypto lender over unregistered offering"])
    expect(r.dropped).toBe(1)
    const hack = r.stored[0]
    expect(hack).toMatchObject({ symbols: ["BTC/USD"], category: "exploit", polarity: -1, tier: 2, price_at_seen: { "BTC/USD": 80_000 }, cluster_id: hack._id })
    // $200M lost: the exploit base rises to 90.
    expect(hack.severity).toBe(Math.round(90 * 0.85 + 20))
    expect(r.stored[1]).toMatchObject({ symbols: [], category: "regulatory_action" })
    expect(emitted.filter((t) => t === "wire.item")).toHaveLength(2)
    expect(await db.col.wireItems.countDocuments({})).toBe(2)
  })

  it("reads the title first: summaries only fill in when the title names nothing", async () => {
    const { wire } = await makeWire()
    const r = await wire.ingest("rss:a", [
      { title: "Initia halts its chain after a mint exploit", summary: "The attacker swapped the loot for 400 ETH.", url: "https://a.test/i" },
      { title: "CFTC staff releases updated FAQs for registrants", summary: "The FAQs cover digital asset activities.", url: "https://a.test/c" },
      { title: "Weekly market wrap", summary: "Bitcoin closed the week higher.", url: "https://a.test/w" },
    ])
    expect(r.stored.map((d) => d.symbols)).toEqual([["BTC/USD"]])
    expect(r.dropped).toBe(2)
  })

  it("turns a copy from another domain into a confirmation that raises severity and makes it notable", async () => {
    const { wire, emitted } = await makeWire(["SOL/USD"])
    const seen: { confirmation: boolean }[] = []
    wire.onItem((e) => void seen.push({ confirmation: e.confirmation }))
    const [first] = (await wire.ingest("rss:a", [{ title: "Solana lending protocol exploit drains $50M", url: "https://a.test/sol" }])).stored
    expect(first.notable).toBe(false) // tier 2, unconfirmed
    const r = await wire.ingest("rss:b", [{ title: "Solana lending protocol exploit drains $50 million", url: "https://b.test/sol" }])
    expect(r).toMatchObject({ stored: [], confirmed: 1 })
    const root = (await db.col.wireItems.findOne({ _id: first._id }))!
    expect(root.confirmations).toEqual([expect.objectContaining({ domain: "b.test" })])
    expect(root.severity).toBe(first.severity + 8)
    expect(root).toMatchObject({ notable: true, notable_reasons: ["held"] })
    expect(emitted).toContain("wire.notable")
    expect(seen).toEqual([{ confirmation: false }, { confirmation: true }])
  })

  it("remembers items across a restart and flags backfill", async () => {
    const a = await makeWire()
    await a.wire.ingest("rss:a", [{ title: "Ethereum upgrade goes live on mainnet", url: "https://a.test/eth" }], { backfill: true })
    const b = await makeWire()
    await b.wire.start()
    b.wire.stop()
    const again = await b.wire.ingest("rss:a", [{ title: "Ethereum upgrade goes live on mainnet", url: "https://a.test/eth" }])
    const copy = await b.wire.ingest("rss:b", [{ title: "Ethereum upgrade goes live on mainnet today", url: "https://b.test/eth" }])
    expect(again).toMatchObject({ stored: [], duplicates: 1 })
    expect(copy.stored).toEqual([])
    expect(await db.col.wireItems.countDocuments({})).toBe(1)
    expect((await db.col.wireItems.findOne({}))!.meta.backfill).toBe(true)
  })

  it("marks items notable once per reason, and only valid ones", async () => {
    const { wire } = await makeWire()
    const [item] = (await wire.ingest("rss:a", [{ title: "Bitcoin ETF sees record inflows", url: "https://a.test/etf" }])).stored
    // Tier 2 and unconfirmed: not valid, so not notable even when cited.
    expect(await wire.markNotable([item._id], "cited")).toEqual([])
    await db.col.wireItems.updateOne({ _id: item._id }, { $set: { tier: 1 } })
    expect(await wire.markNotable([item._id, item._id], "cited")).toEqual([item._id])
    expect(await wire.markNotable([item._id], "cited")).toEqual([])
    expect(await db.col.wireItems.findOne({ _id: item._id })).toMatchObject({ notable: true, notable_reasons: ["cited"] })
  })

  it("is inert when the wire is off, and reports disabled sources in health", async () => {
    const { wire } = await makeWire([], { ...DEFAULT_SETTINGS.wire, mode: "off" })
    expect((await wire.ingest("rss:a", [{ title: "Bitcoin hits a record", url: "https://a.test/r" }])).stored).toEqual([])
    expect(wire.health().sources.every((s) => s.state === "disabled" && s.last_error === "wire is off")).toBe(true)
  })
})

describe("wire settings", () => {
  const db = useTestDb()
  it("migrates a stored settings document from before the wire existed", async () => {
    const { wire: _wire, ...old } = DEFAULT_SETTINGS
    await db.col.settings.insertOne({ _id: "current", settings: old as Settings, version: 7, updated_at: NOW, updated_by: "owner" })
    const store = await loadSettings(db.col, { GROK_RESEARCH_MODEL: null, GROK_DECISION_MODEL: null }, silentLogger)
    expect(store.current.wire).toEqual(DEFAULT_SETTINGS.wire)
    expect(store.version).toBe(8)
  })

  it("adds the article summaries' defaults to a stored wire section, keeping the owner's values", async () => {
    const { summaries: _summaries, ...wire } = { ...DEFAULT_SETTINGS.wire, mode: "shadow" as const, retention_days: 60 }
    await db.col.settings.insertOne({ _id: "current", settings: { ...DEFAULT_SETTINGS, wire } as Settings, version: 12, updated_at: NOW, updated_by: "owner" })
    const store = await loadSettings(db.col, { GROK_RESEARCH_MODEL: null, GROK_DECISION_MODEL: null }, silentLogger)
    expect(store.current.wire).toEqual({ ...wire, summaries: DEFAULT_SETTINGS.wire.summaries })
    expect(store.version).toBe(13)
    const doc = await db.col.settings.findOne({ _id: "current" })
    expect(doc).toMatchObject({ version: 13, updated_by: "engine:migration", settings: { wire: { mode: "shadow", retention_days: 60, summaries: { enabled: true, model: "llama3.2:3b", min_severity: 55, max_per_hour: 60, pause_hours: [] } } } })
  })
})
