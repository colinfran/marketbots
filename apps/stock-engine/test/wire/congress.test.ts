import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import type { WireItemDoc } from "@mb/stock-core/wire"
import { describe, expect, it } from "vitest"
import { silentLogger } from "../../src/log"
import { HttpError } from "../../src/util/http"
import type { WireFetch } from "../../src/wire/fetch"
import { stockRules } from "../../src/wire/policy"
import { CONGRESS_SOURCE, congressItems, congressPoll, districtLabel, indexYears, parseFilingIndex, parsePtr, pdfText, tickerOf, unzip, type BinaryGet, type Filing, type Ptr } from "../../src/wire/sources/congress"
import type { SourceContext, SymbolSets } from "../../src/wire/types"

/**
 * Fixtures are real House Clerk files (fetched 2026-10-27): a trimmed 2026FD.zip (nine rows of
 * the index and their XML twins, re-zipped with .NET's ZipFile), and three e-filed PTRs, untrimmed:
 *   20035700  Rep. Issa: Treasury notes only (no stock rows)
 *   20033725  Rep. Pelosi: 18 spouse rows over 3 pages (stock, call options, partial sales, an
 *             exchange, one row broken across a page)
 *   20035669  Rep. Fields: four self-owned purchases, three of them identical (one per account)
 */

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, "..", "fixtures", "wire", name)))
const ZIP = fixture("house-fd-index.zip")
const ISSA = fixture("house-ptr-20035700.pdf")
const PELOSI = fixture("house-ptr-20033725.pdf")
const FIELDS = fixture("house-ptr-20035669.pdf")
const HOUSE = "https://disclosures-clerk.house.gov/public_disc"

/** A one-page PDF with no text layer: what a scanned paper filing is to pdf.js. */
const blankPdf = () => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"]
  let s = "%PDF-1.4\n"
  const offsets = objects.map((o, i) => {
    const at = s.length
    s += `${i + 1} 0 obj\n${o}\nendobj\n`
    return at
  })
  const xref = s.length
  s += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
  s += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(s)
}

const makeCtx = (clock: { now: Date }, symbols: SymbolSets = { universe: ["SPY", "QQQ"], held: ["NVDA"], focus: ["AAPL"] }) =>
  ({
    fetch: {} as unknown as WireFetch,
    log: silentLogger,
    env: {},
    symbols: () => symbols,
    now: () => clock.now,
    settings: () => DEFAULT_SETTINGS.wire,
  }) satisfies SourceContext

const index = () => parseFilingIndex(unzip(ZIP).get("2026FD.txt")!.toString("utf8"))
const filing = (docId: string) => index().find((f) => f.docId === docId)!

describe("congress: House filing index", () => {
  it("reads the index ZIP through its central directory, inflating only the entries asked for", () => {
    const all = unzip(ZIP)
    expect([...all.keys()]).toEqual(["2026FD.txt", "2026FD.xml"])
    expect(all.get("2026FD.txt")!.toString("utf8")).toMatch(/^Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tYear\tFilingDate\tDocID\r\n/)
    expect(all.get("2026FD.xml")!.toString("utf8")).toContain("<DocID>20035669</DocID>")
    expect([...unzip(ZIP, (name) => name.endsWith(".txt")).keys()]).toEqual(["2026FD.txt"])
    expect(() => unzip(new TextEncoder().encode("<html>Not Found</html>"))).toThrow(/not a ZIP/)
  })

  it("parses the tab-separated index, periodic transaction reports among the other filings", () => {
    const rows = index()
    expect(rows).toHaveLength(9)
    expect(rows.filter((f) => f.type === "P").map((f) => f.docId)).toEqual(["20035669", "20035590", "20035700", "9116378", "20033725", "20035660"])
    expect(filing("20035669")).toEqual<Filing>({ docId: "20035669", type: "P", year: "2026", filed: "2026-10-22", first: "Cleo", last: "Fields", suffix: "", district: "LA06" })
    expect(filing("20033725")).toMatchObject({ first: "Nancy", last: "Pelosi", filed: "2026-01-23", district: "CA11" })
    expect(() => parseFilingIndex("<html>maintenance</html>")).toThrow(/unexpected filing index header/)
    // Late-December reports are still in the window in early January.
    expect(indexYears("2026-01-05")).toEqual([2025, 2026])
    expect(indexYears("2026-01-15")).toEqual([2026])
    expect(indexYears("2026-10-27")).toEqual([2026])
  })
})

