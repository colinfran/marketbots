import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible"
import type { AiTask, TokenUsage } from "@mb/core/db"
import { generateText, NoObjectGeneratedError, Output, parsePartialJson, streamText, type LanguageModelUsage } from "ai"
import type { z } from "zod"
import { errorMessage, type Logger } from "../log"
import { cleanLine, cleanText } from "../util/text"
import type { AiCallLog } from "./call-log"
import { isLocalModel, LOCAL_PREFIX } from "./models"

/**
 * Every model call runs on the local model server (LLM_URL: llama.cpp's OpenAI-compatible API,
 * docs/SERVER.md §9), with "local/<alias>" model ids. Calls cost nothing; each is recorded with
 * its tokens and time ("local").
 *
 * Research: the model can't browse, so the engine's local research (@mb/wire/research/local)
 * searches, reads and has the model write the memo; its queries, sources and memo are reported as
 * they come, so the dashboard can show the work. The structured decision streams (headline, then
 * each decision, and the model's thinking), unless the bot runs it non-streamed (`stream: false`).
 * Decisions think within the call's time (localThinkingBudget).
 */

const toUsage = (usage: LanguageModelUsage | undefined): TokenUsage => ({
  input: usage?.inputTokens ?? 0,
  output: usage?.outputTokens ?? 0,
  total: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
})

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total })

const ZERO: TokenUsage = { input: 0, output: 0, total: 0 }

export { isLocalModel }

/** What a call keeps for reading the prompt (~10 s) and writing the answer (up to ~4,500 tokens, ~100 s). */
const ANSWER_S = 120
/** The server's speed, a little under the 44–46 tokens/s it writes on its own. */
const TOKENS_PER_S = 40

/**
 * How long the model may think, in tokens: what the call's timeout leaves after reading and
 * answering, between 256 and 4,096 (Qwen 3.6's decisions thought ~3,600 in step 0). The server
 * then ends the thinking and the answer follows under the schema's grammar.
 */
export const localThinkingBudget = (timeoutMs: number) => Math.round(Math.min(4_096, Math.max(256, (timeoutMs / 1000 - ANSWER_S) * TOKENS_PER_S)))

/** How often streaming progress is reported (the feed doesn't need every token). */
const PROGRESS_MS = 1_500

/** A web source research cited. */
export type ResearchSource = { title: string; url: string; domain: string }

export type ResearchProgress = {
  onQuery?: (query: string, tool: string) => void
  onSource?: (source: ResearchSource) => void
  onText?: (chars: number, excerpt: string) => void
  onReasoning?: (chars: number, excerpt: string) => void
}

export type StructuredProgress = {
  /** The partial structured output so far (parsed leniently) and how many characters were written. */
  onPartial?: (chars: number, partial: unknown) => void
  onReasoning?: (chars: number, excerpt: string) => void
}

export type ResearchResult = {
  memo: string
  sources: ResearchSource[]
  queries: string[]
  model: string
  /** Always false: there is no X search. Kept for the research records the dashboards read. */
  x_search: boolean
  duration_ms: number
  usage: TokenUsage
  cost_usd: number
  error: string | null
}

export type AiRunnerOptions = {
  /** Stream structured (decision) calls. Default true; false runs each attempt as one generateText call. */
  stream?: boolean
  /** Longest research memo kept, in characters. Default 16,000. */
  memoMaxChars?: number
  /** The local model server (LLM_URL). Unset: no AI. */
  localUrl?: string | null
  /** Research (the engine supplies it, @mb/wire/research/local). Unset: no research. */
  localResearch?: LocalResearch | null
}

/**
 * Research on the local model server. The model can't browse, so the searching and reading are
 * done for it; it gets the bot's research prompt as is. Never throws: failures come back as `error`.
 */
export type LocalResearch = (job: {
  model: string
  prompt: string
  fromDate: string
  timeoutMs: number
  signal?: AbortSignal
  progress?: ResearchProgress
  /** What the live model feed calls this research (its subject). */
  label?: string
  /** Only the search service's free engines: no metered providers, no paid searches. */
  freeOnly?: boolean
}) => Promise<{ memo: string; sources: ResearchSource[]; queries: string[]; usage: TokenUsage; error: string | null }>

