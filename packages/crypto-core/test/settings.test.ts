import { describe, expect, it } from "vitest"
import { applySettingsPatch, DEFAULT_SETTINGS, diffSettings, settingsSchema } from "../src/settings"

describe("settings", () => {
  it("ships valid defaults", () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
  })

  it("merges a deep patch and keeps everything else", () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { kraken: { max_position_pct: 8 }, ai: { daily_budget_usd: 3 } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.settings.kraken.max_position_pct).toBe(8)
    expect(result.settings.kraken.max_asset_exposure_pct).toBe(DEFAULT_SETTINGS.kraken.max_asset_exposure_pct)
    expect(result.settings.ai.daily_budget_usd).toBe(3)
    expect(result.settings.ai.models).toEqual(DEFAULT_SETTINGS.ai.models)
  })

  it("replaces arrays instead of merging them", () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { universe: { kraken_symbols: ["BTC/USD"] } })
    expect(result.ok && result.settings.universe.kraken_symbols).toEqual(["BTC/USD"])
  })

  it("rejects out-of-bound limits with the field path", () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { kraken: { max_position_pct: 500 } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/^kraken\.max_position_pct:/)
  })

  it("rejects inconsistent combinations", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { kraken: { min_stop_pct: 15, max_stop_pct: 10 } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { kraken: { max_position_pct: 30, max_asset_exposure_pct: 20 } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { universe: { kraken_symbols: ["BTC/USD", "BTC/USD"] } }).ok).toBe(false)
  })

  it("rejects malformed model ids and symbols", () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { ai: { models: { decision: "grok 4" } } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { universe: { kraken_symbols: ["btc-usd"] } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { ai: { models: { research: "spacexai/grok-4.5" } } }).ok).toBe(false)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { ai: { models: { research: "local/qwen3.6-35b-a3b-q2" } } }).ok).toBe(true)
  })

  it("drops unknown keys rather than storing them", () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { kraken: { yolo: true } } as never)
    expect(result.ok).toBe(true)
    if (result.ok) expect("yolo" in result.settings.kraken).toBe(false)
  })

  it("loads settings saved in the Grok days: their X search and fallback model are dropped", () => {
    const saved = { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, models: { ...DEFAULT_SETTINGS.ai.models, fallback: null }, x_search: true } }
    const parsed = settingsSchema.safeParse(saved)
    expect(parsed.success && parsed.data.ai).toEqual(DEFAULT_SETTINGS.ai)
  })

  it("diffs leaf paths for the audit log", () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { kraken: { max_position_pct: 8 }, universe: { kraken_symbols: ["BTC/USD"] } })
    if (!result.ok) throw new Error("expected ok")
    expect(diffSettings(DEFAULT_SETTINGS, result.settings)).toEqual([
      { path: "kraken.max_position_pct", before: 20, after: 8 },
      { path: "universe.kraken_symbols", before: DEFAULT_SETTINGS.universe.kraken_symbols, after: ["BTC/USD"] },
    ])
  })
})