describe("congress: PTR PDFs", () => {
  it("reads the table of the sample filing: Treasury notes, no ticker", async () => {
    const ptr = parsePtr(await pdfText(ISSA))
    expect(ptr.name).toBe("Darrell E. Issa")
    expect(ptr.district).toBe("CA48")
    expect(ptr.rows).toEqual([
      {
        owner: "self",
        asset: "US Treasury Note 3.375% due 09/15/28 CUSIP 91282CNY3",
        assetType: "GS",
        ticker: null,
        type: "purchase",
        tradeDate: "2026-10-08",
        notifiedDate: "2026-10-09",
        amount: "$5,000,001 - $25,000,000",
        low: 5_000_001,
        high: 25_000_000,
        status: "New",
        description: "Purchase of US Treasury Bond with $10 million face value",
      },
      expect.objectContaining({ type: "sale", tradeDate: "2026-10-14", assetType: "GS", ticker: null, description: "Sale of US Treasury Note before Maturity. Face Value $10 million" }),
    ])
    // Not a stock: nothing to report even if we followed every symbol.
    expect(congressItems(filing("20035700"), ptr, new Set(["GS", "CUSIP", "NVDA"]))).toEqual([])
  })

  it("reads a three-page spouse report: options, partial sales, an exchange, a row broken across pages", async () => {
    const ptr = parsePtr(await pdfText(PELOSI))
    expect(ptr.name).toBe("Nancy Pelosi")
    expect(ptr.rows).toHaveLength(18)
    expect(ptr.rows.every((r) => r.owner === "spouse" && r.status === "New")).toBe(true)
    expect(ptr.rows.map((r) => `${r.ticker} ${r.assetType} ${r.type}`)).toEqual([
      "AB AB purchase",
      "GOOGL ST purchase",
      "GOOGL OP purchase",
      "GOOGL ST sale_partial",
      "AMZN OP purchase",
      "AMZN ST sale_partial",
      "AMZN ST purchase",
      "AAPL ST sale_partial",
      "AAPL OP purchase",
      "AAPL ST sale_partial",
      "NVDA OP purchase",
      "NVDA ST sale_partial",
      "NVDA ST purchase",
      "PYPL ST sale",
      "TEM ST purchase",
      "VSNT ST exchange",
      "VST ST purchase",
      "DIS ST sale",
    ])
    // Its description continues at the top of page 2.
    expect(ptr.rows[5]).toMatchObject({ ticker: "AMZN", tradeDate: "2025-12-24", amount: "$1,000,001 - $5,000,000", description: "Sold 20,000 shares." })
    // Asset name and amount split between pages 2 and 3, under page 3's header.
    expect(ptr.rows[14]).toMatchObject({ asset: "Tempus AI, Inc. - Class A Common Stock (TEM)", amount: "$50,001 - $100,000", low: 50_001, high: 100_000, tradeDate: "2026-01-16" })
    expect(ptr.rows[14].description).toMatch(/^Exercised 50 call options .* expiration date of 1\/16\/26\.$/)
    // An exchange states a value, not a range.
    expect(ptr.rows[15]).toMatchObject({ amount: "$15.00", low: 15, high: 15 })
  })

  it("skips scanned and unreadable files", async () => {
    // A paper filing is page images: pdf.js finds no text, so no table and no rows.
    expect(await pdfText(blankPdf())).toEqual([[]])
    expect(parsePtr(await pdfText(blankPdf()))).toEqual({ name: null, district: null, rows: [] })
    await expect(pdfText(new TextEncoder().encode("<html>Not Found</html>"))).rejects.toThrow()
  })

  it("finds the ticker before the asset-type code and labels seats", () => {
    expect(tickerOf("Alphabet Inc. - Class A Common Stock (GOOGL) [OP]")).toBe("GOOGL")
    expect(tickerOf("Berkshire Hathaway Inc. New (BRK-B) [ST]")).toBe("BRK.B")
    expect(tickerOf("AT&T Inc. (T) [ST]")).toBe("T")
    expect(tickerOf("US Treasury Note 3.375% due 09/15/28 CUSIP 91282CNY3 [GS]")).toBeNull()
    expect(tickerOf("Charles Schwab 401K (Hantz) [OT]")).toBeNull()
    expect(districtLabel("CA48")).toBe("CA-48")
    expect(districtLabel("WY00")).toBe("WY-AL")
  })
})

