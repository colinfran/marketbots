import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { describe, expect, it, vi } from "vitest"
import { silentLogger } from "@mb/engine-kit/log"
import type { WireFetch } from "../../src/wire/fetch"
import { earningsItems, parseEarnings, parseRatings, ratingItems } from "../../src/wire/sources/marketbeat"
import { fdaCalendarItems, parseFdaCalendar, PDUFA_SOURCE } from "../../src/wire/sources/pdufa"
import type { RawItem, SourceContext } from "../../src/wire/types"

const fixture = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "wire", name), "utf8")
const ctxFor = (symbols: string[], now = new Date("2026-10-27T14:00:00Z"), fetch: Partial<Record<"get", unknown>> = {}) =>
  ({
    fetch: fetch as unknown as WireFetch,
    log: silentLogger,
    env: {},
    symbols: () => ({ universe: symbols, held: [], focus: [] }),
    now: () => now,
    settings: () => DEFAULT_SETTINGS.wire,
  }) satisfies SourceContext

describe("wave 3: MarketBeat ratings", () => {
  const rows = parseRatings(fixture("marketbeat-ratings.html"))

  it("reads every row of the real table, with old and new targets and ratings", () => {
    expect(rows).toHaveLength(12)
    expect(rows[0]).toEqual({ ticker: "BAH", company: "Booz Allen Hamilton", action: "Upgraded by", broker: "TD Cowen", targetFrom: 77, targetTo: 95, ratingFrom: "Hold", ratingTo: "Buy" })
  })

  it("turns tracked rows into analyst actions with a direction and weight", () => {
    const items = ratingItems(rows, ctxFor(["BAH", "AARD", "ACN", "A", "AAP", "ACG"]))
    expect(items.map((i) => [i.title, i.polarity, i.baseSeverity])).toEqual([
      ["BAH: TD Cowen upgrades to Buy from Hold, target $77.00 to $95.00", 1, 45],
      ["AARD: Oppenheimer downgrades to Market Perform from Outperform", -1, 45],
      ["ACG: Berenberg Bank raises its target, Buy", 1, 30],
      ["ACN: Wells Fargo & Company raises target to $252.00 from $210.00, Equal Weight", 1, 30],
      ["AARD: HC Wainwright lowers target to $2.00 from $4.00, Neutral", -1, 30],
      ["A: Deutsche Bank Aktiengesellschaft initiates at Buy, target $190.00", 1, 30],
      ["AAP: Bank of America initiates at Underperform, target $42.00", -1, 30],
      ["AAP: Rothschild & Co Redburn reiterated Sell, target $45.00 to $32.00", -1, 20],
      ["AARD: HC Wainwright reiterated Hold, target $2.00", 0, 20],
    ])
    expect(items.every((i) => i.category === "analyst_action" && i.symbols?.length === 1)).toBe(true)
  })

  it("keeps a row's identity free of the date, so yesterday's rows never come back as news", () => {
    const one = ratingItems(rows, ctxFor(["BAH"], new Date("2026-10-27T14:00:00Z")))
    const next = ratingItems(rows, ctxFor(["BAH"], new Date("2026-10-28T11:00:00Z")))
    expect(one[0].sourceId).toBe(next[0].sourceId)
    expect(ratingItems(rows, ctxFor([]))).toEqual([])
  })
})

describe("wave 3: MarketBeat earnings", () => {
  const rows = parseEarnings(fixture("marketbeat-earnings.html"))

  it("reports only rows with an actual EPS, as a beat, miss or in line", () => {
    const items = earningsItems(rows, ctxFor(["KOF", "HSBC", "AMT"]))
    expect(items.map((i) => [i.title, i.polarity, i.baseSeverity, i.sourceId])).toEqual([
      ["KOF: Coca Cola Femsa reports EPS $1.72 vs $1.89 expected (miss by 9.0%); revenue $4.41 billion vs $4.31 billion expected", -1, undefined, "2026-10-27|KOF|eps"],
      ["HSBC: HSBC reports EPS $2.10 vs $2.20 expected (miss by 4.5%); revenue $18.68 billion vs $18.98 billion expected", -1, undefined, "2026-10-27|HSBC|eps"],
    ])
    const inLine = earningsItems(parseEarnings(fixture("marketbeat-earnings.html").replace(">$1.72<", ">$1.90<")), ctxFor(["KOF"]))
    expect(inLine[0]).toMatchObject({ polarity: 0, baseSeverity: 40, title: expect.stringContaining("(in line)") })
  })
})

