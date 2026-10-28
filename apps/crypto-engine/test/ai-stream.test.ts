import { cryptoReportSchema, type CryptoDecision, type CryptoReport } from "@mb/crypto-core/report"
import { AiRunner as SharedAiRunner, type StructuredProgress } from "@mb/engine-kit/ai/runner"
import { silentLogger } from "@mb/engine-kit/log"
import { describe, expect, it, vi } from "vitest"
import { repairCryptoReport } from "../src/ai/repair"
import { AiRunner } from "../src/ai/runner"

/**
 * Crypto's decision call streams. These run the real AI SDK against a scripted model server
 * (llama.cpp's OpenAI-compatible API), once through crypto's runner (streamed) and once through the
 * binding crypto used before (`stream: false`), and check that both send the model the same request
 * and parse, validate and repair the same answers the same way. Only progress differs.
 */

const MODEL = "local/qwen3.6-35b-a3b-q2"
const LLM_URL = "http://llm:8080"
const usage = { prompt_tokens: 1_000, completion_tokens: 400, total_tokens: 1_400 }

type Answer = { text: string; reasoning?: string }

const sse = (chunks: object[]) => {
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

/** A model server whose n-th call gets the n-th answer: whole when not streamed, its thinking then 50-character chunks when streamed. */
const serve = (answers: Answer[]) => {
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      const a = answers[bodies.length - 1]
      if (!body.stream) {
        const message = { role: "assistant", content: a.text, ...(a.reasoning ? { reasoning_content: a.reasoning } : {}) }
        return new Response(JSON.stringify({ id: "c", object: "chat.completion", created: 0, model: "qwen", choices: [{ index: 0, finish_reason: "stop", message }], usage }), { headers: { "content-type": "application/json" } })
      }
      return sse([
        ...(a.reasoning ? [{ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: a.reasoning } }] }] : []),
        ...(a.text.match(/[\s\S]{1,50}/g) ?? []).map((content) => ({ choices: [{ index: 0, delta: { content } }] })),
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage },
      ])
    }),
  )
  return bodies
}

const callLog = () => ({ record: vi.fn(async (_call: Record<string, unknown>) => undefined) })
type CallLog = ReturnType<typeof callLog>

const decide = (runner: SharedAiRunner, progress?: StructuredProgress) =>
  runner.structured({
    task: "decision",
    cycleId: "c",
    model: MODEL,
    system: "SYSTEM PROMPT",
    prompt: "USER PROMPT",
    schema: cryptoReportSchema,
    name: "crypto_decisions",
    description: "CryptoMarketBot decisions: one per candidate and held position, with evidence and levels.",
    repair: repairCryptoReport,
    timeoutMs: 240_000,
    progress,
  })

type Outcome = { ok: true; output: unknown; attempts: number; repaired: boolean; usage: unknown } | { ok: false; error: string }

