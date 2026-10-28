import { AiRunner, type LocalResearch } from "@mb/engine-kit/ai/runner"
import { silentLogger } from "@mb/engine-kit/log"
import { botReportSchema, type BotReport } from "@mb/stock-core/report"
import { NoObjectGeneratedError, streamText } from "ai"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AiCallLog } from "@mb/engine-kit/ai/call-log"
import { repairReport } from "../../src/ai/repair"
import { decision, report } from "../helpers/factories"

vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), streamText: vi.fn() }))

const stream = vi.mocked(streamText)

const LLM_URL = "http://llm:8080"
const MODEL = "local/qwen3.6-35b-a3b-q2"

const callLog = () => ({ record: vi.fn(async () => undefined) }) as unknown as AiCallLog & { record: ReturnType<typeof vi.fn> }

/** A stand-in for streamText's result: the parts on fullStream, plus the final output and usage. */
const fakeStream = (parts: unknown[], { output, usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }: { output?: unknown; usage?: unknown } = {}) =>
  ({
    fullStream: (async function* () {
      for (const p of parts) yield p
    })(),
    output: output instanceof Error ? Promise.reject(output) : Promise.resolve(output),
    totalUsage: Promise.resolve(usage),
  }) as never

/** The engine's local research, scripted: it reports its queries, sources and memo as it goes. */
const research = (result: { memo?: string; queries?: string[]; sources?: { title: string; url: string; domain: string }[]; error?: string | null } = {}) =>
  vi.fn<LocalResearch>(async (job) => {
    for (const q of result.queries ?? []) job.progress?.onQuery?.(q, "web_search")
    for (const s of result.sources ?? []) job.progress?.onSource?.(s)
    if (result.memo) job.progress?.onText?.(result.memo.length, result.memo.slice(-240))
    return { memo: result.memo ?? "", sources: result.sources ?? [], queries: result.queries ?? [], usage: { input: 6_000, output: 1_000, total: 7_000 }, error: result.error ?? null }
  })

const researchOpts = (overrides = {}) => ({ cycleId: "c", model: MODEL, prompt: "p", fromDate: "2026-10-25", timeoutMs: 180_000, ...overrides })

beforeEach(() => {
  stream.mockReset()
})

describe("AiRunner.research", () => {
  it("reports queries, sources and the memo as the local research goes, and records it at no cost", async () => {
    const localResearch = research({
      memo: "## 1. Tape & macro\n- Futures up (8:10 ET, https://www.reuters.com/nvda)",
      queries: ["NVDA earnings guidance", "Nvidia data center revenue"],
      sources: [{ url: "https://www.reuters.com/nvda", title: "Nvidia beats", domain: "reuters.com" }],
    })
    const b = callLog()
    const progress = { onQuery: vi.fn(), onSource: vi.fn(), onText: vi.fn() }
    const r = await new AiRunner(b, silentLogger, { localUrl: LLM_URL, localResearch }).research({ ...researchOpts(), progress })
    expect(r).toMatchObject({ error: null, x_search: false, cost_usd: 0, queries: ["NVDA earnings guidance", "Nvidia data center revenue"], usage: { input: 6_000, output: 1_000, total: 7_000 } })
    expect(r.memo).toContain("Futures up")
    expect(r.sources).toEqual([{ url: "https://www.reuters.com/nvda", title: "Nvidia beats", domain: "reuters.com" }])
    expect(progress.onQuery).toHaveBeenCalledWith("NVDA earnings guidance", "web_search")
    expect(progress.onSource).toHaveBeenCalledTimes(1)
    expect(progress.onText).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining("Tape & macro"))
    expect(localResearch).toHaveBeenCalledWith(expect.objectContaining({ model: MODEL, prompt: "p", fromDate: "2026-10-25", timeoutMs: 180_000 }))
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ task: "research", searches: 2, cost_usd: 0, cost_source: "local", ok: true }))
  })

  it("lists a repeated query once, and still counts every search", async () => {
    const b = callLog()
    const r = await new AiRunner(b, silentLogger, { localUrl: LLM_URL, localResearch: research({ memo: "memo", queries: ["nvda guidance", "nvda guidance", "nvda price target"] }) }).research(researchOpts({ task: "research_gap" }))
    expect(r.queries).toEqual(["nvda guidance", "nvda price target"])
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ task: "research_gap", searches: 3 }))
  })

  it("never throws: a failed research comes back as its error, recorded as failed", async () => {
    const b = callLog()
    const r = await new AiRunner(b, silentLogger, { localUrl: LLM_URL, localResearch: research({ queries: ["q"], error: "the search service is unreachable" }) }).research(researchOpts())
    expect(r).toMatchObject({ memo: "", error: "the search service is unreachable" })
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: "the search service is unreachable", cost_usd: 0 }))
  })

  it("treats an empty memo as a failure", async () => {
    const r = await new AiRunner(callLog(), silentLogger, { localUrl: LLM_URL, localResearch: research({ memo: "   " }) }).research(researchOpts())
    expect(r).toMatchObject({ memo: "", error: "research returned an empty memo" })
  })

  it("won't research without the engine's local research, or with a model that isn't local", async () => {
    expect((await new AiRunner(callLog(), silentLogger, { localUrl: LLM_URL }).research(researchOpts())).error).toBe("no research (LLM_URL or SEARCH_URL not set)")
    const localResearch = research({ memo: "memo" })
    expect((await new AiRunner(callLog(), silentLogger, { localUrl: LLM_URL, localResearch }).research(researchOpts({ model: "spacexai/grok-4.5" }))).error).toBe("spacexai/grok-4.5 isn't a local model (local/<alias>)")
    expect(localResearch).not.toHaveBeenCalled()
  })
})

