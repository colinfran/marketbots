import type { AlpacaAsset } from "@mb/stock-core/alpaca"
import type { CoreHoldingDecision } from "@mb/stock-core/core-book"
import { DEFAULT_SETTINGS, mergeSettings, parseTheme, type Settings, type SettingsPatch } from "@mb/stock-core/settings"
import { describe, expect, it } from "vitest"
import { type CoreHolding, type CoreRulesInput, initialCoreStop, planCoreReview, resolveTheme } from "../../src/core-book/rules"
import { planDoc } from "../helpers/factories"

const settings = (patch: SettingsPatch = {}) => mergeSettings(DEFAULT_SETTINGS, patch) as Settings

const holding = (symbol: string, qty: number, price: number, o: { avg?: number; stop?: number | null; theme?: string | null } = {}): CoreHolding => ({
  symbol,
  qty,
  avg_entry: o.avg ?? price,
  price,
  market_value: qty * price,
  plan: planDoc(symbol, { book: "core", horizon: "multi_day", take_profit: null, stop_loss: o.stop === undefined ? Math.floor(price * 0.85) : o.stop, theme: o.theme ?? null, last_reviewed_at: null }),
})

const decision = (symbol: string, action: CoreHoldingDecision["action"], o: Partial<CoreHoldingDecision> = {}): CoreHoldingDecision => ({
  symbol,
  action,
  target_weight_pct: null,
  conviction: 8,
  thesis: `${symbol} thesis`,
  invalidation: `${symbol} invalidation`,
  verdict: `${symbol} verdict`,
  theme: null,
  stop: null,
  evidence: [],
  ...o,
})

const asset = (symbol: string, o: Partial<AlpacaAsset> = {}): AlpacaAsset => ({ symbol, name: `${symbol} Inc.`, class: "us_equity", exchange: "NASDAQ", status: "active", tradable: true, fractionable: true, ...o })

/** A $10,000 account with $6,000 cash: SPY (4 × $500) and DIA (5 × $400) are the core book, 40% of equity. */
const input = (o: Partial<CoreRulesInput> = {}): CoreRulesInput => {
  const decisions = o.decisions ?? []
  const prices = new Map<string, number>([
    ["NVDA", 200],
    ["LLY", 900],
    ["AAPL", 250],
    ["QQQ", 500],
    ["MSFT", 400],
    ["AVGO", 300],
    ...(o.prices ?? []),
  ])
  return {
    settings: settings(),
    equity: 10_000,
    cash: 6_000,
    holdings: [holding("SPY", 4, 500, { stop: 425 }), holding("DIA", 5, 400, { stop: 340 })],
    tradingSymbols: new Set(["TSLA"]),
    assets: new Map(decisions.map((d) => [d.symbol, asset(d.symbol)])),
    themes: [],
    circuitBreaker: false,
    entriesBlocked: null,
    ...o,
    decisions,
    prices,
  }
}

const summary = (plan: ReturnType<typeof planCoreReview>) => plan.map((p) => [p.symbol, p.action, p.approved, p.qty, p.weight_after_pct, p.stop, p.reason])

