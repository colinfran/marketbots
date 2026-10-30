import { afterEach, describe, expect, it, vi } from "vitest"
import { readSlots } from "../../src/ai/model-server"
import { ModelMonitor } from "../../src/ai/monitor"
import { streamChat } from "../../src/ai/stream-chat"

type Emitted = { type: string; data: Record<string, unknown>; visibility: string | undefined }

const monitor = (visibility: "public" | "owner" = "owner") => {
  const emitted: Emitted[] = []
  const m = new ModelMonitor({ bus: { emit: (type, data, meta) => emitted.push({ type, data: data as Record<string, unknown>, visibility: meta.visibility }) }, visibility: () => visibility, flushMs: 1_000 })
  return { m, emitted }
}

describe("model monitor", () => {
  afterEach(() => vi.useRealTimers())

  it("announces a call, sends its new text once a second, flushes the rest at its end", () => {
    vi.useFakeTimers()
    const { m, emitted } = monitor()
    const call = m.start({ kind: "agent", label: "Agent on SOL/USD, step 1", model: "local/qwen", subject: "SOL/USD", episode_id: "e1", step: 1 })
    expect(emitted[0]).toMatchObject({ type: "llm.call", data: { call_id: call.id, kind: "agent", model: "qwen", episode_id: "e1", step: 1 } })
    call.thinking("Looking at ")
    call.thinking("the quote.")
    vi.advanceTimersByTime(1_000)
    expect(emitted[1]).toEqual({ type: "llm.delta", data: { full: false, calls: [{ call_id: call.id, thinking: "Looking at the quote.", output: "" }] }, visibility: "owner" })
    // Nothing new: nothing sent.
    vi.advanceTimersByTime(1_000)
    expect(emitted).toHaveLength(2)
    call.output('{"kind":"tool"')
    call.end({ ok: true, prompt_tokens: 900, completion_tokens: 40, tokens_per_s: 44.26 })
    expect(emitted.slice(2).map((e) => e.type)).toEqual(["llm.delta", "llm.done"])
    expect(emitted[2].data).toMatchObject({ calls: [{ thinking: "", output: '{"kind":"tool"' }] })
    expect(emitted[3].data).toMatchObject({ call_id: call.id, ok: true, prompt_tokens: 900, completion_tokens: 40, tokens_per_s: 44.3 })
    // Ended calls take no more text.
    call.output("more")
    vi.advanceTimersByTime(1_000)
    expect(emitted).toHaveLength(4)
  })

  it("gives a viewer who just connected the running calls and their text so far, and strips invisible characters", () => {
    vi.useFakeTimers()
    const { m } = monitor("public")
    const a = m.start({ kind: "summary", label: "Summary: Fed holds", model: "local/qwen" })
    a.output("The Fed​ held rates ")
    vi.advanceTimersByTime(1_000)
    a.output("steady.")
    const done = m.start({ kind: "research", label: "Research", model: "local/qwen" })
    done.end({ ok: false, error: "timed out" })
    const snap = m.snapshot()
    expect(snap.map((e) => e.type)).toEqual(["llm.call", "llm.delta"])
    expect(snap[1]).toMatchObject({ data: { full: true, calls: [{ call_id: a.id, output: "The Fed held rates steady.", thinking: "" }] }, meta: { visibility: "public" } })
  })
})

describe("streamed chat", () => {
  afterEach(() => vi.unstubAllGlobals())

  const sse = (chunks: unknown[]) =>
    new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })

  it("passes each piece of thinking and answer on as it arrives, with usage and speed", async () => {
    const fetch = vi.fn(async () =>
      sse([
        { choices: [{ delta: { reasoning_content: "Think " } }] },
        { choices: [{ delta: { reasoning_content: "hard." } }] },
        { choices: [{ delta: { content: '{"a":' } }] },
        { choices: [{ delta: { content: "1}" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 9 }, timings: { predicted_per_second: 41.5 } },
      ]),
    )
    vi.stubGlobal("fetch", fetch)
    const pieces: string[] = []
    const r = await streamChat("http://llm:8080/", { model: "qwen", messages: [] }, { timeoutMs: 5_000, onReasoning: (d) => pieces.push(`r:${d}`), onContent: (d) => pieces.push(`c:${d}`) })
    expect(pieces).toEqual(["r:Think ", "r:hard.", 'c:{"a":', "c:1}"])
    expect(r).toEqual({ content: '{"a":1}', reasoning: "Think hard.", prompt_tokens: 120, completion_tokens: 9, per_second: 41.5, finish: "stop" })
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown[])[1] && ((fetch.mock.calls[0] as unknown[])[1] as RequestInit).body))).toMatchObject({ model: "qwen", stream: true })
  })

  it("reads a plain JSON completion the same way, and throws on an error answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })))
    expect(await streamChat("http://llm:8080", {}, { timeoutMs: 5_000 })).toMatchObject({ content: "hi", prompt_tokens: 3, finish: "stop" })
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Loading model", { status: 503 })))
    await expect(streamChat("http://llm:8080", {}, { timeoutMs: 5_000 })).rejects.toThrow("the local model server answered 503: Loading model")
  })
})

describe("model server slots", () => {
  it("reads which slots work, on how long a prompt, and how much they wrote", () => {
    expect(
      readSlots([
        { id: 0, n_ctx: 98_304, is_processing: false, n_prompt_tokens: 0, next_token: [{ n_decoded: 0 }] },
        { id: 1, n_ctx: 98_304, is_processing: true, n_prompt_tokens: 1_576, n_prompt_tokens_processed: 1_272, next_token: [{ n_decoded: 35 }] },
        "junk",
      ]),
    ).toEqual([
      { id: 0, busy: false, prompt_tokens: 0, prompt_done: 0, decoded: 0, n_ctx: 98_304 },
      { id: 1, busy: true, prompt_tokens: 1_576, prompt_done: 1_272, decoded: 35, n_ctx: 98_304 },
    ])
    expect(readSlots({ error: "no slots" })).toEqual([])
  })
})
