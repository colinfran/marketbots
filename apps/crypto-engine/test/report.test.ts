import { normalizeCryptoReport, type CryptoDecision, type CryptoReport } from "@mb/crypto-core/report"
import { describe, expect, it } from "vitest"

const decision = (overrides: Partial<CryptoDecision> = {}): CryptoDecision => ({
  symbol: "BTC/USD",
  action: "buy",
  conviction: 72,
  uncertainty: "medium",
  p_target_first: 0.45,
  stop_loss: 63_000,
  take_profit: 70_000,
  horizon_hours: 48,
  size_pct_of_max: 60,
  reduce_pct: null,
  priced_in: "partially",
  thesis: "Breakout with ETF inflows.",
  bull_evidence: [{ claim: "ETF inflows of $500M", kind: "sourced_claim", source_url: "https://news.example/etf", as_of: "2026-10-25" }],
  bear_evidence: [{ claim: "Funding is elevated", kind: "speculation", source_url: "https://invented.example/x", as_of: null }],
  risks: ["macro data tomorrow"],
  invalidation: "Close below 63,000",
  ...overrides,
})

const report = (decisions: CryptoDecision[]): CryptoReport => ({
  market_read: { regime: "risk_on_trend", summary: "Risk-on.", confidence: 70 },
  decisions,
  data_gaps: [],
  notification: "Buying BTC",
})

const ctx = { candidates: new Set(["BTC/USD", "SOL/USD"]), held: new Set(["ETH/USD"]), sourceUrls: new Set(["https://news.example/etf"]) }

describe("normalizeCryptoReport", () => {
  it("keeps only listed symbols, one decision each", () => {
    const n = normalizeCryptoReport(report([decision(), decision({ conviction: 10 }), decision({ symbol: "PEPE/USD" })]), ctx)
    expect(n.decisions.filter((d) => d.symbol === "BTC/USD")).toHaveLength(1)
    expect(n.decisions.find((d) => d.symbol === "PEPE/USD")).toBeUndefined()
    expect(n.decisions.find((d) => d.symbol === "BTC/USD")?.conviction).toBe(72)
  })

  it("defaults every listed symbol the AI skipped", () => {
    const n = normalizeCryptoReport(report([decision()]), ctx)
    expect(n.decisions.find((d) => d.symbol === "SOL/USD")).toMatchObject({ action: "no_trade", defaulted: true })
    expect(n.decisions.find((d) => d.symbol === "ETH/USD")).toMatchObject({ action: "hold", defaulted: true })
  })

  it("coerces actions that don't fit the position state", () => {
    const n = normalizeCryptoReport(report([decision({ symbol: "ETH/USD", action: "buy" }), decision({ symbol: "SOL/USD", action: "close" })]), ctx)
    expect(n.decisions.find((d) => d.symbol === "ETH/USD")?.action).toBe("hold")
    expect(n.decisions.find((d) => d.symbol === "SOL/USD")?.action).toBe("no_trade")
  })

  it("only keeps source URLs that research actually retrieved", () => {
    const d = normalizeCryptoReport(report([decision()]), ctx).decisions.find((x) => x.symbol === "BTC/USD")!
    expect(d.bull_evidence[0]).toMatchObject({ source_url: "https://news.example/etf", verified_source: true, kind: "sourced_claim" })
    expect(d.bear_evidence[0]).toMatchObject({ source_url: null, verified_source: false })
  })

  it("clamps numbers and treats a ~100% reduce as a close", () => {
    const n = normalizeCryptoReport(report([decision({ conviction: 250, p_target_first: 1.4, horizon_hours: 9_999 }), decision({ symbol: "ETH/USD", action: "reduce", reduce_pct: 100 })]), ctx)
    expect(n.decisions.find((d) => d.symbol === "BTC/USD")).toMatchObject({ conviction: 100, p_target_first: 0.99, horizon_hours: 2_160 })
    expect(n.decisions.find((d) => d.symbol === "ETH/USD")?.action).toBe("close")
  })
})
