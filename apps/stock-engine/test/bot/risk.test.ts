import { describe, expect, it } from "vitest"
import { applySettingsPatch, DEFAULT_SETTINGS, upgradeStockSettings, type SettingsPatch } from "@mb/stock-core/settings"
import { computeRiskState as compute } from "../../src/bot/risk"
import { account } from "../helpers/factories"

const computeRiskState = (a: Parameters<typeof compute>[0], open: number, trades: number) => compute(a, open, trades, DEFAULT_SETTINGS)

/** Account with the given equity and yesterday's close. */
const acct = (equity: number, lastEquity: number, cash = equity) =>
  account({ equity: String(equity), last_equity: String(lastEquity), cash: String(cash) })

describe("computeRiskState", () => {
  it("describes a fresh, flat account", () => {
    expect(computeRiskState(acct(10_000, 10_000), 0, 0)).toEqual({
      equity: 10_000,
      cash: 10_000,
      start_of_day_equity: 10_000,
      day_pnl: 0,
      day_pnl_pct: 0,
      total_return_pct: 0,
      deployable_cash: 9_500, // 5% cash reserve
      max_position_pct: 20,
      max_position_usd: 2_000,
      open_positions: 0,
      max_open_positions: 6,
      trades_today: 0,
      trades_remaining: 30,
      circuit_breaker: false,
      kill_switch: false,
      new_buys_allowed: true,
      notes: [],
    })
  })

  it("measures the day against last_equity and the total against starting capital", () => {
    const risk = computeRiskState(acct(10_404, 10_200), 2, 4)
    expect(risk.day_pnl).toBe(204)
    expect(risk.day_pnl_pct).toBe(2)
    expect(risk.total_return_pct).toBe(4.04)
  })

  it("treats a missing last_equity as a flat day", () => {
    const risk = computeRiskState(acct(9_000, 0), 0, 0)
    expect(risk.start_of_day_equity).toBe(9_000)
    expect(risk.day_pnl).toBe(0)
    expect(risk.circuit_breaker).toBe(false)
  })

  it("blocks new buys at the daily loss limit (inclusive)", () => {
    const risk = computeRiskState(acct(9_750, 10_000), 1, 0) // exactly -2.5%
    expect(risk.circuit_breaker).toBe(true)
    expect(risk.kill_switch).toBe(false)
    expect(risk.new_buys_allowed).toBe(false)
    expect(risk.notes).toEqual([expect.stringMatching(/^CIRCUIT BREAKER: day P&L -2\.50% <= -2\.5%/)])
  })

  it("stays open just above the loss limit", () => {
    const risk = computeRiskState(acct(9_751, 10_000), 1, 0)
    expect(risk.circuit_breaker).toBe(false)
    expect(risk.new_buys_allowed).toBe(true)
  })

  it("flips the kill switch at the flatten limit and reports only that", () => {
    const risk = computeRiskState(acct(9_600, 10_000), 3, 5) // exactly -4%
    expect(risk.kill_switch).toBe(true)
    expect(risk.circuit_breaker).toBe(true)
    expect(risk.new_buys_allowed).toBe(false)
    expect(risk.notes).toHaveLength(1)
    expect(risk.notes[0]).toMatch(/^KILL SWITCH: day P&L -4\.00% <= -4%/)
  })

  it("keeps full size on a green day: a good day is no reason to stop pressing", () => {
    // Until 2026-11-06 a +1.5% day (live: +3%) halved new positions.
    const risk = computeRiskState(acct(10_500, 10_000), 0, 0)
    expect(risk.max_position_pct).toBe(20)
    expect(risk.max_position_usd).toBe(2_100)
    expect(risk.new_buys_allowed).toBe(true)
    expect(risk.notes).toEqual([])
  })

  it("stops buying when the daily trade limit is used up, never going negative", () => {
    const atLimit = computeRiskState(acct(10_000, 10_000), 0, 30)
    expect(atLimit.trades_remaining).toBe(0)
    expect(atLimit.new_buys_allowed).toBe(false)
    expect(atLimit.notes).toContain("Daily trade limit reached: no new orders except risk-reducing exits.")
    expect(computeRiskState(acct(10_000, 10_000), 0, 45).trades_remaining).toBe(0)
  })

  it("stops buying at max open positions", () => {
    const risk = computeRiskState(acct(10_000, 10_000), 6, 0)
    expect(risk.new_buys_allowed).toBe(false)
    expect(risk.notes).toContain("Max open positions (6) reached: sell a stock before buying another.")
    expect(computeRiskState(acct(10_000, 10_000), 5, 0).new_buys_allowed).toBe(true)
  })

  it("collects every applicable note", () => {
    const risk = computeRiskState(acct(10_200, 10_000), 6, 30)
    expect(risk.notes).toEqual(["Daily trade limit reached: no new orders except risk-reducing exits.", "Max open positions (6) reached: sell a stock before buying another."])
  })

  it("deploys cash only, never margin", () => {
    // Positions are worth more than cash: only cash (minus the reserve on total equity) is deployable.
    expect(computeRiskState(acct(10_000, 10_000, 3_000), 2, 0).deployable_cash).toBe(2_500)
    // Negative cash (margin in use) means nothing is deployable.
    expect(computeRiskState(acct(10_000, 10_000, -500), 2, 0).deployable_cash).toBe(0)
    // Cash can't exceed equity in the formula.
    expect(computeRiskState(acct(10_000, 10_000, 12_000), 0, 0).deployable_cash).toBe(9_500)
  })

  it("keeps no share of equity for the old core book, even with its section still stored", () => {
    const upgraded = applySettingsPatch(DEFAULT_SETTINGS, upgradeStockSettings({ ...DEFAULT_SETTINGS, core: { enabled: true, target_pct: 50 } }) as SettingsPatch)
    if (!upgraded.ok) throw new Error(upgraded.errors.join("; "))
    const stored = upgraded.settings
    const risk = compute(acct(10_000, 10_000, 6_000), 1, 0, stored)
    expect(risk.deployable_cash).toBe(5_500)
    expect(risk.notes).toEqual([])
  })

  it("rounds money to cents", () => {
    const risk = computeRiskState(acct(10_000.127, 9_999.991, 5_000.556), 0, 0)
    expect(risk.equity).toBe(10_000.13)
    expect(risk.cash).toBe(5_000.56)
    expect(risk.day_pnl).toBe(0.14)
  })
})
