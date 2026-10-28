import { MODEL_ID_PATTERN } from "@mb/core/settings"
import { describe, expect, it } from "vitest"
import { AI_MODEL_FIELDS, AI_MODELS, parseField, selectChoices, type SettingsField } from "../src/lib/settings-fields"

const field = (path: string) => AI_MODEL_FIELDS.find((f) => f.path === path)!

describe("the model dropdowns", () => {
  it("offer only Grok for research, every model for decisions, and None as a fallback", () => {
    expect(selectChoices(field("ai.models.research"), "spacexai/grok-4.3").map((c) => c.value)).toEqual(["spacexai/grok-4.7", "spacexai/grok-4.5", "spacexai/grok-4.3"])
    expect(selectChoices(field("ai.models.decision"), "spacexai/grok-4.7").map((c) => c.label)).toEqual(["Qwen 3.6 35B-A3B (local, free)", "Grok 4.7", "Grok 4.5", "Grok 4.3"])
    expect(selectChoices(field("ai.models.fallback"), null)[0]).toEqual({ value: "", label: "None" })
  })

  it("store None as null, and a model as its id", () => {
    expect(parseField(field("ai.models.fallback"), "")).toBeNull()
    expect(parseField(field("ai.models.fallback"), null)).toBeNull()
    expect(parseField(field("ai.models.fallback"), "spacexai/grok-4.3")).toBe("spacexai/grok-4.3")
    expect(parseField(field("ai.models.decision"), "local/qwen3.6-35b-a3b-q2")).toBe("local/qwen3.6-35b-a3b-q2")
  })

  it("keep offering a saved model that's no longer listed, so showing the form never changes it", () => {
    expect(selectChoices(field("ai.models.decision"), "xai/grok-3").at(-1)).toEqual({ value: "xai/grok-3", label: "xai/grok-3" })
    expect(selectChoices(field("ai.models.decision"), "spacexai/grok-4.7")).toHaveLength(AI_MODELS.length)
  })

  it("use ids the settings schema accepts", () => {
    expect(AI_MODELS.every((m) => MODEL_ID_PATTERN.test(m.value))).toBe(true)
  })
})

describe("plain dropdowns", () => {
  it("still show their options with spaces for underscores", () => {
    const f: SettingsField = { path: "portfolio.drawdown_action", label: "At max drawdown", kind: "select", options: ["halt", "halt_and_liquidate"] }
    expect(selectChoices(f, "halt")).toEqual([
      { value: "halt", label: "halt" },
      { value: "halt_and_liquidate", label: "halt and liquidate" },
    ])
    expect(parseField(f, "halt_and_liquidate")).toBe("halt_and_liquidate")
  })
})