describe("congress: items", () => {
  it("one item per transaction in a stock we follow (options count for the underlying), never insider-flagged", async () => {
    const ptr = parsePtr(await pdfText(PELOSI))
    const items = congressItems(filing("20033725"), ptr, new Set(["NVDA", "AAPL", "AB"]))
    // AB is a partnership unit ([AB]), not a stock; GOOGL, AMZN and the rest aren't followed.
    expect(items.map((i) => i.title)).toEqual([
      "AAPL: Rep. Nancy Pelosi (CA-11) sold $5M–$25M (partial sale) on 2025-12-24 (spouse; disclosed 2026-01-23)",
      "AAPL: Rep. Nancy Pelosi (CA-11) bought $250K–$500K of call options on 2025-12-30 (spouse; disclosed 2026-01-23)",
      "AAPL: Rep. Nancy Pelosi (CA-11) sold $5M–$25M (partial sale) on 2025-12-30 (spouse; disclosed 2026-01-23)",
      "NVDA: Rep. Nancy Pelosi (CA-11) bought $100K–$250K of call options on 2025-12-30 (spouse; disclosed 2026-01-23)",
      "NVDA: Rep. Nancy Pelosi (CA-11) sold $1M–$5M (partial sale) on 2025-12-24 (spouse; disclosed 2026-01-23)",
      "NVDA: Rep. Nancy Pelosi (CA-11) bought $250K–$500K on 2026-01-16 (spouse; disclosed 2026-01-23)",
    ])
    expect(items.map((i) => i.polarity)).toEqual([-1, 1, -1, 1, -1, 1])
    expect(items[3]).toEqual({
      sourceId: "20033725:NVDA:spouse:purchase:2025-12-30:OP:call",
      title: "NVDA: Rep. Nancy Pelosi (CA-11) bought $100K–$250K of call options on 2025-12-30 (spouse; disclosed 2026-01-23)",
      summary: "NVIDIA Corporation - Common Stock (NVDA): Purchased 20 call options with a strike price of $100 and an expiration date of 1/15/27.",
      url: `${HOUSE}/ptr-pdfs/2026/20033725.pdf`,
      publishedAt: new Date("2026-01-23T00:00:00Z"),
      symbols: ["NVDA"],
      category: "general",
      kind: "filing",
      tier: 3,
      polarity: 1,
      baseSeverity: 25,
      meta: {
        congress: true,
        member: "Nancy Pelosi",
        district: "CA-11",
        owner: "spouse",
        transaction: "purchase",
        asset_type: "OP",
        option: "call",
        amount_range: "$100,001 - $250,000",
        amount_low: 100_001,
        amount_high: 250_000,
        transactions: 1,
        trade_date: "2025-12-30",
        filed: "2026-01-23",
        doc_id: "20033725",
      },
    })
    expect(items.every((i) => i.meta?.congress === true && i.meta.insider === undefined)).toBe(true)

    // A put bought is bearish.
    const put: Ptr = { ...ptr, rows: [{ ...ptr.rows[10], description: "Purchased 10 put options with a strike price of $90." }] }
    expect(congressItems(filing("20033725"), put, new Set(["NVDA"]))[0]).toMatchObject({ polarity: -1, title: expect.stringContaining("bought $100K–$250K of put options") })
  })

  it("adds up identical rows, one per brokerage account, into one item", async () => {
    const ptr = parsePtr(await pdfText(FIELDS))
    expect(ptr.rows.map((r) => `${r.owner} ${r.ticker} ${r.tradeDate}`)).toEqual(["self NVDA 2026-10-01", "self NVDA 2026-10-01", "self NVDA 2026-10-01", "self TSM 2026-10-09"])
    const items = congressItems(filing("20035669"), ptr, new Set(["NVDA"]))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: "NVDA: Rep. Cleo Fields (LA-06) bought $3K–$45K in 3 transactions on 2026-10-01 (disclosed 2026-10-22)",
      summary: "NVIDIA Corporation - Common Stock (NVDA)",
      meta: { owner: "self", transactions: 3, amount_low: 3_003, amount_high: 45_000, amount_range: "$1,001 - $15,000" },
    })
  })
})

