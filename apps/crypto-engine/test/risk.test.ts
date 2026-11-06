import { DEFAULT_SETTINGS, type Settings } from "@mb/crypto-core/settings"
import { describe, expect, it } from "vitest"
import { evaluateCryptoEntry, evaluateExit, type AccountState, type CryptoEntry, type Gate } from "../src/risk/engine"
import { cryptoEdge, cryptoSize, roundTripCostBps, slippageBps, walkBook } from "../src/risk/sizing"
import { minimumViolation, roundQty } from "../src/venues/kraken/pairs"
import { BTC } from "./helpers/fakes"

const gate: Gate = { runStatus: "running", killSwitch: false, venueOnline: true, reconciled: true }

const account = (overrides: Partial<AccountState> = {}): AccountState => ({
  equityUsd: 10_000,
  cashUsd: 10_000,
  dayStartEquityUsd: 10_000,
  peakEquityUsd: 10_000,
  positions: [],
  tradesToday: 0,
  lastExitAt: new Map(),
  ...overrides,
})

const entry = (overrides: Partial<CryptoEntry> = {}): CryptoEntry => ({
  symbol: "BTC/USD",
  strategyId: "trend",
  mid: 65_000,
  spreadBps: 3,
  quoteAgeS: 1,
  qty: 0.015,
  limitPrice: 65_150,
  stopPrice: 63_000,
  takeProfitPrice: 70_000,
  conviction: 70,
  netEdgeBps: 80,
  rewardRisk: 2.5,
  correlatedHeld: [],
  takerFeeBps: 40,
  roundQty: (q) => roundQty(BTC, q),
  minViolation: (q, p) => minimumViolation(BTC, q, p),
  ...overrides,
})

const failed = (r: ReturnType<typeof evaluateCryptoEntry>) => r.checks.filter((c) => !c.ok).map((c) => c.name)

describe("evaluateCryptoEntry", () => {
  it("approves a clean entry and records every check", () => {
    const r = evaluateCryptoEntry(entry(), account(), gate, DEFAULT_SETTINGS)
    expect(r.approved).toBe(true)
    expect(r.resized).toBe(false)
    expect(r.qty).toBe(0.015)
    expect(r.checks.map((c) => c.name)).toEqual(expect.arrayContaining(["engine_running", "kill_switch_off", "fresh_quote", "edge_after_costs", "max_position", "cash"]))
  })

  it("rejects a weak buy on conviction, edge and reward:risk", () => {
    const weak = entry({ conviction: 10, netEdgeBps: -50, rewardRisk: 0.5 })
    expect(failed(evaluateCryptoEntry(weak, account(), gate, DEFAULT_SETTINGS))).toEqual(["conviction", "edge_after_costs", "reward_risk"])
  })

  it("rejects whenever a gate fails", () => {
    expect(failed(evaluateCryptoEntry(entry(), account(), { ...gate, runStatus: "paused" }, DEFAULT_SETTINGS))).toContain("engine_running")
    expect(failed(evaluateCryptoEntry(entry(), account(), { ...gate, killSwitch: true }, DEFAULT_SETTINGS))).toContain("kill_switch_off")
    expect(failed(evaluateCryptoEntry(entry(), account(), { ...gate, reconciled: false }, DEFAULT_SETTINGS))).toContain("reconciled")
    expect(failed(evaluateCryptoEntry(entry({ quoteAgeS: 60 }), account(), gate, DEFAULT_SETTINGS))).toContain("fresh_quote")
    expect(failed(evaluateCryptoEntry(entry({ spreadBps: 50 }), account(), gate, DEFAULT_SETTINGS))).toContain("spread")
    expect(failed(evaluateCryptoEntry(entry({ netEdgeBps: 10 }), account(), gate, DEFAULT_SETTINGS))).toContain("edge_after_costs")
    expect(failed(evaluateCryptoEntry(entry({ conviction: 40 }), account(), gate, DEFAULT_SETTINGS))).toContain("conviction")
    expect(failed(evaluateCryptoEntry(entry({ rewardRisk: 1 }), account(), gate, DEFAULT_SETTINGS))).toContain("reward_risk")
    expect(failed(evaluateCryptoEntry(entry({ stopPrice: 64_900 }), account(), gate, DEFAULT_SETTINGS))).toContain("stop_distance")
    expect(failed(evaluateCryptoEntry(entry({ limitPrice: 66_000 }), account(), gate, DEFAULT_SETTINGS))).toContain("limit_price_sane")
  })

  it("blocks new entries after the daily loss and drawdown limits", () => {
    expect(failed(evaluateCryptoEntry(entry(), account({ equityUsd: 9_490, cashUsd: 9_490 }), gate, DEFAULT_SETTINGS))).toContain("daily_loss")
    expect(failed(evaluateCryptoEntry(entry(), account({ equityUsd: 7_400, cashUsd: 7_400, dayStartEquityUsd: 7_400, peakEquityUsd: 10_000 }), gate, DEFAULT_SETTINGS))).toContain("drawdown")
  })

  it("enforces cooldowns, position count and the daily trade limit", () => {
    const recent = account({ lastExitAt: new Map([["BTC/USD", Date.now() - 10 * 60_000]]) })
    expect(failed(evaluateCryptoEntry(entry(), recent, gate, DEFAULT_SETTINGS))).toContain("reentry_cooldown")
    const full = account({ positions: Array.from({ length: 7 }, (_, i) => ({ instrument: `X${i}/USD`, symbol: `X${i}/USD`, valueUsd: 100, strategyId: "trend" as const })) })
    expect(failed(evaluateCryptoEntry(entry(), full, gate, DEFAULT_SETTINGS))).toContain("max_positions")
    expect(failed(evaluateCryptoEntry(entry(), account({ tradesToday: 20 }), gate, DEFAULT_SETTINGS))).toContain("trades_per_day")
  })

  it("resizes oversized orders down to the tightest cap instead of trusting them", () => {
    // 0.05 BTC ≈ $3,257 requested; max position is 20% = $2,000.
    const r = evaluateCryptoEntry(entry({ qty: 0.05 }), account(), gate, DEFAULT_SETTINGS)
    expect(r.approved).toBe(true)
    expect(r.resized).toBe(true)
    expect(r.notionalUsd).toBeLessThanOrEqual(2_000)
    expect(r.notionalUsd).toBeGreaterThan(1_990)
  })

  it("counts correlated holdings as one bet", () => {
    const held = account({ positions: [{ instrument: "ETH/USD", symbol: "ETH/USD", valueUsd: 6_900, strategyId: "momentum" }], cashUsd: 3_100 })
    const r = evaluateCryptoEntry(entry({ correlatedHeld: ["ETH/USD"] }), held, gate, DEFAULT_SETTINGS)
    // Correlated cap 70% of $10k = $7,000, ETH already uses $6,900 → $100 left.
    expect(r.notionalUsd).toBeLessThanOrEqual(100)
  })

  it("respects per-strategy limits and disabled strategies", () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, strategies: { ...DEFAULT_SETTINGS.strategies, trend: { enabled: false, max_exposure_pct: 50 } } }
    expect(failed(evaluateCryptoEntry(entry(), account(), gate, settings))).toContain("strategy_enabled")
  })

  it("rejects when the resized order falls below Kraken minimums", () => {
    const r = evaluateCryptoEntry(entry({ qty: 0.00001 }), account(), gate, DEFAULT_SETTINGS)
    expect(r.approved).toBe(false)
    expect(failed(r)).toContain("venue_minimum")
  })
})

