import { describe, expect, it } from "vitest"
import { applyModelEvent, type ModelFeed } from "../src/stream"

const EMPTY: ModelFeed = { calls: [], server: null }
const start = (id: string) => ({
  type: "llm.call",
  data: { call_id: id, kind: "agent", label: `Agent on SOL/USD, step 1`, model: "qwen", subject: "SOL/USD", episode_id: "e1", step: 1, started_at: "2026-10-30T06:00:00.000Z" },
})

describe("the live model feed in the browser", () => {
  it("adds a call, appends its text, replaces it from a snapshot, and ends it", () => {
    let f = applyModelEvent(EMPTY, start("c1"))
    f = applyModelEvent(f, { type: "llm.delta", data: { full: false, calls: [{ call_id: "c1", thinking: "Looking ", output: "" }] } })
    f = applyModelEvent(f, { type: "llm.delta", data: { full: false, calls: [{ call_id: "c1", thinking: "closer.", output: '{"kind"' }, { call_id: "nope", thinking: "x", output: "" }] } })
    expect(f.calls).toEqual([expect.objectContaining({ id: "c1", thinking: "Looking closer.", output: '{"kind"', done: null, started_at: Date.parse("2026-10-30T06:00:00.000Z") })])
    f = applyModelEvent(f, { type: "llm.delta", data: { full: true, calls: [{ call_id: "c1", thinking: "All of it.", output: "" }] } })
    expect(f.calls[0]).toMatchObject({ thinking: "All of it.", output: "" })
    f = applyModelEvent(f, { type: "llm.done", data: { call_id: "c1", ok: true, error: null, ms: 4_200, prompt_tokens: 900, completion_tokens: 40, tokens_per_s: 44 } }, 1_000)
    expect(f.calls[0].done).toEqual({ ok: true, error: null, ms: 4_200, prompt_tokens: 900, completion_tokens: 40, tokens_per_s: 44, at: 1_000 })
    // Announced again after a reconnect: running after all.
    expect(applyModelEvent(f, start("c1")).calls[0].done).toBeNull()
  })

  it("keeps every running call and the newest 30 finished ones, and the server's slots", () => {
    let f = EMPTY
    for (let i = 0; i < 40; i++) {
      f = applyModelEvent(f, start(`c${i}`))
      if (i > 0) f = applyModelEvent(f, { type: "llm.done", data: { call_id: `c${i}`, ok: true, error: null, ms: 1, prompt_tokens: 0, completion_tokens: 0, tokens_per_s: null } })
    }
    f = applyModelEvent(f, start("c40"))
    expect(f.calls.filter((c) => !c.done).map((c) => c.id)).toEqual(["c40", "c0"])
    expect(f.calls.filter((c) => c.done)).toHaveLength(30)
    f = applyModelEvent(f, { type: "llm.status", data: { ok: true, error: null, slots: [{ id: 0, busy: true, prompt_tokens: 10, prompt_done: 10, decoded: 3, n_ctx: 100 }] } }, 5)
    expect(f.server).toEqual({ ok: true, error: null, slots: [{ id: 0, busy: true, prompt_tokens: 10, prompt_done: 10, decoded: 3, n_ctx: 100 }], at: 5 })
  })
})
