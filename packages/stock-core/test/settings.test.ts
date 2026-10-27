import { describe, expect, it } from "vitest"
import { commandSchema } from "../src/commands"
import { applySettingsPatch, DEFAULT_SETTINGS, diffSettings, parseTheme, settingsSchema } from "../src/settings"

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

  it("ships the core book switched off", () => {
    expect(DEFAULT_SETTINGS.core).toMatchObject({ enabled: false, target_pct: 50, max_holding_pct: 15, max_index_etf_pct: 25, stop_pct: 15, review_weekday: "mon", review_time_et: "10:15", themes: [] })
  })

  it("migrates stored settings from before the core book by filling it from the defaults", () => {
    const { core: _core, ...stored } = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, max_open_positions: 4 } }
    expect(settingsSchema.safeParse(stored).success).toBe(false)
    const r = applySettingsPatch(DEFAULT_SETTINGS, stored)
    expect(r.ok && r.settings.core).toEqual(DEFAULT_SETTINGS.core)
    expect(r.ok && r.settings.risk.max_open_positions).toBe(4)
  })

  it.each([
    [{ core: { min_holdings: 9 } }, "core.min_holdings: min_holdings can't exceed max_holdings"],
    [{ core: { target_pct: 90 }, risk: { cash_reserve_pct: 15 } }, "core.target_pct: target_pct plus risk.cash_reserve_pct can't exceed 100"],
    [{ core: { review_time_et: "09:00" } }, "core.review_time_et: review_time_et must be between 09:30 and 15:00 (the regular session)"],
    [{ core: { review_time_et: "15:30" } }, "core.review_time_et: review_time_et must be between 09:30 and 15:00 (the regular session)"],
  ])("rejects an inconsistent core book: %j", (patch, error) => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, patch)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.errors).toContain(error)
  })

  it("validates core themes and review times", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { core: { themes: ["AI buildout: NVDA, AVGO, TSM", "Nuclear power"] } }).ok).toBe(true)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { core: { themes: ["AI buildout: NVDA, $AVGO"] } })).toEqual({ ok: false, errors: ['core.themes.0: Expected a theme like "AI buildout: NVDA, AVGO, TSM"'] })
    expect(applySettingsPatch(DEFAULT_SETTINGS, { core: { review_time_et: "9:45" } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { core: { review_weekday: "sat" as never } }).ok).toBe(false)
  })

  it("parses theme lines", () => {
    expect(parseTheme("AI buildout: NVDA, AVGO, TSM")).toEqual({ name: "AI buildout", tickers: ["NVDA", "AVGO", "TSM"] })
    expect(parseTheme("  Nuclear power  ")).toEqual({ name: "Nuclear power", tickers: [] })
    expect(parseTheme("Banks: jpm bac  JPM,brk.b")).toEqual({ name: "Banks", tickers: ["JPM", "BAC", "BRK.B"] })
    expect(parseTheme("Space:")).toEqual({ name: "Space", tickers: [] })
    expect(parseTheme(": NVDA")).toBeNull()
    expect(parseTheme("Chips: NVDA, 2330")).toBeNull()
    expect(parseTheme(`${"x".repeat(61)}: NVDA`)).toBeNull()
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
