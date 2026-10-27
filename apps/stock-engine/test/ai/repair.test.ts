import { describe, expect, it } from "vitest"
import { repairReport } from "../../src/ai/repair"
import { botReportSchema } from "@mb/stock-core/report"
import { decision, report, watchItem } from "../helpers/factories"

/** A report-shaped object with arbitrary (possibly wrong) values, as raw model text. */
const raw = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...report(), ...overrides })

const repaired = (text: string) => {
  const result = repairReport(text)
  expect(result).not.toBeNull()
  return result!
}

describe("repairReport: extraction", () => {
  it("returns null for empty, non-JSON or broken JSON text", () => {
    expect(repairReport(undefined)).toBeNull()
    expect(repairReport("")).toBeNull()
    expect(repairReport("I could not complete the task.")).toBeNull()
    expect(repairReport('{"headline": "x", ')).toBeNull()
    expect(repairReport("} backwards {")).toBeNull()
    expect(repairReport("{ headline: 'single quotes', }")).toBeNull()
  })

  it("passes a valid report through unchanged", () => {
    const valid = report({ decisions: [decision()], watchlist: [watchItem("NVDA")] })
    const result = repaired(JSON.stringify(valid))
    expect(result.report).toEqual(valid)
    expect(result.dropped).toBe(0)
  })

  it("pulls the JSON out of prose and code fences", () => {
    const text = `Sure! Here is the report:\n\`\`\`json\n${raw()}\n\`\`\`\nLet me know if you need anything else.`
    expect(repaired(text).report.headline).toBe(report().headline)
  })

  it("refuses to invent a report with no headline or summary", () => {
    expect(repairReport(raw({ headline: "" }))).toBeNull()
    expect(repairReport(raw({ summary: undefined }))).toBeNull()
    expect(repairReport(raw({ headline: 42 }))).toBeNull()
  })

  it("rejects a market block of the wrong type", () => {
    expect(repairReport(raw({ market: "bullish" }))).toBeNull()
  })
})

describe("repairReport: numbers", () => {
  it("parses numbers sent as strings with $, %, commas and spaces", () => {
    const d = { ...decision(), allocation_pct: "12%", stop_loss: "$1,234.50", take_profit: " 1300 ", conviction: "8" }
    const result = repaired(raw({ decisions: [d] }))
    expect(result.report.decisions[0]).toMatchObject({ allocation_pct: 12, stop_loss: 1234.5, take_profit: 1300, conviction: 8 })
  })

  it("turns unreadable optional numbers into null and required ones into neutral defaults", () => {
    const d = { ...decision(), stop_loss: "n/a", take_profit: "", sell_pct: {}, conviction: "high" }
    const result = repaired(raw({ decisions: [d], market: { ...report().market, confidence: "very" } }))
    expect(result.report.decisions[0]).toMatchObject({ stop_loss: null, take_profit: null, sell_pct: null, conviction: 5 })
    expect(result.report.market.confidence).toBe(50)
  })

  it("treats non-finite numbers as missing", () => {
    // JSON can't carry Infinity, but a string can.
    const result = repaired(raw({ decisions: [{ ...decision(), stop_loss: "Infinity" }] }))
    expect(result.report.decisions[0].stop_loss).toBeNull()
  })
})

describe("repairReport: enums", () => {
  it("matches enum values ignoring case, spaces, hyphens and underscores", () => {
    const result = repaired(
      raw({
        market: { sentiment: "Very Bullish", regime: "TRENDING-UP", stance: "Defensive", confidence: 70, key_drivers: [] },
        decisions: [{ ...decision(), action: "Adjust Exits", horizon: "Multi-Day", setup: "VWAP Reclaim" }],
        watchlist: [{ ...watchItem("AMD"), setup: "Pull-Back" }],
        risks: [{ risk: "r", severity: "HIGH", mitigation: "m" }],
      }),
    )
    expect(result.report.market).toMatchObject({ sentiment: "very_bullish", regime: "trending_up", stance: "defensive" })
    expect(result.report.decisions[0]).toMatchObject({ action: "adjust_exits", horizon: "multi_day", setup: "vwap_reclaim" })
    expect(result.report.watchlist[0].setup).toBe("pullback")
    expect(result.report.risks[0].severity).toBe("high")
  })

  it("falls back to cautious defaults for unknown descriptive enums", () => {
    const result = repaired(
      raw({
        market: { sentiment: "euphoric", regime: "chaos", stance: "yolo", confidence: 50, key_drivers: [] },
        catalysts: [{ title: "CPI", detail: "d", impact: "huge", symbols: [], time_et: null, source_url: null }],
        decisions: [{ ...decision(), horizon: "forever", setup: "vibes" }],
        risks: [{ risk: "r", severity: "extreme", mitigation: "m" }],
      }),
    )
    expect(result.report.market).toMatchObject({ sentiment: "neutral", regime: "range_bound", stance: "defensive" })
    expect(result.report.catalysts[0].impact).toBe("unknown")
    expect(result.report.decisions[0]).toMatchObject({ horizon: "intraday", setup: "other" })
    expect(result.report.risks[0].severity).toBe("medium")
  })

  it("defaults a missing market block entirely", () => {
    const result = repaired(raw({ market: undefined }))
    expect(result.report.market).toEqual({ sentiment: "neutral", regime: "range_bound", stance: "defensive", confidence: 50, key_drivers: [] })
  })
})

