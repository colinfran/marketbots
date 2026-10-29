import { describe, expect, it } from "vitest"
import { normalizeStockAgentDecisions, type StockAgentAnswer } from "../src/agent"

type Dec = StockAgentAnswer["decisions"][number]

const decision = (over: Partial<Dec> = {}): Dec => ({
  symbol: "aapl",
  action: "buy",
  allocation_pct: 5,
  sell_pct: null,
  stop_loss: 196,
  take_profit: 210,
  horizon: "intraday",
  setup: "breakout",
  conviction: 7,
  rationale: "Opening-range breakout on volume.",
  evidence: ["volume 3×"],
  invalidation: "Back inside the range.",
  structure_id: null,
  option: null,
  ...over,
})

const known = (s: string) => s !== "ZZZZ"

describe("stock agent decisions", () => {
  it("keeps known tickers only, the first per ticker and instrument", () => {
    const r = normalizeStockAgentDecisions([decision(), decision({ action: "hold" }), decision({ symbol: "ZZZZ" })], { known })
    expect(r.decisions.map((d) => [d.symbol, d.action])).toEqual([["AAPL", "buy"]])
    expect(r.dropped).toEqual(["ZZZZ: not a ticker the agent may trade"])
  })

  it("keeps a decision for everything held, and at most three new entries", () => {
    // A review of six holdings: none is cut.
    const holds = ["AHR", "DIA", "IWM", "SOFI", "SPY", "TEVA"].map((symbol) => decision({ symbol, action: "hold" }))
    expect(normalizeStockAgentDecisions(holds, { known }).decisions).toHaveLength(6)
    // Five buys and a sale: three buys and the sale are kept.
    const buys = ["A", "B", "C", "D", "E"].map((symbol) => decision({ symbol }))
    const r = normalizeStockAgentDecisions([...buys, decision({ symbol: "TEVA", action: "sell", sell_pct: 100 })], { known })
    expect(r.decisions.map((d) => [d.symbol, d.action])).toEqual([
      ["A", "buy"],
      ["B", "buy"],
      ["C", "buy"],
      ["TEVA", "sell"],
    ])
    expect(r.dropped).toEqual(["D: more than 3 new entries", "E: more than 3 new entries"])
  })
})
