import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { AiBudget } from "../../src/ai/budget"
import { AiRunner, isLocalModel, localThinkingBudget } from "../../src/ai/runner"
import { silentLogger } from "../../src/log"

/** "local/…" models through the real AI SDK, against a fake llama.cpp server (its OpenAI-compatible API). */

const MODEL = "local/qwen3.6-35b-a3b-q2"
const LLM_URL = "http://llm:8080"
const schema = z.object({ action: z.enum(["buy", "hold"]), conviction: z.number() })
const ANSWER = { action: "hold", conviction: 60 }

const budget = () => ({ record: vi.fn(async () => undefined) }) as unknown as AiBudget & { record: ReturnType<typeof vi.fn> }

const decide = (runner: AiRunner, over: { model?: string; onReasoning?: (chars: number, excerpt: string) => void } = {}) =>
  runner.structured({
    task: "decision",
    cycleId: "c1",
    model: over.model ?? MODEL,
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

  it("think for what the timeout leaves after reading and answering", () => {
    expect([60, 90, 180, 240, 300].map((s) => localThinkingBudget(s * 1000))).toEqual([256, 256, 2_400, 4_096, 4_096])
  })

  it("decide on the model server under its alias, and are recorded at no cost", async () => {
    const llm = server(() => completion(JSON.stringify(ANSWER)))
    const b = budget()
    const r = await decide(new AiRunner(b, silentLogger, { stream: false, localUrl: LLM_URL }))
    expect(r).toMatchObject({ output: ANSWER, attempts: 1, repaired: false, model: MODEL, cost_usd: 0, usage: { input: 900, output: 300, total: 1_200 } })
    expect(llm.url()).toBe("http://llm:8080/v1/chat/completions")
    expect(llm.body()).toMatchObject({
      model: "qwen3.6-35b-a3b-q2",
      response_format: { type: "json_schema", json_schema: { name: "decision", strict: true } },
      // A 60-second call leaves next to no time to think.
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: 256,
    })
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
    const r = await decide(new AiRunner(b, silentLogger, { localUrl: `${LLM_URL}/` }), { onReasoning })
    expect(r).toMatchObject({ output: ANSWER, cost_usd: 0, usage: { input: 900, output: 300, total: 1_200 } })
    expect(onReasoning).toHaveBeenCalledWith("Weighing the breakout.".length, "Weighing the breakout.")
    expect(llm.url()).toBe("http://llm:8080/v1/chat/completions")
    expect(llm.body()).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ cost_usd: 0, cost_source: "local", ok: true }))
  })

  it("ask again after a failed attempt, cooler, with the error, and give up after three", async () => {
    let n = 0
    const llm = server(() => (++n < 3 ? new Response("server busy", { status: 400 }) : completion(JSON.stringify(ANSWER))))
    const b = budget()
    const r = await decide(new AiRunner(b, silentLogger, { stream: false, localUrl: LLM_URL }))
    expect(r).toMatchObject({ output: ANSWER, attempts: 3 })
    expect([llm.body(0).temperature, llm.body(1).temperature, llm.body(2).temperature]).toEqual([0.3, 0.15, 0])
    expect(String((llm.body(2).messages as { content: string }[]).at(-1)!.content)).toContain("IMPORTANT: your previous answer was rejected")
    expect(b.record.mock.calls.map(([call]) => (call as { ok: boolean }).ok)).toEqual([false, false, true])
    server(() => new Response("server busy", { status: 400 }))
    await expect(decide(new AiRunner(budget(), silentLogger, { stream: false, localUrl: LLM_URL }))).rejects.toThrow(/decision failed after 3 attempts/)
  })

  it("refuse a model that isn't local, and every model without the server", async () => {
    const runner = new AiRunner(budget(), silentLogger, { localUrl: LLM_URL })
    expect(runner.available).toBe(true)
    await expect(decide(runner, { model: "spacexai/grok-4.7" })).rejects.toThrow("spacexai/grok-4.7 isn't a local model (local/<alias>)")
    const none = new AiRunner(budget(), silentLogger)
    expect(none.available).toBe(false)
    await expect(decide(none)).rejects.toThrow("AI is disabled (LLM_URL not set)")
  })

  const researchOpts = { cycleId: "c", model: MODEL, prompt: "p", fromDate: "2026-10-27", timeoutMs: 60_000 }

  it("research through the engine's local research, at no cost", async () => {
    const localResearch = vi.fn(async () => ({
      memo: "- [FACT] HYPE unlock (2026-10-28, https://www.coindesk.com/x)",
      sources: [{ title: "HYPE unlock", url: "https://www.coindesk.com/x", domain: "coindesk.com" }],
      queries: ["HYPE token unlock", "Hyperliquid news", "HYPE token unlock"],
      usage: { input: 8_000, output: 1_100, total: 9_100 },
      error: null,
    }))
    const b = budget()
    const onQuery = vi.fn()
    const r = await new AiRunner(b, silentLogger, { localUrl: LLM_URL, localResearch }).research({ ...researchOpts, task: "research_gap", progress: { onQuery } })
    expect(r).toMatchObject({ error: null, model: MODEL, x_search: false, cost_usd: 0, queries: ["HYPE token unlock", "Hyperliquid news"], sources: [{ domain: "coindesk.com" }], usage: { total: 9_100 } })
    expect(localResearch).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL, prompt: "p", fromDate: "2026-10-27", timeoutMs: 60_000, progress: { onQuery } }))
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ task: "research_gap", model: MODEL, searches: 3, cost_usd: 0, cost_source: "local", ok: true }))
  })

  it("record a failed research at no cost, and an empty memo as a failure", async () => {
    const failing = vi.fn(async () => ({ memo: "", sources: [], queries: ["q"], usage: { input: 10, output: 0, total: 10 }, error: "the search service is unreachable" }))
    const b = budget()
    const r = await new AiRunner(b, silentLogger, { localUrl: LLM_URL, localResearch: failing }).research(researchOpts)
    expect(r).toMatchObject({ memo: "", error: "the search service is unreachable", usage: { total: 10 } })
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL, ok: false, error: "the search service is unreachable", cost_usd: 0 }))
    const blank = vi.fn(async () => ({ memo: "  ", sources: [], queries: ["q"], usage: { input: 10, output: 5, total: 15 }, error: null }))
    expect(await new AiRunner(budget(), silentLogger, { localUrl: LLM_URL, localResearch: blank }).research(researchOpts)).toMatchObject({ memo: "", error: "research returned an empty memo" })
  })

  it("can't research without the engine's local research, or with a model that isn't local", async () => {
    expect(await new AiRunner(budget(), silentLogger, { localUrl: LLM_URL }).research(researchOpts)).toMatchObject({ memo: "", error: "no research (LLM_URL or SEARCH_URL not set)" })
    const localResearch = vi.fn()
    expect(await new AiRunner(budget(), silentLogger, { localUrl: LLM_URL, localResearch }).research({ ...researchOpts, model: "spacexai/grok-4.5" })).toMatchObject({ error: "spacexai/grok-4.5 isn't a local model (local/<alias>)" })
    expect(localResearch).not.toHaveBeenCalled()
  })
})
