import { describe, expect, it } from "vitest"
import { normalizeCryptoAgentDecisions, type CryptoAgentAnswer } from "../src/agent"

const decision = (over: Partial<CryptoAgentAnswer["decisions"][number]> = {}): CryptoAgentAnswer["decisions"][number] => ({
  symbol: "sol/usd",
  action: "buy",
  conviction: 64.6,
  uncertainty: "medium",
  p_target_first: 0.6,
  stop_loss: 177.6,
  take_profit: 191,
  horizon_hours: 48,
  size_pct_of_max: 50,
  reduce_pct: null,
  priced_in: "partially",
  thesis: "Breakout.",
  bull_evidence: [{ claim: "Volume 1.8×", kind: "sourced_claim", source_url: "https://example.com/made-up", as_of: null }],
  bear_evidence: [],
  risks: [],
  invalidation: "Below 177.6",
  strategy: null,
  ...over,
})

const opts = { universe: new Set(["SOL/USD", "BTC/USD"]), held: new Set(["BTC/USD"]), sourceUrls: new Set<string>() }

describe("crypto agent decisions", () => {
  it("bounds them with the cycle's rules and defaults a buy's strategy to discretionary", () => {
    const { decisions } = normalizeCryptoAgentDecisions([decision()], opts)
    expect(decisions[0]).toMatchObject({ symbol: "SOL/USD", conviction: 65, size_pct_of_max: 50, strategy: "discretionary" })
    // An invented URL is dropped and its claim downgraded.
    expect(decisions[0].bull_evidence[0]).toMatchObject({ kind: "speculation", source_url: null, verified_source: false })
  })

  it("reads a size of 1 or less as a fraction", () => {
    const [d] = normalizeCryptoAgentDecisions([decision({ size_pct_of_max: 0.5 })], opts).decisions
    expect(d.size_pct_of_max).toBe(50)
    expect(d.notes).toContain("size_pct_of_max 0.5 read as 50%")
  })

  it("keeps known pairs only, the first per pair, at most three, and fits actions to the book", () => {
    const r = normalizeCryptoAgentDecisions([decision({ symbol: "DOGE/USD" }), decision(), decision(), decision({ symbol: "BTC/USD", action: "buy" })], opts)
    expect(r.decisions.map((d) => [d.symbol, d.action, d.strategy])).toEqual([
      ["SOL/USD", "buy", "discretionary"],
      ["BTC/USD", "hold", null],
    ])
    expect(r.dropped).toEqual(["DOGE/USD: not in the universe or the shadow book"])
  })
})
