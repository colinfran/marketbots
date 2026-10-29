import { describe, expect, it, vi } from "vitest"
import { llamaChat, type ChatRequest } from "../src/client"
import { newsObservations } from "../src/observations"

const sse = (chunks: unknown[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`))
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        c.close()
      },
    }),
    { status: 200 },
  )

const request = (r: Partial<ChatRequest> = {}): ChatRequest => ({ model: "local/qwen", messages: [{ role: "user", content: "hi" }], schema: { type: "object" }, temperature: 0.3, thinkingTokens: 0, maxTokens: 100, timeoutMs: 5_000, ...r })

describe("llama.cpp chat client", () => {
  it("streams thinking and content, and reads usage and speed", async () => {
    const fetchFn = vi.fn(async () =>
      sse([
        { choices: [{ delta: { reasoning_content: "Let me " } }] },
        { choices: [{ delta: { reasoning_content: "think." } }] },
        { choices: [{ delta: { content: '{"kind":' } }] },
        { choices: [{ delta: { content: '"answer"}' }, finish_reason: "stop" }] },
        { usage: { prompt_tokens: 900, completion_tokens: 30 }, timings: { cache_n: 850, predicted_per_second: 43.7 } },
      ]),
    )
    const deltas: string[] = []
    const r = await llamaChat("http://llm:8080/", fetchFn)(request({ thinkingTokens: 512, onReasoning: (d) => deltas.push(d) }))
    expect(r).toMatchObject({ ok: true, json: { kind: "answer" }, reasoning: "Let me think.", prompt_tokens: 900, completion_tokens: 30, cached_tokens: 850, gen_per_s: 43.7, finish_reason: "stop" })
    expect(deltas).toEqual(["Let me ", "think."])
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://llm:8080/v1/chat/completions")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: "qwen", chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: 512, cache_prompt: true, stream: true })
    expect(body.response_format.json_schema.schema).toEqual({ type: "object" })
  })

  it("turns thinking off for steps without a budget", async () => {
    const fetchFn = vi.fn(async () => sse([{ choices: [{ delta: { content: "{}" } }] }]))
    await llamaChat("http://llm:8080", fetchFn)(request())
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "none" })
    expect(body.thinking_budget_tokens).toBeUndefined()
  })

  it("never throws: HTTP errors, non-JSON answers and aborts come back as results", async () => {
    expect(await llamaChat("http://x", async () => new Response("loading model", { status: 503 }))(request())).toMatchObject({ ok: false, error: "HTTP 503: loading model", aborted: false })
    expect(await llamaChat("http://x", async () => sse([{ choices: [{ delta: { content: "not json" } }] }]))(request())).toMatchObject({ ok: false, content: "not json" })
    const abort = new AbortController()
    abort.abort()
    const r = await llamaChat("http://x", async (_u, init) => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", signal: init?.signal })))(request({ signal: abort.signal }))
    expect(r).toMatchObject({ ok: false, aborted: true, error: "aborted" })
  })
})

describe("news observations", () => {
  const item = { _id: "i1", title: "Exchange hacked", severity: 88, first_seen_at: new Date("2026-10-28T14:00:00Z"), category: "exploit", source: "rekt" }

  it("makes bad news about a holding a P0, an entry idea a P1, the rest P2", () => {
    const held = new Set(["SOL/USD"])
    expect(newsObservations(item, { rule: "held_negative", action: "review", symbols: ["SOL/USD"] }, { held, critical: 85 })[0]).toMatchObject({ subject: "SOL/USD", priority: 0, salience: 88, untrusted: true, refs: { item_ids: ["i1"] } })
    expect(newsObservations(item, { rule: "entry", action: "evaluate", symbols: ["ETH/USD", "ADA/USD"] }, { held, critical: 85 }).map((o) => [o.subject, o.priority])).toEqual([
      ["ETH/USD", 1],
      ["ADA/USD", 1],
    ])
    expect(newsObservations(item, { rule: "macro", action: "market_review", symbols: [] }, { held, critical: 85 })[0]).toMatchObject({ subject: "MARKET", priority: 0 })
    expect(newsObservations({ ...item, severity: 60 }, { rule: "macro", action: "market_review", symbols: [] }, { held, critical: 85 })[0].priority).toBe(2)
  })
})
