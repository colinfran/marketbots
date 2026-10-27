import { cryptoReportSchema, type CryptoDecision, type CryptoReport } from "@mb/crypto-core/report"
import { AiRunner as SharedAiRunner, type StructuredProgress } from "@mb/engine-kit/ai/runner"
import { silentLogger } from "@mb/engine-kit/log"
import { convertArrayToReadableStream, MockLanguageModelV4, MockProviderV4 } from "ai/test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { repairCryptoReport } from "../src/ai/repair"
import { AiRunner } from "../src/ai/runner"

/**
 * Crypto's decision call streams. These run the real AI SDK against a
 * scripted model, once through crypto's runner (streamed) and once through the binding crypto used
 * before (`stream: false`), and check that both send the model the same request and parse,
 * validate and repair the same answers the same way. Only progress and per-attempt cost differ.
 */

const MODEL = "spacexai/grok-4.7"
const usage = { inputTokens: { total: 1_000, noCache: 1_000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 400, text: 400, reasoning: undefined } }
const finishReason = { unified: "stop", raw: "stop" }

type Answer = { text: string; cost: number; reasoning?: string }

/** A model that gives its n-th call the n-th answer: whole when generated, in 50-character chunks when streamed. */
const scripted = (answers: Answer[]) => {
  let calls = 0
  return new MockLanguageModelV4({
    provider: "spacexai",
    modelId: "grok-4.7",
    doGenerate: async () => {
      const a = answers[calls++]
      return { content: [{ type: "text", text: a.text }], finishReason, usage, providerMetadata: { gateway: { cost: String(a.cost) } }, warnings: [] } as never
    },
    doStream: async () => {
      const a = answers[calls++]
      const reasoning = a.reasoning
        ? [
            { type: "reasoning-start", id: "r" },
            { type: "reasoning-delta", id: "r", delta: a.reasoning },
            { type: "reasoning-end", id: "r" },
          ]
        : []
      const deltas = (a.text.match(/[\s\S]{1,50}/g) ?? []).map((delta) => ({ type: "text-delta", id: "t", delta }))
      const parts = [
        { type: "stream-start", warnings: [] },
        ...reasoning,
        { type: "text-start", id: "t" },
        ...deltas,
        { type: "text-end", id: "t" },
        { type: "finish", finishReason, usage, providerMetadata: { gateway: { cost: String(a.cost) } } },
      ]
      return { stream: convertArrayToReadableStream(parts) } as never
    },
  })
}

const budget = () => ({ record: vi.fn(async (_call: Record<string, unknown>) => undefined), estimateByDuration: vi.fn(async () => 0.12) })
type Budget = ReturnType<typeof budget>

const decide = (runner: SharedAiRunner, progress?: StructuredProgress) =>
  runner.structured({
    task: "decision",
    cycleId: "c",
    model: MODEL,
    fallback: null,
    system: "SYSTEM PROMPT",
    prompt: "USER PROMPT",
    schema: cryptoReportSchema,
    name: "crypto_decisions",
    description: "CryptoMarketBot decisions: one per candidate and held position, with evidence and levels.",
    repair: repairCryptoReport,
    timeoutMs: 60_000,
    progress,
  })

type Outcome = { ok: true; output: unknown; attempts: number; repaired: boolean; usage: unknown } | { ok: false; error: string }

/** Runs the same answers through crypto's runner and through the non-streamed binding it had before. */
const both = async (answers: Answer[]) => {
  const run = async (stream: boolean) => {
    const model = scripted(answers)
    globalThis.AI_SDK_DEFAULT_PROVIDER = new MockProviderV4({ languageModels: { [MODEL]: model } })
    const b = budget()
    const progress = { onPartial: vi.fn(), onReasoning: vi.fn() }
    const runner = stream ? new AiRunner(b as never, silentLogger, true) : new SharedAiRunner(b as never, silentLogger, true, { stream: false, memoMaxChars: 12_000 })
    const outcome: Outcome = await decide(runner, progress).then(
      (r) => ({ ok: true as const, output: r.output, attempts: r.attempts, repaired: r.repaired, usage: r.usage }),
      (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }),
    )
    const calls = (stream ? model.doStreamCalls : model.doGenerateCalls).map((c) => ({ prompt: c.prompt, responseFormat: c.responseFormat, temperature: c.temperature, tools: c.tools, toolChoice: c.toolChoice }))
    return { outcome, calls, budget: b, progress }
  }
  return { streamed: await run(true), before: await run(false) }
}

