import { MODEL_ID_PATTERN } from "@mb/core/settings"
import { describe, expect, it } from "vitest"
import { AI_MODEL_FIELDS, AI_MODELS, parseField, selectChoices, type SettingsField } from "../src/lib/settings-fields"

const field = (path: string) => AI_MODEL_FIELDS.find((f) => f.path === path)!

describe("the model dropdowns", () => {
  it("offer the local model for research and decisions", () => {
    expect(AI_MODEL_FIELDS.map((f) => f.path)).toEqual(["ai.models.research", "ai.models.decision"])
    expect(selectChoices(field("ai.models.research"), "local/qwen3.6-35b-a3b-q2")).toEqual([{ value: "local/qwen3.6-35b-a3b-q2", label: "Qwen 3.6 35B-A3B" }])
    expect(parseField(field("ai.models.decision"), "local/qwen3.6-35b-a3b-q2")).toBe("local/qwen3.6-35b-a3b-q2")
  })

  it("keep offering a saved model that's no longer listed, so showing the form never changes it", () => {
    expect(selectChoices(field("ai.models.decision"), "spacexai/grok-4.7").at(-1)).toEqual({ value: "spacexai/grok-4.7", label: "spacexai/grok-4.7" })
    expect(selectChoices(field("ai.models.decision"), "local/qwen3.6-35b-a3b-q2")).toHaveLength(AI_MODELS.length)
  })

  it("use ids the settings schema accepts", () => {
    expect(AI_MODELS.every((m) => MODEL_ID_PATTERN.test(m.value))).toBe(true)
  })
})

describe("dropdowns", () => {
  it("show plain options with spaces for underscores", () => {
    const f: SettingsField = { path: "portfolio.drawdown_action", label: "At max drawdown", kind: "select", options: ["halt", "halt_and_liquidate"] }
    expect(selectChoices(f, "halt")).toEqual([
      { value: "halt", label: "halt" },
      { value: "halt_and_liquidate", label: "halt and liquidate" },
    ])
    expect(parseField(f, "halt_and_liquidate")).toBe("halt_and_liquidate")
  })

  it("label a stored value without changing it", () => {
    const f: SettingsField = { path: "wire.event_research", label: "Event research", kind: "select", options: [{ value: "x_verify", label: "web check" }, { value: "none", label: "none" }] }
    expect(selectChoices(f, "x_verify").map((c) => c.label)).toEqual(["web check", "none"])
    expect(parseField(f, "x_verify")).toBe("x_verify")
  })

  it("store a None choice as null", () => {
    const f: SettingsField = { path: "x.choice", label: "Choice", kind: "select", options: ["a"], none: "None" }
    expect(selectChoices(f, null)[0]).toEqual({ value: "", label: "None" })
    expect([parseField(f, ""), parseField(f, null), parseField(f, "a")]).toEqual([null, null, "a"])
  })
})