describe("AiRunner.structured", () => {
  const opts = (overrides = {}) => ({
    task: "decision" as const,
    cycleId: "c",
    model: MODEL,
    system: "s",
    prompt: "p",
    schema: botReportSchema,
    name: "bot_report",
    description: "d",
    repair: repairReport,
    timeoutMs: 60_000,
    ...overrides,
  })
  const runner = (b = callLog()) => new AiRunner(b, silentLogger, { localUrl: LLM_URL })
  const noObject = (text: string) =>
    new NoObjectGeneratedError({
      message: "No object generated",
      cause: new Error("Type validation failed"),
      text,
      response: { id: "r", timestamp: new Date(), modelId: "qwen3.6-35b-a3b-q2" },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } as never,
      finishReason: "stop",
    })
  const good: BotReport = report({ decisions: [decision()] })
  const modelOf = (i: number) => (stream.mock.calls[i][0] as unknown as { model: { modelId: string } }).model.modelId

  it("streams partial output and the model's thinking, then returns the validated output", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-26T15:00:00Z") })
    const json = JSON.stringify(good)
    stream.mockReturnValueOnce(
      fakeStream(
        [
          { type: "reasoning-delta", text: "NVDA is holding VWAP." },
          { type: "text-delta", text: json.slice(0, 40) },
          { type: "text-delta", text: json.slice(40) },
        ],
        { output: good },
      ),
    )
    const onPartial = vi.fn()
    const onReasoning = vi.fn()
    const r = await runner().structured({ ...opts(), progress: { onPartial, onReasoning } })
    vi.useRealTimers()
    expect(r).toMatchObject({ output: good, attempts: 1, repaired: false, model: MODEL, cost_usd: 0, usage: { total: 150 } })
    expect(onPartial).toHaveBeenCalledWith(40, expect.objectContaining({ headline: expect.any(String) }))
    expect(onReasoning).toHaveBeenCalledWith(21, "NVDA is holding VWAP.")
    expect((stream.mock.calls[0][0] as { instructions: string }).instructions).toBe("s")
    expect(modelOf(0)).toBe("qwen3.6-35b-a3b-q2")
  })

  it("repairs in code when nothing is lost", async () => {
    const raw = { ...good, decisions: [{ ...good.decisions[0], conviction: "8", action: "Buy" }] }
    stream.mockReturnValueOnce(fakeStream([], { output: noObject("```json\n" + JSON.stringify(raw) + "\n```") }))
    const r = await runner().structured(opts())
    expect(r).toMatchObject({ attempts: 1, repaired: true })
    expect((r.output as BotReport).decisions[0]).toMatchObject({ conviction: 8, action: "buy" })
  })

  it("asks again with the validation error, cooler, instead of accepting a lossy repair", async () => {
    const lossy = { ...good, decisions: [{ ...good.decisions[0], action: "yolo" }] }
    stream.mockReturnValueOnce(fakeStream([], { output: noObject(JSON.stringify(lossy)) })).mockReturnValueOnce(fakeStream([], { output: good }))
    const r = await runner().structured(opts())
    expect(r).toMatchObject({ attempts: 2, repaired: false })
    const second = stream.mock.calls[1][0] as { prompt: string; temperature: number }
    expect(second.temperature).toBe(0.15)
    expect(second.prompt).toContain("IMPORTANT: your previous answer was rejected")
  })

  it("asks the same model again after outages, and throws after three failures", async () => {
    stream.mockImplementation(() => fakeStream([{ type: "error", error: new Error("server 503") }]))
    await expect(runner().structured(opts())).rejects.toThrow("decision failed after 3 attempts: server 503")
    expect([modelOf(0), modelOf(1), modelOf(2)]).toEqual(["qwen3.6-35b-a3b-q2", "qwen3.6-35b-a3b-q2", "qwen3.6-35b-a3b-q2"])
  })

  it("caps the model's thinking by the call's timeout", async () => {
    stream.mockReturnValueOnce(fakeStream([], { output: good })).mockReturnValueOnce(fakeStream([], { output: good }))
    await runner().structured(opts({ timeoutMs: 240_000 }))
    await runner().structured(opts({ timeoutMs: 90_000 }))
    const caps = stream.mock.calls.map(([o]) => (o as unknown as { providerOptions: { local: { thinking_budget_tokens: number; chat_template_kwargs: unknown } } }).providerOptions.local)
    expect(caps).toEqual([
      { chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: 4_096 },
      { chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: 256 },
    ])
  })

  it("records a timed-out call as failed, at no cost", async () => {
    stream.mockImplementation(() => fakeStream([{ type: "error", error: new Error("The operation was aborted due to timeout") }]))
    const b = callLog()
    await expect(runner(b).structured(opts())).rejects.toThrow("timeout")
    expect(b.record).toHaveBeenCalledWith(expect.objectContaining({ task: "decision", model: MODEL, input_tokens: 0, cost_usd: 0, cost_source: "local", ok: false }))
  })

  it("refuses to run without the model server, or with a model that isn't local", async () => {
    await expect(new AiRunner(callLog(), silentLogger).structured(opts())).rejects.toThrow("AI is disabled (LLM_URL not set)")
    await expect(runner().structured(opts({ model: "spacexai/grok-4.7" }))).rejects.toThrow("spacexai/grok-4.7 isn't a local model (local/<alias>)")
    expect(stream).not.toHaveBeenCalled()
  })
})