describe("wave 3: RTTNews FDA calendar", () => {
  it("reads rows, US tickers only, the decision date, the outcome, and the later page", () => {
    const { rows, laterPage } = parseFdaCalendar(fixture("rttnews-fda-calendar.html"))
    expect(laterPage).toBe(5)
    expect(rows.find((r) => r.id === "2612")).toMatchObject({ company: "Eisai Co Ltd", tickers: [], due: "2026-10-04", outcome: null })
    expect(rows.find((r) => r.id === "2621")).toMatchObject({ tickers: ["IONS"], due: "2026-10-26", outcomeDay: "2026-10-20", outcome: expect.stringMatching(/^FDA approved Hibsago/) })
    expect(rows.find((r) => r.id === "2656")).toMatchObject({ tickers: ["PFE"], due: null })
    expect(parseFdaCalendar(fixture("rttnews-fda-calendar-p1.html")).laterPage).toBeNull()
  })

  it("lists decisions due within three weekdays as calendar items, one a day", () => {
    const { rows } = parseFdaCalendar(fixture("rttnews-fda-calendar-p1.html"))
    const items = fdaCalendarItems(rows, ctxFor(["INSM", "PRAX", "BBIO"], new Date("2027-01-27T15:00:00Z")))
    expect(items.map((i) => [i.symbols, i.kind, i.polarity, i.sourceId, i.meta?.event_at])).toEqual([
      [["INSM"], "calendar", 0, "2689|due|2027-01-27", "2027-01-29T01:00:00.000Z"],
      [["PRAX"], "calendar", 0, "2583|due|2027-01-27", "2027-01-30T01:00:00.000Z"],
    ])
    expect(items[0].title).toBe("INSM: FDA decision due Jan 28 on ARIKAYCE (sNDA) (Insmed Inc)")
  })

  it("reports outcomes from the last three days, approvals as good news", () => {
    const { rows } = parseFdaCalendar(fixture("rttnews-fda-calendar.html"))
    const items = fdaCalendarItems(rows, ctxFor(["IONS", "PFE", "MRK", "VTRS"]))
    expect(items.map((i) => [i.symbols?.[0], i.polarity, i.publishedAt])).toEqual([
      ["PFE", 1, new Date("2026-10-26T00:00:00Z")],
    ])
    // IONS was approved on 10/20: older than three days.
    expect(items.some((i) => i.symbols?.[0] === "IONS")).toBe(false)
    expect(items.every((i) => i.category === "fda" && i.kind !== "calendar")).toBe(true)
  })

  it("reads the current page, then walks to later pages until there are none", async () => {
    const get = vi.fn(async (url: string) => ({ status: 200, notModified: false, text: url.includes("PageNum=5") ? fixture("rttnews-fda-calendar-p1.html") : fixture("rttnews-fda-calendar.html") }))
    const ctx = ctxFor(["PFE"], new Date("2026-10-27T14:00:00Z"), { get })
    const src = PDUFA_SOURCE.create!(PDUFA_SOURCE, ctx) as unknown as { tick: (emit: (items: RawItem[]) => Promise<void>) => Promise<void> }
    let got: RawItem[] = []
    await src.tick(async (items) => {
      got = items
    })
    expect(get.mock.calls.map((c) => c[0])).toEqual(["https://www.rttnews.com/corpinfo/fdacalendar.aspx", "https://www.rttnews.com/corpinfo/fdacalendar.aspx?PageNum=5"])
    expect(got.map((i) => i.symbols?.[0])).toEqual(["PFE"])
  })
})
