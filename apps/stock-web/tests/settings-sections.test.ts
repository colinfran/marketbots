import { DEFAULT_SETTINGS } from "@mb/stock-core/settings"
import { selectChoices } from "@mb/ui/lib/settings-fields"
import { describe, expect, it } from "vitest"
import { SETTINGS_SECTIONS } from "@/app/admin/settings-sections"

const at = (path: string) => path.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], DEFAULT_SETTINGS)

describe("Admin settings sections", () => {
  it("name only settings that exist, each once, and offer every select's current value", () => {
    const paths = SETTINGS_SECTIONS.flatMap((s) => s.fields.map((f) => f.path))
    expect(paths.filter((p) => at(p) === undefined)).toEqual([])
    expect(new Set(paths).size).toBe(paths.length)
    for (const f of SETTINGS_SECTIONS.flatMap((s) => s.fields).filter((x) => x.kind === "select" && x.none === undefined)) {
      expect(selectChoices(f, at(f.path)).map((c) => c.value), f.path).toContain(String(at(f.path)))
    }
  })

  it("include the agent's level, envelope and episode limits", () => {
    const paths = SETTINGS_SECTIONS.flatMap((s) => s.fields.map((f) => f.path))
    expect(paths).toEqual(expect.arrayContaining(["agent.level", "agent.envelope.entries_per_day", "agent.limits.p0.steps", "agent.limits.p3.thinking_tokens"]))
  })
})
