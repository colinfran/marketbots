import { AiRunner, hasLiveSearch } from "@mb/engine-kit/ai/runner"
import { silentLogger } from "@mb/engine-kit/log"
import { botReportSchema, type BotReport } from "@mb/stock-core/report"
import { NoObjectGeneratedError, streamText } from "ai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AiBudget } from "../../src/ai/budget"
import { repairReport } from "../../src/ai/repair"
import { decision, report } from "../helpers/factories"

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamText: vi.fn() }))

const stream = vi.mocked(streamText)

const budget = () =>
  ({ record: vi.fn(async () => undefined), estimateByDuration: vi.fn(async () => 0.12) }) as unknown as AiBudget & {
    record: ReturnType<typeof vi.fn>
    estimateByDuration: ReturnType<typeof vi.fn>
  }

/** A stand-in for streamText's result: the parts on fullStream, plus the final output and usage. */
const fakeStream = (parts: unknown[], { output, usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }: { output?: unknown; usage?: unknown } = {}) =>
  ({
    fullStream: (async function* () {
      for (const p of parts) yield p
    })(),
    output: output instanceof Error ? Promise.reject(output) : Promise.resolve(output),
    totalUsage: Promise.resolve(usage),
  }) as never

const researchOpts = (overrides = {}) => ({ cycleId: "c", model: "spacexai/grok-4.5", fallback: null, prompt: "p", xSearch: true, fromDate: "2026-10-25", timeoutMs: 60_000, ...overrides })

beforeEach(() => {
  stream.mockReset()
})

describe("AiRunner.research", () => {
  it("streams queries, sources, the memo and reasoning, and records the gateway's cost", async () => {
    stream.mockReturnValueOnce(
      fakeStream([
        { type: "tool-call", toolName: "x_search", input: { query: "$NVDA earnings" } },
        { type: "tool-call", toolName: "web_search", input: { query: "nvidia guidance" } },
        { type: "reasoning-delta", text: "Checking whether guidance beat consensus." },
        { type: "source", sourceType: "url", url: "https://www.reuters.com/nvda", title: "Nvidia beats" },
        { type: "source", sourceType: "url", url: "javascript:alert(1)", title: "bad" },
        { type: "text-delta", text: "## 1. Tape & macro\n- Futures up (8:10 ET, https://www.reuters.com/nvda)" },
        { type: "finish-step", providerMetadata: { gateway: { cost: "0.031" } } },
        { type: "finish", totalUsage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } },
      ]),
    )
    const b = budget()
    const progress = { onQuery: vi.fn(), onSource: vi.fn(), onText: vi.fn(), onReasoning: vi.fn() }
    const r = await new AiRunner(b, silentLogger, true).research({ ...researchOpts(), progress })
    expect(r).toMatchObject({ error: null, x_search: true, queries: ["$NVDA earnings", "nvidia guidance"], usage: { input: 1000, output: 200, total: 1200 } })
    expect(r.memo).toContain("Futures up")
    expect(r.sources).toEqual([{ url: "https://www.reuters.com/nvda", title: "Nvidia beats", domain: "reuters.com" }])
    expect(r.cost_usd).toBeCloseTo(0.031)
    expect(progress.onQuery).toHaveBeenCalledWith("$NVDA earnings", "x_search")
    expect(progress.onSource).toHaveBeenCalledTimes(1)
    expect(progress.onText).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining("Tape & macro"))
    expect(progress.onReasoning).toHaveBeenCalledWith("Checking whether guidance beat consensus.".length, "Checking whether guidance beat consensus.")
    expect(Object.keys((stream.mock.calls[0][0] as { tools: object }).tools)).toEqual(["web_search", "x_search"])
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ task: "research", cost_usd: 0.031, cost_source: "gateway", ok: true }))
  })

  it("falls back to web-only search, then the fallback model, and never throws", async () => {
    stream.mockReturnValueOnce(fakeStream([{ type: "error", error: new Error("x_search unavailable") }])).mockReturnValueOnce(fakeStream([{ type: "text-delta", text: "memo" }]))
    expect(await new AiRunner(budget(), silentLogger, true).research(researchOpts())).toMatchObject({ memo: "memo", x_search: false, error: null })

    stream.mockReset()
    stream.mockImplementation(() => fakeStream([{ type: "error", error: new Error("gateway down") }]))
    const failed = await new AiRunner(budget(), silentLogger, true).research(researchOpts({ fallback: "xai/grok-4" }))
    expect(failed).toMatchObject({ memo: "", error: "gateway down" })
    expect(stream.mock.calls.map(([o]) => [(o as { model: string }).model, Object.keys((o as { tools: object }).tools)])).toEqual([
      ["spacexai/grok-4.5", ["web_search", "x_search"]],
      ["spacexai/grok-4.5", ["web_search"]],
      ["xai/grok-4", ["web_search"]],
    ])
  })

  it("treats an empty memo as a failure", async () => {
    stream.mockImplementation(() => fakeStream([{ type: "text-delta", text: "   " }]))
    expect((await new AiRunner(budget(), silentLogger, true).research(researchOpts({ xSearch: false }))).error).toBe("research returned an empty memo")
  })

  it("won't research with a model that has no live search, or without a key", async () => {
    expect(hasLiveSearch("spacexai/grok-4.7")).toBe(true)
    expect(hasLiveSearch("openai/gpt-5.1")).toBe(false)
    expect((await new AiRunner(budget(), silentLogger, true).research(researchOpts({ model: "openai/gpt-5.1" }))).error).toMatch(/no live search/)
    expect((await new AiRunner(budget(), silentLogger, false).research(researchOpts())).error).toMatch(/AI is disabled/)
    expect(stream).not.toHaveBeenCalled()
  })
})