/** Throttled reasoning reporter: the last ~240 characters, at most every PROGRESS_MS. */
const reasoningReporter = (report?: (chars: number, excerpt: string) => void) => {
  let text = ""
  let last = 0
  return (delta: string) => {
    if (!report) return
    text += delta
    if (Date.now() - last < PROGRESS_MS) return
    last = Date.now()
    report(text.length, cleanLine(text.slice(-240), 240))
  }
}

export class AiRunner {
  private readonly stream: boolean
  private readonly memoMaxChars: number
  private readonly local: OpenAICompatibleProvider | null
  private readonly localResearch: LocalResearch | null

  constructor(
    private readonly calls: Pick<AiCallLog, "record">,
    private readonly log: Logger,
    { stream = true, memoMaxChars = 16_000, localUrl = null, localResearch = null }: AiRunnerOptions = {},
  ) {
    this.stream = stream
    this.memoMaxChars = memoMaxChars
    this.local = localUrl ? createOpenAICompatible({ name: "local", baseURL: `${localUrl.replace(/\/+$/, "")}/v1`, includeUsage: true, supportsStructuredOutputs: true }) : null
    this.localResearch = localResearch
  }

  /** Whether there is a model server to call. */
  get available() {
    return this.local !== null
  }

  /** Why a model can't be used here, or null when it can. */
  private refusal(model: string): string | null {
    if (!isLocalModel(model)) return `${model} isn't a local model (local/<alias>)`
    return this.local ? null : "AI is disabled (LLM_URL not set)"
  }

  /** Records the call (it costs nothing). `searches` is null for calls without a search. */
  private async record(task: AiTask, model: string, cycleId: string | null, usage: TokenUsage, searches: number | null, started: number, error: string | null) {
    await this.calls
      .record({
        task,
        model,
        cycle_id: cycleId,
        input_tokens: usage.input,
        output_tokens: usage.output,
        ...(searches !== null ? { searches } : {}),
        cost_usd: 0,
        cost_source: "local",
        duration_ms: Date.now() - started,
        ok: error === null,
        error,
      })
      .catch((e) => this.log.warn("recording AI call failed", { error: errorMessage(e) }))
  }

  /** Research. Never throws: failure yields an empty memo and the error. */
  async research(opts: {
    cycleId: string
    model: string
    prompt: string
    fromDate: string
    timeoutMs: number
    signal?: AbortSignal
    /** research_gap for the news engine's short gap-fill research. */
    task?: AiTask
    progress?: ResearchProgress
  }): Promise<ResearchResult> {
    const started = Date.now()
    const empty = (error: string, usage: TokenUsage = ZERO): ResearchResult => ({ memo: "", sources: [], queries: [], model: opts.model, x_search: false, duration_ms: Date.now() - started, usage, cost_usd: 0, error })
    const refused = this.refusal(opts.model) ?? (this.localResearch ? null : "no research (LLM_URL or SEARCH_URL not set)")
    if (refused) return empty(refused)
    if (opts.signal?.aborted) return empty("aborted")
    const r = await this.localResearch!({ model: opts.model, prompt: opts.prompt, fromDate: opts.fromDate, timeoutMs: opts.timeoutMs, signal: opts.signal, progress: opts.progress })
    const memo = cleanText(r.memo, this.memoMaxChars)
    const error = r.error ?? (memo ? null : "research returned an empty memo")
    await this.record(opts.task ?? "research", opts.model, opts.cycleId, r.usage, r.queries.length, started, error)
    if (error) {
      this.log.warn("research failed", { model: opts.model, error: error.slice(0, 600) })
      return empty(error.slice(0, 600), r.usage)
    }
    return { memo, sources: r.sources.slice(0, 40), queries: [...new Set(r.queries)].slice(0, 60), model: opts.model, x_search: false, duration_ms: Date.now() - started, usage: r.usage, cost_usd: 0, error: null }
  }

