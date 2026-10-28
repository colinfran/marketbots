import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { AiBudget } from "../../src/ai/budget"
import { AiRunner, isLocalModel } from "../../src/ai/runner"
import { silentLogger } from "../../src/log"

/** "local/…" models through the real AI SDK, against a fake llama.cpp server (its OpenAI-compatible API). */

const MODEL = "local/qwen3.6-35b-a3b-q2"
const LLM_URL = "http://llm:8080"
const schema = z.object({ action: z.enum(["buy", "hold"]), conviction: z.number() })
const ANSWER = { action: "hold", conviction: 60 }

const budget = () =>
  ({ record: vi.fn(async () => undefined), estimateByDuration: vi.fn(async () => 0.12) }) as unknown as AiBudget & {
    record: ReturnType<typeof vi.fn>
    estimateByDuration: ReturnType<typeof vi.fn>
  }

const decide = (runner: AiRunner, over: { model?: string; fallback?: string | null; onReasoning?: (chars: number, excerpt: string) => void } = {}) =>
  runner.structured({
    task: "decision",
    cycleId: "c1",
    model: over.model ?? MODEL,
    fallback: over.fallback ?? null,
    system: "You decide.",
    prompt: "BTC/USD broke out.",
    schema,
    name: "decision",
    description: "The decision",
    repair: () => null,
    timeoutMs: 60_000,
    progress: { onReasoning: over.onReasoning },
  })

const completion = (content: string) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "qwen3.6-35b-a3b-q2",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, reasoning_content: "Weighing the breakout." } }],
      usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1_200 },
    }),
    { headers: { "content-type": "application/json" } },
  )

/** llama.cpp's stream: thinking first, then the answer, then usage. */
const events = (chunks: object[]) => {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        c.enqueue(encoder.encode("data: [DONE]\n\n"))
        c.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

const server = (respond: (body: Record<string, unknown>) => Response) => {
  const fetch = vi.fn(async (_url: string | URL, init: RequestInit = {}) => respond(JSON.parse(String(init.body)) as Record<string, unknown>))
  vi.stubGlobal("fetch", fetch)
  return {
    url: (i = 0) => String(fetch.mock.calls[i][0]),
    body: (i = 0) => JSON.parse(String(fetch.mock.calls[i][1]?.body)) as Record<string, unknown>,
    calls: () => fetch.mock.calls.length,
  }
}

describe("local models", () => {
  it("are the local/ ids", () => {
    expect([MODEL, "spacexai/grok-4.7", "localhost/x"].map(isLocalModel)).toEqual([true, false, false])
  })

  it("decide on the model server under its alias, without the gateway, and are recorded at no cost", async () => {
    const llm = server(() => completion(JSON.stringify(ANSWER)))
    const b = budget()
    // No gateway key at all: the local model doesn't need one.
    const r = await decide(new AiRunner(b, silentLogger, false, { stream: false, localUrl: LLM_URL }))
    expect(r).toMatchObject({ output: ANSWER, attempts: 1, repaired: false, model: MODEL, cost_usd: 0, usage: { input: 900, output: 300, total: 1_200 } })
    expect(llm.url()).toBe("http://llm:8080/v1/chat/completions")
    expect(llm.body()).toMatchObject({ model: "qwen3.6-35b-a3b-q2", response_format: { type: "json_schema", json_schema: { name: "decision", strict: true } } })
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ task: "decision", model: MODEL, cost_usd: 0, cost_source: "local", input_tokens: 900, output_tokens: 300, ok: true }))
  })

  it("stream their thinking, then the answer", async () => {
    const llm = server(() =>
      events([
        { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Weighing the breakout." } }] },
        { choices: [{ index: 0, delta: { content: '{"action":"hold",' } }] },
        { choices: [{ index: 0, delta: { content: '"conviction":60}' }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 900, completion_tokens: 300, total_tokens: 1_200 } },
      ]),
    )
    const b = budget()
    const onReasoning = vi.fn()
    const r = await decide(new AiRunner(b, silentLogger, true, { localUrl: `${LLM_URL}/` }), { onReasoning })
    expect(r).toMatchObject({ output: ANSWER, cost_usd: 0, usage: { input: 900, output: 300, total: 1_200 } })
    expect(onReasoning).toHaveBeenCalledWith("Weighing the breakout.".length, "Weighing the breakout.")
    expect(llm.url()).toBe("http://llm:8080/v1/chat/completions")
    expect(llm.body()).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ cost_usd: 0, cost_source: "local", ok: true }))
  })

  it("are refused without the server, and never become a fallback there", async () => {
    const b = budget()
    await expect(decide(new AiRunner(b, silentLogger, true))).rejects.toThrow("local/qwen3.6-35b-a3b-q2 needs the local model server (LLM_URL not set)")
    // A failing gateway model whose local fallback this runner can't use: three gateway attempts, never the fallback.
    server(() => new Response("bad request", { status: 400 }))
    const g = budget()
    await expect(decide(new AiRunner(g, silentLogger, true), { model: "spacexai/grok-4.7", fallback: MODEL })).rejects.toThrow(/decision failed after 3 attempts/)
    expect(g.record.mock.calls.map(([call]) => (call as { model: string }).model)).toEqual(["spacexai/grok-4.7", "spacexai/grok-4.7", "spacexai/grok-4.7"])
  })

  it("can be the fallback of a gateway model", async () => {
    const llm = server((body) => (body.model === "qwen3.6-35b-a3b-q2" ? completion(JSON.stringify(ANSWER)) : new Response("upstream down", { status: 400 })))
    const b = budget()
    const r = await decide(new AiRunner(b, silentLogger, true, { stream: false, localUrl: LLM_URL }), { model: "spacexai/grok-4.7", fallback: MODEL })
    expect(r).toMatchObject({ output: ANSWER, attempts: 3, model: MODEL })
    expect(llm.url(llm.calls() - 1)).toBe("http://llm:8080/v1/chat/completions")
    expect(b.record.mock.calls.map(([call]) => (call as { cost_source: string }).cost_source)).toEqual(["estimate", "estimate", "local"])
  })

  it("can't research: they have no live search", async () => {
    const r = await new AiRunner(budget(), silentLogger, true, { localUrl: LLM_URL }).research({ cycleId: "c", model: MODEL, fallback: null, prompt: "p", xSearch: true, fromDate: "2026-10-27", timeoutMs: 60_000 })
    expect(r).toMatchObject({ memo: "", error: "research model local/qwen3.6-35b-a3b-q2 has no live search tools" })
  })
})
