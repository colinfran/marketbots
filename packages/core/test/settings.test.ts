import { describe, expect, it } from "vitest"
import { z } from "zod"
import { aiSettingsBase, applySettingsPatch, int, mergeSettings, refineWireThresholds, wireSettingsBase, wireSummariesSettings } from "../src/settings"

/** A small bot built the way the real ones are: base fields in the bot's own order, refined last. */
const wire = wireSettingsBase.shape
const schema = z
  .object({
    ai: aiSettingsBase,
    wire: z.object({ thresholds: wire.thresholds, own_knob: int(1, 10), retention_days: wire.retention_days }),
  })
  .superRefine((s, ctx) => {
    refineWireThresholds(s, ctx)
    if (s.wire.own_knob > 5 && s.wire.retention_days < 30) ctx.addIssue({ code: "custom", path: ["wire", "own_knob"], message: "own_knob needs 30 days" })
  })
type Settings = z.infer<typeof schema>

const defaults: Settings = {
  ai: {
    daily_budget_usd: 5,
    models: { research: "spacexai/grok-4.5", decision: "spacexai/grok-4.7", fallback: null },
    x_search: true,
    research_timeout_seconds: 180,
    decision_timeout_seconds: 240,
  },
  wire: { thresholds: { annotate: 30, review: 55, evaluate: 70, critical: 85 }, own_knob: 3, retention_days: 30 },
}

describe("settings helpers", () => {
  it("keep the bot's key order", () => {
    expect(Object.keys(schema.parse(defaults).wire)).toEqual(["thresholds", "own_knob", "retention_days"])
  })

  it("merge deep patches, replacing arrays", () => {
    expect(mergeSettings({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } })).toEqual({ a: { b: 1, c: [3] } })
  })

  it("apply a patch against the bot's schema", () => {
    const r = applySettingsPatch(schema, defaults, { ai: { daily_budget_usd: 3 } })
    expect(r.ok && r.settings.ai.daily_budget_usd).toBe(3)
    expect(r.ok && r.settings.ai.models).toEqual(defaults.ai.models)
  })

  it("check the wire thresholds first, then the bot's own rules", () => {
    const r = applySettingsPatch(schema, defaults, { wire: { thresholds: { review: 80 }, own_knob: 6, retention_days: 7 } })
    expect(r).toEqual({
      ok: false,
      errors: ["wire.thresholds: thresholds must ascend: annotate < review < evaluate < critical", "wire.own_knob: own_knob needs 30 days"],
    })
  })

  it("reject malformed model ids", () => {
    expect(applySettingsPatch(schema, defaults, { ai: { models: { decision: "grok 4" } } }).ok).toBe(false)
  })
})

describe("article summaries settings", () => {
  const summaries = { enabled: true, model: "llama3.2:3b", min_severity: 55, max_per_hour: 60, skip_domains: ["wsj.com"], pause_hours: [] as string[] }
  const issues = (patch: Partial<typeof summaries>) => {
    const r = wireSummariesSettings.safeParse({ ...summaries, ...patch })
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
  }

  it("take an Ollama tag, bare domains and UTC hour ranges", () => {
    expect(issues({})).toEqual([])
    expect(issues({ model: "qwen3:4b-instruct", skip_domains: ["markets.ft.com"], pause_hours: ["22-6", "0-24", "9-17"] })).toEqual([])
    expect(issues({ model: "Llama 3.2 3B" })).toEqual(["model: Expected an Ollama model tag like llama3.2:3b"])
    expect(issues({ skip_domains: ["https://wsj.com/"] })).toEqual(["skip_domains.0: Expected a lowercase domain like wsj.com"])
    expect(issues({ pause_hours: ["22:00-06:00"] })).toEqual(["pause_hours.0: Expected a UTC hour range like 22-6"])
    expect(issues({ pause_hours: ["24-6"] })).toEqual(["pause_hours.0: Expected a UTC hour range like 22-6"])
    expect(issues({ pause_hours: ["6-6"] })).toEqual(["pause_hours.0: an hour range can't start and end at the same hour"])
    expect(issues({ max_per_hour: 0 })).toHaveLength(1)
  })
})