const costs = (b: Budget) => b.record.mock.calls.map(([c]) => [c.cost_source, c.ok])

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

afterEach(() => {
  globalThis.AI_SDK_DEFAULT_PROVIDER = undefined
})

describe("crypto's streamed decision against the non-streamed one it replaced", () => {
  it("sends the same request and returns the same validated report", async () => {
    const { streamed, before } = await both([{ text: JSON.stringify(good), cost: 0.02, reasoning: "Weighing the breakout against funding." }])
    expect(streamed.outcome).toEqual({ ok: true, output: good, attempts: 1, repaired: false, usage: { input: 1_000, output: 400, total: 1_400 } })
    expect(streamed.outcome).toEqual(before.outcome)
    expect(streamed.calls).toEqual(before.calls)
    expect(streamed.calls[0]).toMatchObject({ temperature: 0.3, responseFormat: { type: "json", name: "crypto_decisions" } })
    expect(JSON.stringify(streamed.calls[0].prompt)).toContain("SYSTEM PROMPT")
    // Only the streamed call reports progress; both charge the gateway's cost.
    expect(streamed.progress.onReasoning).toHaveBeenCalledWith(38, "Weighing the breakout against funding.")
    expect(streamed.progress.onPartial).toHaveBeenCalledWith(50, expect.objectContaining({ market_read: expect.objectContaining({ regime: "risk_on_trend" }) }))
    expect(before.progress.onPartial).not.toHaveBeenCalled()
    expect(before.progress.onReasoning).not.toHaveBeenCalled()
    expect(costs(streamed.budget)).toEqual([["gateway", true]])
    expect(costs(before.budget)).toEqual([["gateway", true]])
  })

  it("repairs a near-miss answer in code the same way", async () => {
    const nearMiss = { ...good, decisions: [{ ...decision(), conviction: "72", action: "Buy", stop_loss: "$63,000" }] }
    const { streamed, before } = await both([{ text: "```json\n" + JSON.stringify(nearMiss) + "\n```", cost: 0.02 }])
    expect(streamed.outcome).toMatchObject({ ok: true, attempts: 1, repaired: true })
    expect(streamed.outcome).toEqual(before.outcome)
    expect((streamed.outcome as { output: CryptoReport }).output.decisions[0]).toMatchObject({ conviction: 72, action: "buy", stop_loss: 63_000 })
    // The repaired call is now charged the gateway's cost; before, it was an estimate from tokens.
    expect(costs(streamed.budget)).toEqual([["gateway", true]])
    expect(costs(before.budget)).toEqual([["estimate", true]])
  })

  it("asks again with the same validation error when a repair would drop a decision", async () => {
    const lossy = { ...good, decisions: [{ ...decision(), action: "short" }, decision({ symbol: "ETH/USD", action: "hold" })] }
    const { streamed, before } = await both([
      { text: JSON.stringify(lossy), cost: 0.011 },
      { text: JSON.stringify(good), cost: 0.02 },
    ])
    expect(streamed.outcome).toMatchObject({ ok: true, output: good, attempts: 2, repaired: false })
    expect(streamed.outcome).toEqual(before.outcome)
    // The retry carries the exact same feedback, at the same lower temperature.
    expect(streamed.calls).toEqual(before.calls)
    expect(streamed.calls[1].temperature).toBe(0.15)
    expect(JSON.stringify(streamed.calls[1].prompt)).toContain("your previous answer was rejected")
    // Per-attempt cost: the rejected attempt now carries the gateway's cost too.
    expect(costs(streamed.budget)).toEqual([
      ["gateway", false],
      ["gateway", true],
    ])
    expect(costs(before.budget)).toEqual([
      ["estimate", false],
      ["gateway", true],
    ])
    expect(streamed.budget.record.mock.calls.map(([c]) => c.cost_usd)).toEqual([0.011, 0.02])
  })

  it("fails the same way when no answer can be read", async () => {
    const { streamed, before } = await both([
      { text: "I can't help with that.", cost: 0.01 },
      { text: "Still no JSON.", cost: 0.01 },
      { text: "{ not json", cost: 0.01 },
    ])
    expect(streamed.outcome).toMatchObject({ ok: false, error: expect.stringMatching(/^decision failed after 3 attempts: /) })
    expect(streamed.outcome).toEqual(before.outcome)
    expect(streamed.calls).toEqual(before.calls)
    expect(streamed.calls.map((c) => c.temperature)).toEqual([0.3, 0.15, 0])
  })
})