describe("congress: polling", () => {
  /** The House site as a map of URLs; the ZIP answers 304 to its own ETag. */
  const house = (files: Record<string, Uint8Array | Error>) => {
    const calls: string[] = []
    const get: BinaryGet = async (url, headers) => {
      calls.push(url.replace(`${HOUSE}/`, ""))
      if (url.endsWith(".zip") && headers["if-none-match"] === '"fd-1"') return { status: 304, body: new Uint8Array(0), headers: new Headers() }
      const body = files[url.replace(`${HOUSE}/`, "")]
      if (body instanceof Error) throw body
      if (!body) throw new HttpError(404, `GET ${new URL(url).pathname} failed (404)`, "")
      return { status: 200, body, headers: new Headers(url.endsWith(".zip") ? { etag: '"fd-1"', "last-modified": "Thu, 22 Oct 2026 13:00:51 GMT" } : {}) }
    }
    return { get, calls }
  }

  it("reads each new report once, a few at a time, backfilling only the last days after boot", async () => {
    // 20035660 (Taylor) is listed but its PDF isn't up; 9116378 (McCaul) is a scanned paper filing.
    const { get, calls } = house({ "financial-pdfs/2026FD.zip": ZIP, "ptr-pdfs/2026/20035669.pdf": FIELDS, "ptr-pdfs/2026/20035700.pdf": ISSA, "ptr-pdfs/2026/9116378.pdf": blankPdf() })
    const clock = { now: new Date("2026-10-17T15:00:00Z") }
    const poll = congressPoll(makeCtx(clock), { get, pauseMs: 0, maxPdfs: 2 })

    // First poll: the last 3 days only. Gottheimer's 10/07 report counts as read without a fetch.
    expect(await poll()).toEqual([])
    expect(calls.splice(0)).toEqual(["financial-pdfs/2026FD.zip", "ptr-pdfs/2026/20035660.pdf", "ptr-pdfs/2026/9116378.pdf"])

    // Five days on, the index unchanged (304): the two new reports, newest first, at most two a poll.
    clock.now = new Date("2026-10-22T15:00:00Z")
    const items = await poll()
    expect(calls.splice(0)).toEqual(["financial-pdfs/2026FD.zip", "ptr-pdfs/2026/20035700.pdf", "ptr-pdfs/2026/20035669.pdf"])
    // Fields' NVDA buys (held); TSM isn't followed and Issa's Treasuries aren't stocks.
    expect(items?.map((i) => i.title)).toEqual(["NVDA: Rep. Cleo Fields (LA-06) bought $3K–$45K in 3 transactions on 2026-10-01 (disclosed 2026-10-22)"])

    // The missing PDF is retried for three polls in all, without failing the poll, then given up on.
    expect(await poll()).toEqual([])
    expect(await poll()).toEqual([])
    expect(calls.splice(0)).toEqual(["financial-pdfs/2026FD.zip", "ptr-pdfs/2026/20035660.pdf", "financial-pdfs/2026FD.zip", "ptr-pdfs/2026/20035660.pdf"])
    // Nothing left and the index unchanged: "nothing new".
    expect(await poll()).toBeNull()
    expect(calls).toEqual(["financial-pdfs/2026FD.zip"])
  })

  it("skips unreadable PDFs for good, fails the poll when every fetch fails, and stops when blocked", async () => {
    const clock = { now: new Date("2026-10-22T15:00:00Z") }
    const broken = house({ "financial-pdfs/2026FD.zip": ZIP, "ptr-pdfs/2026/20035669.pdf": new TextEncoder().encode("<html>Server Error</html>"), "ptr-pdfs/2026/20035700.pdf": ISSA })
    const poll = congressPoll(makeCtx(clock), { get: broken.get, pauseMs: 0 })
    expect(await poll()).toEqual([])
    expect(await poll()).toBeNull()
    expect(broken.calls.filter((c) => c.endsWith(".pdf"))).toEqual(["ptr-pdfs/2026/20035700.pdf", "ptr-pdfs/2026/20035669.pdf"])

    const down = house({ "financial-pdfs/2026FD.zip": ZIP, "ptr-pdfs/2026/20035669.pdf": new Error("ECONNRESET"), "ptr-pdfs/2026/20035700.pdf": new Error("ECONNRESET") })
    await expect(congressPoll(makeCtx(clock), { get: down.get, pauseMs: 0 })()).rejects.toThrow("ECONNRESET")

    const blocked = house({ "financial-pdfs/2026FD.zip": ZIP, "ptr-pdfs/2026/20035669.pdf": FIELDS, "ptr-pdfs/2026/20035700.pdf": new HttpError(429, "GET failed (429)", "") })
    await expect(congressPoll(makeCtx(clock), { get: blocked.get, pauseMs: 0 })()).rejects.toMatchObject({ status: 429 })
    expect(blocked.calls).toEqual(["financial-pdfs/2026FD.zip", "ptr-pdfs/2026/20035700.pdf"])
  })

  it("is a 6-hourly tier-3 custom source", () => {
    expect(CONGRESS_SOURCE).toMatchObject({ id: "congress:house", kind: "custom", tier: 3, interval_s: 21_600, default_enabled: true, wire_kind: "filing" })
    expect(CONGRESS_SOURCE.create).toBeTypeOf("function")
  })
})

