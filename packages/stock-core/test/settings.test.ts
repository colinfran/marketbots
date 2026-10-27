import { describe, expect, it } from "vitest"
import { commandSchema } from "../src/commands"
import { applySettingsPatch, DEFAULT_SETTINGS, diffSettings, settingsSchema } from "../src/settings"

describe("settings", () => {
  it("ships valid defaults matching the old risk rules", () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
    expect(DEFAULT_SETTINGS.risk).toMatchObject({ max_position_pct: 20, max_open_positions: 6, max_daily_loss_pct: 2.5, flatten_loss_pct: 4, min_conviction: 6 })
    expect(DEFAULT_SETTINGS.account.starting_capital).toBe(10_000)
  })

  it("merges a deep patch and keeps everything else", () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { options: { max_open_positions: 2 }, ai: { models: { fallback: "xai/grok-4" } } })
    expect(r.ok && r.settings.options.max_open_positions).toBe(2)
    expect(r.ok && r.settings.options.min_dte).toBe(14)
    expect(r.ok && r.settings.ai.models).toEqual({ research: "spacexai/grok-4.5", decision: "spacexai/grok-4.7", fallback: "xai/grok-4" })
  })

  it("replaces arrays instead of merging them", () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { universe: { benchmarks: ["SPY", "QQQ"] } })
    expect(r.ok && r.settings.universe.benchmarks).toEqual(["SPY", "QQQ"])
  })

  it("rejects out-of-bound limits with the field path", () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { risk: { max_position_pct: 500 } })
    expect(r).toEqual({ ok: false, errors: [expect.stringMatching(/^risk\.max_position_pct: /)] })
  })

  it.each([
    [{ risk: { min_stop_pct: 9 } }, "risk.min_stop_pct: min_stop_pct must be below max_stop_pct"],
    [{ risk: { default_stop_pct: 10 } }, "risk.default_stop_pct: default_stop_pct must be between min_stop_pct and max_stop_pct"],
    [{ risk: { max_daily_loss_pct: 5 } }, "risk.max_daily_loss_pct: max_daily_loss_pct must be below flatten_loss_pct"],
    [{ options: { min_dte: 60 } }, "options.min_dte: min_dte must be below max_dte"],
    [{ options: { close_at_dte: 14 } }, "options.close_at_dte: close_at_dte must be below min_dte"],
    [{ options: { min_delta: 0.8 } }, "options.min_delta: min_delta must be below max_delta"],
    [{ options: { max_premium_per_trade_pct: 20 } }, "options.max_premium_per_trade_pct: max_premium_per_trade_pct can't exceed max_total_premium_pct"],
    [{ universe: { benchmarks: ["SPY", "SPY"] } }, "universe.benchmarks: duplicate symbols"],
  ])("rejects inconsistent combinations: %j", (patch, error) => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, patch)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors).toContain(error)
  })

  it("rejects malformed model ids and tickers", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { ai: { models: { decision: "grok" } } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { universe: { benchmarks: ["spy"] } }).ok).toBe(false)
  })

  it("drops unknown keys rather than storing them", () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { risk: { yolo: true } } as never)
    expect(r.ok && "yolo" in r.settings.risk).toBe(false)
  })

  it("diffs leaf paths for the audit log", () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { options: { enabled: false }, risk: { min_conviction: 7 } })
    expect(r.ok && diffSettings(DEFAULT_SETTINGS, r.settings)).toEqual([
      { path: "risk.min_conviction", before: 6, after: 7 },
      { path: "options.enabled", before: true, after: false },
    ])
  })
})

describe("commands", () => {
  it("validates every command shape", () => {
    expect(commandSchema.safeParse({ type: "cycle.run_now", phase: "intraday", symbols: ["NVDA", "BRK.B"] }).success).toBe(true)
    expect(commandSchema.safeParse({ type: "cycle.run_now", symbols: ["nvda"] }).success).toBe(false)
    expect(commandSchema.safeParse({ type: "cycle.run_now", phase: "lunch" }).success).toBe(false)
    expect(commandSchema.safeParse({ type: "kill_switch.release", confirm: "yes" }).success).toBe(false)
    expect(commandSchema.safeParse({ type: "option.close", structure_id: "opt-1" }).success).toBe(true)
    expect(commandSchema.safeParse({ type: "position.close", symbol: "NVDA261120C00140000" }).success).toBe(false)
  })
})