describe("evaluateExit", () => {
  it("allows deterministic exits immediately but holds AI exits for the minimum hold time", () => {
    const openedAt = Date.now() - 10 * 60_000
    expect(evaluateExit({ reason: "stop_loss", openedAt, venueOnline: true, minHoldMinutes: 60 }).approved).toBe(true)
    expect(evaluateExit({ reason: "ai", openedAt, venueOnline: true, minHoldMinutes: 60 }).approved).toBe(false)
    expect(evaluateExit({ reason: "ai", openedAt: Date.now() - 2 * 3_600_000, venueOnline: true, minHoldMinutes: 60 }).approved).toBe(true)
  })
})

describe("sizing and edge", () => {
  it("has zero gross edge at the random-walk prior", () => {
    const e = cryptoEdge({ price: 100, stop: 95, target: 110, pAi: null, shrink: 0.5, roundTripBps: 0 })!
    expect(e.pPrior).toBeCloseTo(5 / 15)
    expect(e.grossEdgeBps).toBeCloseTo(0, 6)
    expect(e.rewardRisk).toBeCloseTo(2)
  })

  it("shrinks the AI's claimed edge and subtracts costs", () => {
    const e = cryptoEdge({ price: 100, stop: 95, target: 110, pAi: 0.53, shrink: 0.5, roundTripBps: 90 })!
    expect(e.pAdjusted).toBeCloseTo(1 / 3 + 0.5 * (0.53 - 1 / 3))
    expect(e.grossEdgeBps).toBeCloseTo((e.pAdjusted * 0.1 - (1 - e.pAdjusted) * 0.05) * 10_000)
    expect(e.netEdgeBps).toBeCloseTo(e.grossEdgeBps - 90)
    expect(cryptoEdge({ price: 100, stop: 101, target: 110, pAi: 0.5, shrink: 0.5, roundTripBps: 0 })).toBeNull()
  })

  it("sizes by risk, capped by the max position", () => {
    // Risk $75 (0.75%) with a $5 stop → 15 units = $1,500; capped at 12% = $1,200.
    const s = cryptoSize({ equity: 10_000, price: 100, stop: 95, riskPct: 0.75, maxPositionPct: 12 })
    expect(s.notional).toBeCloseTo(1_200)
    expect(s.riskUsd).toBeCloseTo(60)
    // Risk $100 (1%) with a $10 stop → 10 units = $1,000, under a 20% cap: all of it.
    const wide = cryptoSize({ equity: 10_000, price: 100, stop: 90, riskPct: 1, maxPositionPct: 20 })
    expect(wide.notional).toBeCloseTo(1_000)
    expect(wide.riskUsd).toBeCloseTo(100)
  })

  it("walks the book and measures slippage", () => {
    const levels = [
      { price: 100, qty: 1 },
      { price: 101, qty: 1 },
      { price: 103, qty: 5 },
    ]
    const w = walkBook(levels, 2.5, 102, "buy")
    expect(w.filledQty).toBe(2)
    expect(w.avgPrice).toBeCloseTo(100.5)
    expect(slippageBps(100.5, 100, "buy")).toBeCloseTo(50)
    expect(roundTripCostBps({ takerFeeBps: 40, spreadBps: 3, entrySlippageBps: 2, exitSlippageBps: 2 })).toBe(87)
  })
})