  /**
   * Structured decision with up to three attempts at decreasing temperature. A schema failure is
   * first repaired in code; if the repair lost items and there's another attempt left, the model
   * is asked again with the exact validation error.
   */
  async structured<T>(opts: {
    task: AiTask
    cycleId: string
    model: string
    system: string
    prompt: string
    schema: z.ZodType<T>
    name: string
    description: string
    repair: (text: string | undefined) => { report: T; dropped: number } | null
    timeoutMs: number
    signal?: AbortSignal
    /** Streamed calls only. */
    progress?: StructuredProgress
  }): Promise<{ output: T; attempts: number; repaired: boolean; model: string; cost_usd: number; usage: TokenUsage }> {
    const refused = this.refusal(opts.model)
    if (refused) throw new Error(refused)
    const model = opts.model
    const temperatures = [0.3, 0.15, 0]
    let feedback = ""
    let lastError: unknown = null
    let totalUsage = ZERO

    for (let attempt = 1; attempt <= temperatures.length; attempt++) {
      if (opts.signal?.aborted) throw new Error("aborted")
      const isLast = attempt === temperatures.length
      const started = Date.now()
      const reasoning = reasoningReporter(opts.progress?.onReasoning)
      try {
        const call = {
          model: this.local!.chatModel(model.slice(LOCAL_PREFIX.length)),
          instructions: opts.system,
          prompt: opts.prompt + feedback,
          output: Output.object({ schema: opts.schema, name: opts.name, description: opts.description }),
          temperature: temperatures[attempt - 1],
          maxRetries: 2,
          abortSignal: opts.signal,
          timeout: { totalMs: opts.timeoutMs },
          // Passed through to llama.cpp: Qwen's thinking switch, and the server's cap on it.
          providerOptions: { local: { chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: localThinkingBudget(opts.timeoutMs) } },
        }
        if (!this.stream) {
          const result = await generateText(call)
          const usage = toUsage(result.totalUsage ?? result.usage)
          await this.record(opts.task, model, opts.cycleId, usage, null, started, null)
          totalUsage = addUsage(totalUsage, usage)
          return { output: result.output as T, attempts: attempt, repaired: false, model, cost_usd: 0, usage: totalUsage }
        }
        const result = streamText(call)
        let text = ""
        let lastProgress = 0
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            text += part.text
            if (opts.progress?.onPartial && Date.now() - lastProgress > PROGRESS_MS) {
              lastProgress = Date.now()
              const partial = await parsePartialJson(text)
              opts.progress.onPartial(text.length, partial.value)
            }
          } else if (part.type === "reasoning-delta") {
            reasoning(part.text)
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          }
        }
        const output = (await result.output) as T
        const usage = toUsage(await result.totalUsage)
        await this.record(opts.task, model, opts.cycleId, usage, null, started, null)
        totalUsage = addUsage(totalUsage, usage)
        return { output, attempts: attempt, repaired: false, model, cost_usd: 0, usage: totalUsage }
      } catch (error) {
        lastError = error
        let usage = ZERO
        if (NoObjectGeneratedError.isInstance(error)) {
          usage = toUsage(error.usage)
          const repaired = opts.repair(error.text)
          if (repaired && (repaired.dropped === 0 || isLast)) {
            await this.record(opts.task, model, opts.cycleId, usage, null, started, null)
            totalUsage = addUsage(totalUsage, usage)
            this.log.warn("structured output repaired in code", { task: opts.task, attempt, dropped: repaired.dropped })
            return { output: repaired.report, attempts: attempt, repaired: true, model, cost_usd: 0, usage: totalUsage }
          }
        }
        const message = describeError(error)
        await this.record(opts.task, model, opts.cycleId, usage, null, started, message)
        totalUsage = addUsage(totalUsage, usage)
        this.log.warn("structured attempt failed", { task: opts.task, attempt, model, error: message })
        feedback = `\n\nIMPORTANT: your previous answer was rejected: ${message}\nReturn ONLY one JSON object that matches the schema exactly (every field present, correct types, numbers as numbers, enums spelled exactly as listed).`
      }
    }
    throw new Error(`${opts.task} failed after ${temperatures.length} attempts: ${describeError(lastError)}`)
  }
}

/** Error text including the schema validation details, so the retry can tell the model exactly what to fix. */
const describeError = (error: unknown) => {
  const cause = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : ""
  return `${errorMessage(error)}${cause}`.slice(0, 1_200)
}
