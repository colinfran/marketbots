import { describe, expect, it } from "vitest"
import { daysToExpiry, describeContract, isBullish, isOptionSymbol, occSymbol, parseOcc, strategyRight } from "../src/options"
import { botReportSchema, normalizeReport, type BotReport, type Decision } from "../src/report"

describe("contract symbols", () => {
  it("parses and formats OCC-style symbols", () => {
    expect(parseOcc("NVDA261120C00140000")).toEqual({ root: "NVDA", expiration: "2026-11-20", type: "call", strike: 140 })
    expect(parseOcc("spy261218p00582500")).toEqual({ root: "SPY", expiration: "2026-12-18", type: "put", strike: 582.5 })
    expect(parseOcc("NVDA")).toBeNull()
    expect(occSymbol({ root: "SPY", expiration: "2026-12-18", type: "put", strike: 582.5 })).toBe("SPY261218P00582500")
    expect(isOptionSymbol("AAPL")).toBe(false)
    expect(isOptionSymbol("AAPL261120C00200000")).toBe(true)
  })

  it("describes contracts for people", () => {
    expect(describeContract("NVDA261120C00140000")).toBe("NVDA Nov 20 '26 140C")
    expect(describeContract("SPY261218P00582500")).toBe("SPY Dec 18 '26 582.50P")
    expect(describeContract("AAPL")).toBe("AAPL")
  })

  it("counts calendar days to expiration", () => {
    expect(daysToExpiry("2026-11-20", "2026-10-26")).toBe(25)
    expect(daysToExpiry("2026-11-20", "2026-11-20")).toBe(0)
    // Across the DST change.
    expect(daysToExpiry("2026-11-02", "2026-10-30")).toBe(3)
  })

  it("knows each strategy's direction and contract type", () => {
    expect(isBullish("call_debit_spread")).toBe(true)
    expect(isBullish("long_put")).toBe(false)
    expect(strategyRight("put_debit_spread")).toBe("put")
  })
})

describe("normalizeReport with options", () => {
  const base: BotReport = {
    headline: "h",
    summary: "s",
    market: { sentiment: "neutral", regime: "range_bound", stance: "normal", confidence: 50, key_drivers: [] },
    catalysts: [],
    watchlist: [],
    decisions: [],
    risks: [],
    lessons: [],
    next_focus: "n",
    notification: "x",
    sources: [],
  }
  const d = (overrides: Partial<Decision>): Decision => ({
    symbol: "NVDA",
    action: "buy_option",
    allocation_pct: 5,
    sell_pct: 50,
    stop_loss: 135,
    take_profit: 160,
    horizon: "multi_day",
    setup: "catalyst",
    conviction: 8,
    rationale: "r",
    evidence: [],
    invalidation: "i",
    structure_id: "opt-1",
    option: { strategy: "long_call", long_leg: " o:nvda261120c00140000 ", short_leg: "", premium_pct: 300, stop_loss_pct: 0, take_profit_pct: 5_000 },
    ...overrides,
  })

  it("cleans option orders and clears fields that don't apply", () => {
    const [n] = normalizeReport({ ...base, decisions: [d({})] }, { allowDecisions: true }).decisions
    expect(n).toMatchObject({ allocation_pct: null, sell_pct: null, structure_id: null, option: { long_leg: "NVDA261120C00140000", short_leg: null, premium_pct: 100, stop_loss_pct: null, take_profit_pct: 2_000 } })
    const [hold] = normalizeReport({ ...base, decisions: [d({ action: "hold_option", structure_id: " opt-1 " })] }, { allowDecisions: true }).decisions
    expect(hold).toMatchObject({ structure_id: "opt-1", option: null })
    expect(botReportSchema.safeParse({ ...base, decisions: [n, hold] }).success).toBe(true)
  })

  it("allows a stock decision and an options decision on the same symbol, one each", () => {
    const decisions = [d({ action: "hold", option: null }), d({ action: "buy_option" }), d({ action: "buy_option" }), d({ action: "hold", option: null })]
    expect(normalizeReport({ ...base, decisions }, { allowDecisions: true }).decisions.map((x) => x.action)).toEqual(["hold", "buy_option"])
  })
})
