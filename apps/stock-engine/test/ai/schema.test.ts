import { describe, expect, it } from "vitest"
import { ACTIONS, botReportSchema, decisionSchema, HORIZONS, normalizeReport, SETUPS } from "@mb/stock-core/report"
import { decision, report, watchItem } from "../helpers/factories"

const trade = { allowDecisions: true }

describe("botReportSchema", () => {
  it("accepts a complete report", () => {
    expect(botReportSchema.safeParse(report({ decisions: [decision()], watchlist: [watchItem("NVDA")] })).success).toBe(true)
  })

  it("rejects unknown enum values and missing fields", () => {
    expect(botReportSchema.safeParse({ ...report(), market: { ...report().market, sentiment: "euphoric" } }).success).toBe(false)
    const missing: Partial<ReturnType<typeof report>> = report()
    delete missing.headline
    expect(botReportSchema.safeParse(missing).success).toBe(false)
  })

  it("rejects numbers sent as strings (the repair layer handles those)", () => {
    expect(decisionSchema.safeParse({ ...decision(), conviction: "8" }).success).toBe(false)
  })

  it("exposes the enums the execution engine relies on", () => {
    expect(ACTIONS).toEqual(["buy", "sell", "adjust_exits", "hold", "buy_option", "close_option", "hold_option"])
    expect(HORIZONS).toEqual(["intraday", "overnight", "multi_day"])
    expect(SETUPS).toContain("other")
  })
})

describe("normalizeReport: decisions", () => {
  it("drops every decision in planning phases", () => {
    expect(normalizeReport(report({ decisions: [decision()] }), { allowDecisions: false }).decisions).toEqual([])
  })

  it("cleans tickers", () => {
    const out = normalizeReport(
      report({
        decisions: [
          decision({ symbol: " $nvda " }),
          decision({ symbol: "NASDAQ:AAPL" }),
          decision({ symbol: "nyse:ibm" }),
          decision({ symbol: "ARCA:SPY" }),
          decision({ symbol: "AMEX:GLD" }),
        ],
      }),
      trade,
    )
    expect(out.decisions.map((d) => d.symbol)).toEqual(["NVDA", "AAPL", "IBM", "SPY", "GLD"])
  })

  it("keeps one decision per symbol (the first wins, after cleaning)", () => {
    const out = normalizeReport(
      report({ decisions: [decision({ symbol: "aapl", action: "sell", sell_pct: 50 }), decision({ symbol: "$AAPL", action: "buy" }), decision({ symbol: "MSFT" })] }),
      trade,
    )
    expect(out.decisions).toHaveLength(2)
    expect(out.decisions[0]).toMatchObject({ symbol: "AAPL", action: "sell" })
  })

  it("keeps allocation_pct only on buys, clamped to 0–100", () => {
    const out = normalizeReport(
      report({
        decisions: [
          decision({ symbol: "A", allocation_pct: 12.3456 }),
          decision({ symbol: "B", allocation_pct: 250 }),
          decision({ symbol: "C", allocation_pct: -5 }),
          decision({ symbol: "D", allocation_pct: null }),
          decision({ symbol: "E", action: "hold", allocation_pct: 10 }),
        ],
      }),
      trade,
    )
    expect(out.decisions.map((d) => d.allocation_pct)).toEqual([12.35, 100, 0, null, null])
  })

  it("defaults sell_pct to 100 and clamps it to 1–100, on sells only", () => {
    const out = normalizeReport(
      report({
        decisions: [
          decision({ symbol: "A", action: "sell", sell_pct: null }),
          decision({ symbol: "B", action: "sell", sell_pct: 0 }),
          decision({ symbol: "C", action: "sell", sell_pct: 140 }),
          decision({ symbol: "D", action: "sell", sell_pct: 33.333 }),
          decision({ symbol: "E", action: "buy", sell_pct: 50 }),
        ],
      }),
      trade,
    )
    expect(out.decisions.map((d) => d.sell_pct)).toEqual([100, 1, 100, 33.33, null])
  })

  it("nulls out unusable prices and rounds the rest to cents", () => {
    const out = normalizeReport(
      report({
        decisions: [
          decision({ symbol: "A", stop_loss: 98.555, take_profit: 105.123 }),
          decision({ symbol: "B", stop_loss: 0, take_profit: -1 }),
          decision({ symbol: "C", stop_loss: NaN, take_profit: Infinity }),
        ],
      }),
      trade,
    )
    expect(out.decisions.map((d) => [d.stop_loss, d.take_profit])).toEqual([
      [98.56, 105.12],
      [null, null],
      [null, null],
    ])
  })

  it("rounds conviction and clamps it to 1–10", () => {
    const out = normalizeReport(
      report({ decisions: [decision({ symbol: "A", conviction: 7.6 }), decision({ symbol: "B", conviction: 0 }), decision({ symbol: "C", conviction: 42 })] }),
      trade,
    )
    expect(out.decisions.map((d) => d.conviction)).toEqual([8, 1, 10])
  })

  it("keeps at most 5 pieces of evidence", () => {
    const out = normalizeReport(report({ decisions: [decision({ evidence: ["1", "2", "3", "4", "5", "6", "7"] })] }), trade)
    expect(out.decisions[0].evidence).toEqual(["1", "2", "3", "4", "5"])
  })
})

