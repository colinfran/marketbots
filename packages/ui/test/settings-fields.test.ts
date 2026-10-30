import { MODEL_ID_PATTERN } from "@mb/core/settings"
import { describe, expect, it } from "vitest"
import { AGENT_SETTINGS_SECTIONS, AI_MODELS, parseField, selectChoices, type SettingsField } from "../src/lib/settings-fields"

const field = (path: string) => AGENT_SETTINGS_SECTIONS.flatMap((s) => s.fields).find((f) => f.path === path)!

describe("the model dropdown", () => {
  it("offers the local model for the agent", () => {
    expect(selectChoices(field("agent.model"), "local/qwen3.6-35b-a3b-q2")).toEqual([{ value: "local/qwen3.6-35b-a3b-q2", label: "Qwen 3.6 35B-A3B" }])
    expect(parseField(field("agent.model"), "local/qwen3.6-35b-a3b-q2")).toBe("local/qwen3.6-35b-a3b-q2")
  })

  it("keeps offering a saved model that's no longer listed, so showing the form never changes it", () => {
    expect(selectChoices(field("agent.model"), "local/an-older-model").at(-1)).toEqual({ value: "local/an-older-model", label: "local/an-older-model" })
    expect(selectChoices(field("agent.model"), "local/qwen3.6-35b-a3b-q2")).toHaveLength(AI_MODELS.length)
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
    const f: SettingsField = { path: "wire.emergency_action", label: "Critical bad news", kind: "select", options: [{ value: "tighten_stop", label: "tighten the stop" }, { value: "exit", label: "sell" }] }
    expect(selectChoices(f, "tighten_stop").map((c) => c.label)).toEqual(["tighten the stop", "sell"])
    expect(parseField(f, "tighten_stop")).toBe("tighten_stop")
  })

  it("store a None choice as null", () => {
    const f: SettingsField = { path: "x.choice", label: "Choice", kind: "select", options: ["a"], none: "None" }
    expect(selectChoices(f, null)[0]).toEqual({ value: "", label: "None" })
    expect([parseField(f, ""), parseField(f, null), parseField(f, "a")]).toEqual([null, null, "a"])
  })
})