describe("congress: policy", () => {
  it("never starts a cycle on a congressional trade, bought or sold, held or not", async () => {
    const base: WireItemDoc = {
      _id: "x",
      cluster_id: "x",
      source: "congress:house",
      tier: 3,
      kind: "filing",
      category: "general",
      title: "NVDA: Rep. Cleo Fields (LA-06) bought $3K–$45K in 3 transactions on 2026-10-01 (disclosed 2026-10-22)",
      summary: null,
      url: `${HOUSE}/ptr-pdfs/2026/20035669.pdf`,
      domain: "disclosures-clerk.house.gov",
      symbols: ["NVDA"],
      published_at: new Date("2026-10-22T00:00:00Z"),
      first_seen_at: new Date("2026-10-22T15:00:00Z"),
      polarity: 1,
      severity: 90,
      severity_parts: {},
      confirmations: [],
      price_at_seen: {},
      meta: { congress: true, transaction: "purchase" },
      notable: false,
      notable_reasons: [],
      expires_at: new Date("2026-11-22T00:00:00Z"),
    }
    const ctx = { held: new Set(["NVDA"]), universe: new Set(["NVDA", "AAPL"]), settings: DEFAULT_SETTINGS, now: new Date("2026-10-22T15:00:00Z"), hasRecentNews: async () => false }
    expect(await stockRules({ ...base, symbols: ["AAPL"] }, ctx)).toEqual([])
    expect(await stockRules({ ...base, polarity: -1, meta: { congress: true, transaction: "sale" } }, ctx)).toEqual([])
    // Without the flag, the same loud item would be an entry on AAPL and a review of held NVDA.
    expect(await stockRules({ ...base, symbols: ["AAPL"], meta: {} }, ctx)).not.toEqual([])
    expect(await stockRules({ ...base, polarity: -1, meta: {} }, ctx)).not.toEqual([])
  })
})