describe("normalizeReport: everything else", () => {
  it("trims and truncates the headline and notification", () => {
    const out = normalizeReport(report({ headline: `  ${"h".repeat(200)}  `, notification: ` ${"n".repeat(300)} ` }), trade)
    expect(out.headline).toHaveLength(140)
    expect(out.headline.endsWith("…")).toBe(true)
    expect(out.notification).toHaveLength(180)
    expect(normalizeReport(report({ headline: "  Short  " }), trade).headline).toBe("Short")
  })

  it("bounds the market read", () => {
    const market = { ...report().market, confidence: 140.4, key_drivers: ["1", "2", "3", "4", "5", "6", "7", "8"] }
    const out = normalizeReport(report({ market }), trade)
    expect(out.market.confidence).toBe(100)
    expect(out.market.key_drivers).toHaveLength(6)
    expect(normalizeReport(report({ market: { ...market, confidence: -3 } }), trade).market.confidence).toBe(0)
    expect(normalizeReport(report({ market: { ...market, confidence: 66.5 } }), trade).market.confidence).toBe(67)
  })

  it("limits catalysts, cleans their tickers and drops non-http links", () => {
    const catalyst = (i: number, url: string | null) => ({
      title: `c${i}`,
      detail: "d",
      impact: "bullish" as const,
      symbols: ["$nvda", "NASDAQ:amd"],
      time_et: "08:30",
      source_url: url,
    })
    const out = normalizeReport(
      report({ catalysts: [catalyst(0, "https://x.com/a"), catalyst(1, "javascript:alert(1)"), catalyst(2, null), ...Array.from({ length: 8 }, (_, i) => catalyst(i + 3, "http://a.b"))] }),
      trade,
    )
    expect(out.catalysts).toHaveLength(8)
    expect(out.catalysts[0].symbols).toEqual(["NVDA", "AMD"])
    expect(out.catalysts.map((c) => c.source_url).slice(0, 3)).toEqual(["https://x.com/a", null, null])
  })

  it("limits and cleans the watchlist", () => {
    const out = normalizeReport(
      report({
        watchlist: [
          watchItem("$tsla", { entry_low: 0, entry_high: 250.456, stop_loss: -1, take_profit: 270.001, conviction: 11 }),
          ...Array.from({ length: 15 }, (_, i) => watchItem(`W${i}`)),
        ],
      }),
      trade,
    )
    expect(out.watchlist).toHaveLength(12)
    expect(out.watchlist[0]).toMatchObject({ symbol: "TSLA", entry_low: null, entry_high: 250.46, stop_loss: null, take_profit: 270, conviction: 10 })
  })

  it("keeps the watchlist in planning phases (only decisions are dropped)", () => {
    expect(normalizeReport(report({ watchlist: [watchItem("NVDA")] }), { allowDecisions: false }).watchlist).toHaveLength(1)
  })

  it("limits risks and lessons to 6 and sources to 10 valid URLs", () => {
    const risk = { risk: "r", severity: "low" as const, mitigation: "m" }
    const out = normalizeReport(
      report({
        risks: Array(9).fill(risk),
        lessons: Array(9).fill("lesson"),
        sources: [{ title: "bad", url: "ftp://x" }, { title: "rel", url: "/relative" }, ...Array.from({ length: 12 }, (_, i) => ({ title: `s${i}`, url: `https://s${i}.com` }))],
      }),
      trade,
    )
    expect(out.risks).toHaveLength(6)
    expect(out.lessons).toHaveLength(6)
    expect(out.sources).toHaveLength(10)
    expect(out.sources[0].url).toBe("https://s0.com")
  })

  it("does not mutate its input", () => {
    const input = report({ headline: "  x  ", decisions: [decision({ symbol: "$aapl", conviction: 99 })] })
    const copy = structuredClone(input)
    normalizeReport(input, trade)
    expect(input).toEqual(copy)
  })

  it("produces output that still matches the schema", () => {
    const out = normalizeReport(report({ decisions: [decision({ symbol: "$x", conviction: 99, allocation_pct: 500 })] }), trade)
    expect(botReportSchema.safeParse(out).success).toBe(true)
  })
})
