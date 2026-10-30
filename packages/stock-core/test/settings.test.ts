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
    const r = applySettingsPatch(DEFAULT_SETTINGS, { options: { max_open_positions: 2 }, agent: { model: "local/gpt-oss-20b" } })
    expect(r.ok && r.settings.options.max_open_positions).toBe(2)
    expect(r.ok && r.settings.options.min_dte).toBe(14)
    expect(r.ok && r.settings.agent.model).toBe("local/gpt-oss-20b")
    expect(r.ok && r.settings.agent.limits).toEqual(DEFAULT_SETTINGS.agent.limits)
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
    expect(applySettingsPatch(DEFAULT_SETTINGS, { agent: { model: "grok" } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { universe: { benchmarks: ["spy"] } }).ok).toBe(false)
  })

  it("drops unknown keys rather than storing them", () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { risk: { yolo: true } } as never)
    expect(r.ok && "yolo" in r.settings.risk).toBe(false)
  })

  it("loads settings saved in the Grok days: their AI section, X search and fallback model are dropped", () => {
    const saved = { ...DEFAULT_SETTINGS, ai: { models: { research: "local/m", decision: "local/m", fallback: null }, x_search: true } }
    const parsed = settingsSchema.safeParse(saved)
    expect(parsed.success && parsed.data).toEqual(DEFAULT_SETTINGS)
  })

  it("loads settings saved with a daily AI budget: the budget and the event reserve are dropped", () => {
    const saved = { ...DEFAULT_SETTINGS, ai: { daily_budget_usd: 10 }, wire: { ...DEFAULT_SETTINGS.wire, event_budget_reserve_pct: 30 } }
    const parsed = settingsSchema.safeParse(saved)
    expect(parsed.success && parsed.data).toEqual(DEFAULT_SETTINGS)
  })

  it("loads settings saved before the agent-only bot: the cycles' AI section and schedule, and the core book, are dropped", () => {
    const saved = {
      ...DEFAULT_SETTINGS,
      options: { ...DEFAULT_SETTINGS.options, max_underlyings_per_cycle: 6 },
      ai: { models: { research: "local/m", decision: "local/m" }, stream_reasoning: true, research_timeout_seconds: 180, decision_timeout_seconds: 240 },
      schedule: { ...DEFAULT_SETTINGS.schedule, trade_interval_minutes: 30, max_phase_attempts: 3, trigger_cooldown_minutes: 30, min_cycle_gap_minutes: 8 },
      wire: { ...DEFAULT_SETTINGS.wire, research_mode: "auto", event_min_gap_seconds: 60, event_research: "x_verify", event_research_timeout_seconds: 45, event_decision_timeout_seconds: 90 },
      // Even a core book that no longer validated (its refinements are gone with it).
      core: { enabled: true, target_pct: 90, min_holdings: 9, max_holdings: 8, review_time_et: "16:00", themes: ["Chips: 2330"] },
    }
    const parsed = settingsSchema.safeParse(saved)
    expect(parsed.success && parsed.data).toEqual(DEFAULT_SETTINGS)
  })

  it("migrates stored settings from before the agent by filling it from the defaults", () => {
    const { agent: _agent, ...stored } = { ...DEFAULT_SETTINGS, risk: { ...DEFAULT_SETTINGS.risk, max_open_positions: 4 } }
    expect(settingsSchema.safeParse(stored).success).toBe(false)
    const r = applySettingsPatch(DEFAULT_SETTINGS, stored)
    expect(r.ok && r.settings.agent).toEqual(DEFAULT_SETTINGS.agent)
    expect(r.ok && r.settings.risk.max_open_positions).toBe(4)
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
    expect(commandSchema.safeParse({ type: "agent.review", symbols: ["NVDA", "BRK.B"] }).success).toBe(true)
    expect(commandSchema.safeParse({ type: "agent.review", symbols: ["nvda"] }).success).toBe(false)
    expect(commandSchema.safeParse({ type: "cycle.run_now", phase: "intraday" }).success).toBe(false)
    expect(commandSchema.safeParse({ type: "core.review" }).success).toBe(false)
    expect(commandSchema.safeParse({ type: "kill_switch.release", confirm: "yes" }).success).toBe(false)
    expect(commandSchema.safeParse({ type: "option.close", structure_id: "opt-1" }).success).toBe(true)
    expect(commandSchema.safeParse({ type: "position.close", symbol: "NVDA261120C00140000" }).success).toBe(false)
  })
})
