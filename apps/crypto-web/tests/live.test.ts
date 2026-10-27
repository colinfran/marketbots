import type { EngineEvent, EventDataMap } from "@mb/crypto-core/events"
import { describe, expect, it } from "vitest"
import { kit } from "../components/kit"
import { buildTrail } from "../components/live/cycle-trail"

/** The live UI shows the model's reasoning and the decision as it's written. */

/** Events in emission order. Ephemeral ones (reasoning, progress) carry seq 0, so the trail orders them by time. */
let n = 0
const event = <T extends keyof EventDataMap>(type: T, data: EventDataMap[T], summary: string, ephemeral = false): EngineEvent => {
  n += 1
  return { v: 1, seq: ephemeral ? 0 : n, ts: new Date(Date.UTC(2026, 9, 27, 14, 0, n)).toISOString(), type, level: ephemeral ? "debug" : "info", visibility: "public", summary, cycle_id: "c1", data } as EngineEvent
}

const reasoning = (task: "research" | "decision", excerpt: string) => event("ai.reasoning", { cycle_id: "c1", task, chars: excerpt.length, excerpt }, `Reasoning (${task})`, true)
const progress = () => event("ai.decision.progress", { cycle_id: "c1", chars: 1_840, headline: "Risk-on: BTC broke out.", decisions: 2 }, "Writing: “Risk-on: BTC broke out.” · 2 decisions so far", true)

describe("the event catalog", () => {
  const catalog = kit.events

  it("lists reasoning in the activity feed but keeps decision progress out of it, as stock does", () => {
    expect(catalog.feedDebug.has("ai.reasoning")).toBe(true)
    expect(catalog.feedHidden.has("ai.reasoning")).toBe(false)
    expect(catalog.feedHidden.has("ai.decision.progress")).toBe(true)
    expect(catalog.filters.ai(reasoning("decision", "x"))).toBe(true)
    expect(catalog.icons["ai.reasoning"]).toBeDefined()
    expect(catalog.icons["ai.decision.progress"]).toBeDefined()
    expect(catalog.detail(reasoning("research", "Checking X for ETF flows."))).toBe("Checking X for ETF flows.")
  })

  it("shows both in the current work, with the reasoning's latest words", () => {
    expect(catalog.work.events.has("ai.reasoning")).toBe(true)
    expect(catalog.work.events.has("ai.decision.progress")).toBe(true)
    expect(catalog.work.text(reasoning("decision", `${"a".repeat(200)} funding is calm.`))).toBe(`Reasoning (decision): …${"a".repeat(103)} funding is calm.`)
    expect(catalog.work.text(progress())).toBe("Writing: “Risk-on: BTC broke out.” · 2 decisions so far")
  })
})

describe("the live cycle trail", () => {
  it("keeps the latest reasoning per step and the latest decision progress", () => {
    const trail = buildTrail("c1", [
      event("cycle.started", { cycle_id: "c1", trigger: "scheduled" }, "Cycle started"),
      event("research.started", { cycle_id: "c1", research_id: "r1", subjects: ["BTC/USD"], model: "spacexai/grok-4.5" }, "Researching BTC/USD"),
      reasoning("research", "first"),
      reasoning("research", "second"),
      event("research.completed", { research_id: "r1", sources: 3, queries: 2, duration_ms: 40_000, cost_usd: 0.05, error: null }, "Research done"),
      event("ai.decision.started", { cycle_id: "c1", model: "spacexai/grok-4.7", items: ["BTC/USD", "ETH/USD"] }, "Deciding on 2 items"),
      reasoning("decision", "weighing"),
      event("ai.decision.progress", { cycle_id: "c1", chars: 600, headline: null, decisions: 0 }, "Writing decisions (600 chars)", true),
      progress(),
    ])
    expect(trail.research.reasoning).toEqual({ cycle_id: "c1", task: "research", chars: 6, excerpt: "second" })
    expect(trail.decision.reasoning).toEqual({ cycle_id: "c1", task: "decision", chars: 8, excerpt: "weighing" })
    expect(trail.decision.progress).toEqual({ cycle_id: "c1", chars: 1_840, headline: "Risk-on: BTC broke out.", decisions: 2 })
  })
})