describe("planCoreReview", () => {
  it("runs sells and trims first, then buys by conviction within the book's room, and keeps every holding", () => {
    const plan = planCoreReview(
      input({
        decisions: [
          decision("SPY", "keep", { stop: 470 }),
          decision("DIA", "trim", { target_weight_pct: 15 }),
          decision("LLY", "buy", { conviction: 7, target_weight_pct: 8 }),
          decision("NVDA", "buy", { conviction: 8, target_weight_pct: 10, stop: 180 }),
          decision("AAPL", "buy", { conviction: 6, target_weight_pct: 8 }),
          decision("XYZ", "sell"),
        ],
      }),
    )
    expect(summary(plan)).toEqual([
      ["XYZ", "sell", false, null, null, null, "XYZ is not a core holding"],
      // (2,000 - 1,500) / 400 = 1.25: one share comes off.
      ["DIA", "trim", true, 1, 16, 340, null],
      // Book after the trim: SPY 20% + DIA 16% = 36%, room 14% to the 50% target.
      ["NVDA", "buy", true, 5, 10, 180, null],
      // 4% of room left buys no $900 share.
      ["LLY", "buy", false, null, null, null, "0% of equity after the book's room to its 50% target (minimum 2%)"],
      ["AAPL", "buy", false, null, null, null, "conviction 6 < 7"],
      ["SPY", "keep", true, null, 20, 470, null],
    ])
    expect(plan.find((p) => p.symbol === "SPY")!.stop_changed).toBe(true)
    expect(plan.find((p) => p.symbol === "NVDA")!.checks.map((c) => c.name)).toEqual(["engine", "loss limits", "not held", "conviction", "book below target", "holdings", "trade limit", "tradable", "price", "weight", "size", "stop"])
  })

  it("keeps a holding Grok left out, and a buy of one it already holds", () => {
    const plan = planCoreReview(input({ decisions: [decision("SPY", "buy", { target_weight_pct: 5 })] }))
    expect(summary(plan)).toEqual([
      ["SPY", "keep", true, null, 20, 425, "already a core holding (v1 never adds to one); kept"],
      ["DIA", "keep", true, null, 20, 340, "no decision returned; kept"],
    ])
  })

  it("only raises stops: a lower stop or one too close to the price is ignored", () => {
    const plan = planCoreReview(input({ decisions: [decision("SPY", "keep", { stop: 400 }), decision("DIA", "keep", { stop: 395 })] }))
    expect(plan.map((p) => [p.symbol, p.stop, p.stop_changed, p.reason])).toEqual([
      ["SPY", 425, false, "stop 400 is below the current 425; stops only move up"],
      ["DIA", 340, false, "stop 395 is within 3% of the price 400; kept 340"],
    ])
  })

  it("gives a holding without a stop the initial one", () => {
    const plan = planCoreReview(input({ holdings: [holding("SPY", 4, 500, { avg: 480, stop: null })] }))
    expect(plan[0]).toMatchObject({ symbol: "SPY", stop: 408, stop_changed: true }) // 480 × 0.85
  })

  it("caps a single stock at max_holding_pct and a broad-index ETF at max_index_etf_pct", () => {
    const plan = planCoreReview(input({ holdings: [], cash: 10_000, decisions: [decision("QQQ", "buy", { conviction: 9, target_weight_pct: 30 }), decision("MSFT", "buy", { target_weight_pct: 20 })] }))
    expect(summary(plan)).toEqual([
      ["QQQ", "buy", true, 5, 25, 425, null],
      ["MSFT", "buy", true, 3, 12, 340, null],
    ])
    expect(plan[0].checks.find((c) => c.name === "size")!.detail).toBe("5 shares, 25% of equity (asked 30%, limited by 25% cap per index ETF)")
    expect(plan[1].checks.find((c) => c.name === "size")!.detail).toBe("3 shares, 12% of equity (asked 20%, limited by 15% cap per holding)")
  })

  it("keeps a theme under max_theme_pct of the book, matching the owner's theme names", () => {
    const themes = [parseTheme("AI buildout: NVDA, AVGO")!]
    const plan = planCoreReview(
      input({
        holdings: [holding("NVDA", 10, 200, { theme: "AI buildout" })], // 20%
        themes,
        decisions: [decision("NVDA", "keep"), decision("AVGO", "buy", { target_weight_pct: 10, theme: "ai BUILDOUT" })],
      }),
    )
    // 50% of a 50% book = 25% of equity per theme; NVDA holds 20.
    expect(plan.find((p) => p.symbol === "AVGO")).toMatchObject({ approved: true, theme: "AI buildout", qty: 1, weight_after_pct: 3 })
    expect(plan.find((p) => p.symbol === "AVGO")!.checks.find((c) => c.name === "size")!.detail).toBe('1 shares, 3% of equity (asked 10%, limited by theme "AI buildout" room under 50% of the book)')
    expect(resolveTheme(themes, "Space")).toBeNull()
  })

  it("buys nothing while the book is within band_pct of its target", () => {
    const plan = planCoreReview(input({ holdings: [holding("SPY", 9, 500)], decisions: [decision("NVDA", "buy", { target_weight_pct: 5 })] })) // 45%
    expect(plan[0].reason).toBe("the book is 45% of equity, within 5 points of its 50% target: no buys")
  })

  it.each([
    [{ circuitBreaker: true }, "no core buys on a circuit-breaker day"],
    [{ entriesBlocked: "kill switch engaged: test" }, "kill switch engaged: test"],
    [{ tradingSymbols: new Set(["NVDA"]) }, "NVDA is held in the trading book"],
    [{ assets: new Map([["NVDA", null]]) }, "not tradable on Alpaca"],
    [{ prices: [["NVDA", 3]] as [string, number][] }, "price $3 below $5"],
  ])("rejects a buy: %j", (o, reason) => {
    const plan = planCoreReview(input({ ...(o as Partial<CoreRulesInput>), decisions: [decision("NVDA", "buy", { target_weight_pct: 10 }), decision("DIA", "sell")] }))
    expect(plan.find((p) => p.symbol === "NVDA")).toMatchObject({ approved: false, reason })
    expect(plan.find((p) => p.symbol === "DIA")).toMatchObject({ approved: true, qty: 5, notional: 2_000, weight_after_pct: 0, stop: null })
  })

  it("stops at max_holdings and max_trades_per_review", () => {
    const full = planCoreReview(input({ settings: settings({ core: { min_holdings: 1, max_holdings: 2 } }), decisions: [decision("NVDA", "buy", { target_weight_pct: 5 })] }))
    expect(full[0].reason).toBe("max 2 holdings")
    const busy = planCoreReview(input({ settings: settings({ core: { max_trades_per_review: 2 } }), decisions: [decision("SPY", "sell"), decision("DIA", "trim", { target_weight_pct: 10 }), decision("NVDA", "buy", { target_weight_pct: 5 })] }))
    expect(summary(busy).map((r) => [r[0], r[2], r[6]])).toEqual([
      ["SPY", true, null],
      ["DIA", true, null],
      ["NVDA", false, "max 2 trades per review"],
    ])
  })

  it("rejects a trim without a lower target, and sells everything a trim leaves nothing of", () => {
    const plan = planCoreReview(input({ decisions: [decision("SPY", "trim", { target_weight_pct: 25 }), decision("DIA", "trim", { target_weight_pct: 1 })] }))
    expect(summary(plan)).toEqual([
      ["SPY", "trim", false, null, 20, 425, "already at or within a share of 25% (now 20%)"],
      ["DIA", "trim", true, 4, 4, 340, null],
    ])
    const all = planCoreReview(input({ holdings: [holding("DIA", 1, 400)], decisions: [decision("DIA", "trim", { target_weight_pct: 0.5 })] }))
    // 400 - 50 = 350: less than a share above 0.5%.
    expect(all[0].reason).toBe("already at or within a share of 0.5% (now 4%)")
  })

  it("uses Grok's stop for a buy only when it's tighter than stop_pct and at least 3% below the price", () => {
    const stops = (stop: number | null) => planCoreReview(input({ decisions: [decision("NVDA", "buy", { target_weight_pct: 5, stop })] })).find((p) => p.symbol === "NVDA")!.stop
    expect(stops(185)).toBe(185)
    expect(stops(150)).toBe(170) // wider than 15%
    expect(stops(197)).toBe(170) // closer than 3%
    expect(stops(null)).toBe(170)
  })

  it("spends only the cash above the reserve", () => {
    const plan = planCoreReview(input({ cash: 1_100, decisions: [decision("NVDA", "buy", { target_weight_pct: 10 })] }))
    // $1,100 - the 5% reserve ($500) = $600: three $200 shares.
    expect(plan[0]).toMatchObject({ approved: true, qty: 3, weight_after_pct: 6 })
  })
})

describe("initialCoreStop", () => {
  it("is stop_pct below the entry, and at least 3% below the price", () => {
    expect(initialCoreStop(100, 110, 15)).toBe(85)
    expect(initialCoreStop(100, 80, 15)).toBe(77.6) // already 20% down: 3% under the price
  })
})