describe("AiRunner.structured", () => {
  const opts = (overrides = {}) => ({
    task: "decision" as const,
    cycleId: "c",
    model: "spacexai/grok-4.7",
    fallback: null as string | null,
    system: "s",
    prompt: "p",
    schema: botReportSchema,
    name: "bot_report",
    description: "d",
    repair: repairReport,
    timeoutMs: 60_000,
    ...overrides,
  })
  const noObject = (text: string) =>
    new NoObjectGeneratedError({
      message: "No object generated",
      cause: new Error("Type validation failed"),
      text,
      response: { id: "r", timestamp: new Date(), modelId: "grok" },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as never,
      finishReason: "stop",
    })
  const good: BotReport = report({ decisions: [decision()] })

  it("streams partial output and reasoning, then returns the validated output", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-26T15:00:00Z") })
    const json = JSON.stringify(good)
    stream.mockReturnValueOnce(
      fakeStream(
        [
          { type: "reasoning-delta", text: "NVDA is holding VWAP." },
          { type: "text-delta", text: json.slice(0, 40) },
          { type: "text-delta", text: json.slice(40) },
          { type: "finish-step", providerMetadata: { gateway: { cost: 0.02 } } },
        ],
        { output: good },
      ),
    )
    const onPartial = vi.fn()
    const onReasoning = vi.fn()
    const r = await new AiRunner(budget(), silentLogger, true).structured({ ...opts(), progress: { onPartial, onReasoning } })
    vi.useRealTimers()
    expect(r).toMatchObject({ output: good, attempts: 1, repaired: false, cost_usd: 0.02, usage: { total: 150 } })
    expect(onPartial).toHaveBeenCalledWith(40, expect.objectContaining({ headline: expect.any(String) }))
    expect(onReasoning).toHaveBeenCalledWith(21, "NVDA is holding VWAP.")
    expect((stream.mock.calls[0][0] as { temperature: number; instructions: string }).instructions).toBe("s")
  })

  it("repairs in code when nothing is lost", async () => {
    const raw = { ...good, decisions: [{ ...good.decisions[0], conviction: "8", action: "Buy" }] }
    stream.mockReturnValueOnce(fakeStream([], { output: noObject("```json\n" + JSON.stringify(raw) + "\n```") }))
    const r = await new AiRunner(budget(), silentLogger, true).structured(opts())
    expect(r).toMatchObject({ attempts: 1, repaired: true })
    expect((r.output as BotReport).decisions[0]).toMatchObject({ conviction: 8, action: "buy" })
  })

  it("asks again with the validation error, cooler, instead of accepting a lossy repair", async () => {
    const lossy = { ...good, decisions: [{ ...good.decisions[0], action: "yolo" }] }
    stream.mockReturnValueOnce(fakeStream([], { output: noObject(JSON.stringify(lossy)) })).mockReturnValueOnce(fakeStream([], { output: good }))
    const r = await new AiRunner(budget(), silentLogger, true).structured(opts())
    expect(r).toMatchObject({ attempts: 2, repaired: false })
    const second = stream.mock.calls[1][0] as { prompt: string; temperature: number }
    expect(second.temperature).toBe(0.15)
    expect(second.prompt).toContain("IMPORTANT: your previous answer was rejected")
  })

  it("switches to the fallback model on the last attempt after outages, and throws after three failures", async () => {
    stream.mockImplementation(() => fakeStream([{ type: "error", error: new Error("gateway 503") }]))
    await expect(new AiRunner(budget(), silentLogger, true).structured(opts({ fallback: "xai/grok-4" }))).rejects.toThrow("decision failed after 3 attempts: gateway 503")
    expect(stream.mock.calls.map(([o]) => (o as { model: string }).model)).toEqual(["spacexai/grok-4.7", "spacexai/grok-4.7", "xai/grok-4"])
  })

  it("goes straight to the fallback model after a timeout, since the same model would likely time out again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T14:00:00Z") })
    stream
      .mockImplementationOnce(() => {
        vi.setSystemTime(Date.now() + 60_000)
        return fakeStream([], { output: new DOMException("The operation was aborted due to timeout", "TimeoutError") })
      })
      .mockReturnValueOnce(fakeStream([], { output: good }))
    const b = budget()
    const r = await new AiRunner(b, silentLogger, true).structured(opts({ fallback: "xai/grok-4" }))
    vi.useRealTimers()
    expect(r).toMatchObject({ output: good, attempts: 2, model: "xai/grok-4" })
    expect(stream.mock.calls.map(([o]) => (o as { model: string }).model)).toEqual(["spacexai/grok-4.7", "xai/grok-4"])
    expect(b.record.mock.calls.map(([c]) => [c.model, c.ok])).toEqual([
      ["spacexai/grok-4.7", false],
      ["xai/grok-4", true],
    ])
  })

  it("charges a timed-out call by how long it ran, since it reports no usage", async () => {
    stream.mockImplementation(() => fakeStream([{ type: "error", error: new Error("The operation was aborted due to timeout") }]))
    const b = budget()
    await expect(new AiRunner(b, silentLogger, true).structured(opts())).rejects.toThrow("timeout")
    expect(b.estimateByDuration).toHaveBeenCalledWith("decision", "spacexai/grok-4.7", expect.any(Number))
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ task: "decision", input_tokens: 0, cost_usd: 0.12, cost_source: "estimate", ok: false }))
  })

  it("refuses to run without a key", async () => {
    await expect(new AiRunner(budget(), silentLogger, false).structured(opts())).rejects.toThrow("AI is disabled")
  })
})