/** Runs the same answers through crypto's runner and through the non-streamed binding it had before. */
const both = async (answers: Answer[]) => {
  const run = async (stream: boolean) => {
    const bodies = serve(answers)
    const b = callLog()
    const progress = { onPartial: vi.fn(), onReasoning: vi.fn() }
    const runner = stream ? new AiRunner(b as never, silentLogger, { localUrl: LLM_URL }) : new SharedAiRunner(b as never, silentLogger, { stream: false, memoMaxChars: 12_000, localUrl: LLM_URL })
    const outcome: Outcome = await decide(runner, progress).then(
      (r) => ({ ok: true as const, output: r.output, attempts: r.attempts, repaired: r.repaired, usage: r.usage }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    )
    // The request, without how it is delivered.
    const calls = bodies.map(({ stream: _stream, stream_options: _options, ...rest }) => rest)
    return { outcome, calls, callLog: b, progress }
  }
  return { streamed: await run(true), before: await run(false) }
}

const records = (b: CallLog) => b.record.mock.calls.map(([c]) => [c.cost_source, c.cost_usd, c.ok])

const decision = (overrides: Partial<CryptoDecision> = {}): CryptoDecision => ({
  symbol: "BTC/USD",
  action: "buy",
  conviction: 72,
  uncertainty: "medium",
  p_target_first: 0.45,
  stop_loss: 63_000,
  take_profit: 70_000,
  horizon_hours: 48,
  size_pct_of_max: 60,
  reduce_pct: null,
  priced_in: "partially",
  thesis: "Breakout with ETF inflows.",
  bull_evidence: [{ claim: "ETF inflows of $500M", kind: "sourced_claim", source_url: "https://news.example/etf", as_of: "2026-10-25" }],
  bear_evidence: [{ claim: "Funding is elevated", kind: "speculation", source_url: null, as_of: null }],
  risks: ["macro data tomorrow"],
  invalidation: "Close below 63,000",
  ...overrides,
})

const good: CryptoReport = {
  market_read: { regime: "risk_on_trend", summary: "Risk-on: BTC broke out on ETF inflows while alts lag.", confidence: 70 },
  decisions: [decision(), decision({ symbol: "ETH/USD", action: "hold", stop_loss: null, take_profit: null })],
  data_gaps: ["No order-book depth for ETH/USD"],
  notification: "Buying BTC on the breakout",
}

describe("crypto's streamed decision against the non-streamed one it replaced", () => {
  it("sends the same request and returns the same validated report", async () => {
    const { streamed, before } = await both([{ text: JSON.stringify(good), reasoning: "Weighing the breakout against funding." }])
    expect(streamed.outcome).toEqual({ ok: true, output: good, attempts: 1, repaired: false, usage: { input: 1_000, output: 400, total: 1_400 } })
    expect(streamed.outcome).toEqual(before.outcome)
    expect(streamed.calls).toEqual(before.calls)
    expect(streamed.calls[0]).toMatchObject({
      model: "qwen3.6-35b-a3b-q2",
      temperature: 0.3,
      response_format: { type: "json_schema", json_schema: { name: "crypto_decisions" } },
      chat_template_kwargs: { enable_thinking: true },
      thinking_budget_tokens: 4_096,
    })
    expect(JSON.stringify(streamed.calls[0].messages)).toContain("SYSTEM PROMPT")
    // Only the streamed call reports progress; both are recorded, at no cost.
    expect(streamed.progress.onReasoning).toHaveBeenCalledWith(38, "Weighing the breakout against funding.")
    expect(streamed.progress.onPartial).toHaveBeenCalledWith(50, expect.objectContaining({ market_read: expect.objectContaining({ regime: "risk_on_trend" }) }))
    expect(before.progress.onPartial).not.toHaveBeenCalled()
    expect(before.progress.onReasoning).not.toHaveBeenCalled()
    expect(records(streamed.callLog)).toEqual([["local", 0, true]])
    expect(records(before.callLog)).toEqual([["local", 0, true]])
  })

  it("repairs a near-miss answer in code the same way", async () => {
    const nearMiss = { ...good, decisions: [{ ...decision(), conviction: "72", action: "Buy", stop_loss: "$63,000" }] }
    const { streamed, before } = await both([{ text: "```json\n" + JSON.stringify(nearMiss) + "\n```" }])
    expect(streamed.outcome).toMatchObject({ ok: true, attempts: 1, repaired: true })
    expect(streamed.outcome).toEqual(before.outcome)
    expect((streamed.outcome as { output: CryptoReport }).output.decisions[0]).toMatchObject({ conviction: 72, action: "buy", stop_loss: 63_000 })
    expect(records(streamed.callLog)).toEqual([["local", 0, true]])
    expect(records(before.callLog)).toEqual([["local", 0, true]])
  })

  it("asks again with the same validation error when a repair would drop a decision", async () => {
    const lossy = { ...good, decisions: [{ ...decision(), action: "short" }, decision({ symbol: "ETH/USD", action: "hold" })] }
    const { streamed, before } = await both([{ text: JSON.stringify(lossy) }, { text: JSON.stringify(good) }])
    expect(streamed.outcome).toMatchObject({ ok: true, output: good, attempts: 2, repaired: false })
    expect(streamed.outcome).toEqual(before.outcome)
    // The retry carries the exact same feedback, at the same lower temperature.
    expect(streamed.calls).toEqual(before.calls)
    expect(streamed.calls[1].temperature).toBe(0.15)
    expect(JSON.stringify(streamed.calls[1].messages)).toContain("your previous answer was rejected")
    expect(records(streamed.callLog)).toEqual([
      ["local", 0, false],
      ["local", 0, true],
    ])
    expect(records(streamed.callLog)).toEqual(records(before.callLog))
  })

  it("fails the same way when no answer can be read", async () => {
    const { streamed, before } = await both([{ text: "I can't help with that." }, { text: "Still no JSON." }, { text: "{ not json" }])
    expect(streamed.outcome).toMatchObject({ ok: false, error: expect.stringMatching(/^decision failed after 3 attempts: /) })
    expect(streamed.outcome).toEqual(before.outcome)
    expect(streamed.calls).toEqual(before.calls)
    expect(streamed.calls.map((c) => c.temperature)).toEqual([0.3, 0.15, 0])
  })
})