describe("repairReport: never invents trades", () => {
  it("drops decisions with an unknown action and counts them", () => {
    const result = repaired(raw({ decisions: [{ ...decision(), action: "short" }, { ...decision({ symbol: "MSFT" }), action: "BUY" }] }))
    expect(result.report.decisions).toHaveLength(1)
    expect(result.report.decisions[0]).toMatchObject({ symbol: "MSFT", action: "buy" })
    expect(result.dropped).toBe(1)
  })

  it("drops decisions whose symbol isn't a readable ticker", () => {
    const bad = ["", "123", "TOOLONGTICKER", "NASDAQ:", "OTC:AAPL", null].map((symbol) => ({ ...decision(), symbol }))
    const result = repaired(raw({ decisions: [...bad, { ...decision(), symbol: " $brk.b " }] }))
    expect(result.report.decisions.map((d) => d.symbol)).toEqual(["BRK.B"])
    expect(result.dropped).toBe(6)
  })

  it("cleans exchange prefixes instead of dropping the decision", () => {
    const result = repaired(
      raw({
        decisions: ["NASDAQ:AAPL", "nyse:ibm", "$ARCA:SPY"].map((symbol) => ({ ...decision(), symbol })),
        watchlist: [{ ...watchItem("x"), symbol: "AMEX:GLD" }],
        catalysts: [{ title: "CPI", detail: "d", impact: "mixed", symbols: ["NASDAQ:QQQ"], time_et: null, source_url: null }],
      }),
    )
    expect(result.report.decisions.map((d) => d.symbol)).toEqual(["AAPL", "IBM", "SPY"])
    expect(result.dropped).toBe(0)
    expect(result.report.watchlist[0].symbol).toBe("GLD")
    expect(result.report.catalysts[0].symbols).toEqual(["QQQ"])
  })

  it("drops decisions that aren't objects", () => {
    const result = repaired(raw({ decisions: ["buy NVDA", 42, null, decision()] }))
    expect(result.report.decisions).toHaveLength(1)
    expect(result.dropped).toBe(3)
  })
})

describe("repairReport: shapes", () => {
  it("wraps a single item in a list", () => {
    const result = repaired(raw({ decisions: decision(), watchlist: watchItem("AMD"), lessons: "Wait for the pullback.", sources: { title: "x", url: "https://x.com" } }))
    expect(result.report.decisions).toHaveLength(1)
    expect(result.report.watchlist[0].symbol).toBe("AMD")
    expect(result.report.lessons).toEqual(["Wait for the pullback."])
    expect(result.report.sources).toEqual([{ title: "x", url: "https://x.com" }])
    // A single decision object wasn't an array, so nothing counts as dropped.
    expect(result.dropped).toBe(0)
  })

  it("fills in missing lists and strings", () => {
    const result = repaired(
      JSON.stringify({ headline: "H", summary: "S", market: report().market }),
    )
    expect(result.report).toMatchObject({ catalysts: [], watchlist: [], decisions: [], risks: [], lessons: [], next_focus: "", notification: "", sources: [] })
  })

  it("coerces strings and drops malformed list items", () => {
    const result = repaired(
      raw({
        next_focus: null,
        notification: { text: "hi" },
        decisions: [{ ...decision(), rationale: null, evidence: [5, "fact"], invalidation: undefined }],
        catalysts: [
          { title: "", detail: "no title" },
          { title: "FOMC", detail: null, impact: "mixed", symbols: ["$spy", "not a ticker!"], time_et: 1400, source_url: "" },
        ],
        risks: [{ risk: "", severity: "low" }, { risk: "Gap down", severity: "low" }],
        sources: [{ title: null, url: "https://a.com" }, { title: "no url" }],
      }),
    )
    const r = result.report
    expect(r.next_focus).toBe("")
    expect(r.notification).toBe('{"text":"hi"}')
    expect(r.decisions[0]).toMatchObject({ rationale: "", evidence: ["5", "fact"], invalidation: "" })
    expect(r.catalysts).toEqual([{ title: "FOMC", detail: "", impact: "mixed", symbols: ["SPY"], time_et: "1400", source_url: null }])
    expect(r.risks).toEqual([{ risk: "Gap down", severity: "low", mitigation: "" }])
    expect(r.sources).toEqual([{ title: "", url: "https://a.com" }])
  })

  it("always returns a report that passes the strict schema", () => {
    const messy = raw({
      market: { sentiment: "BULLISH", confidence: "80%" },
      decisions: [{ symbol: "nvda", action: "buy", allocation_pct: "10", conviction: "9" }],
      watchlist: [{ symbol: "amd" }],
    })
    const result = repaired(messy)
    expect(botReportSchema.safeParse(result.report).success).toBe(true)
    expect(result.report.decisions[0]).toMatchObject({ symbol: "NVDA", action: "buy", allocation_pct: 10, conviction: 9, horizon: "intraday", setup: "other", evidence: [] })
    expect(result.report.watchlist[0]).toMatchObject({ symbol: "AMD", conviction: 5, entry_low: null, thesis: "" })
  })
})
