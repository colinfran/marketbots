import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible"
import { xai } from "@ai-sdk/xai"
import type { AiTask, TokenUsage } from "@mb/core/db"
import { generateText, NoObjectGeneratedError, Output, parsePartialJson, streamText, type LanguageModel, type LanguageModelUsage } from "ai"
import type { z } from "zod"
import { errorMessage, type Logger } from "../log"
import { cleanLine, cleanText, cleanUrl, domainOf } from "../util/text"
import { estimateCost, gatewayCost, type AiBudget } from "./budget"

/**
 * Model calls go through Vercel AI Gateway (AI_GATEWAY_API_KEY) with plain "provider/model" ids.
 * Web and X search are xAI's server-side tools, so Grok runs the searches itself; other gateway
 * models can be configured for decisions, but research needs a model with live search tools.
 *
 * "local/<alias>" ids run on the local model server instead (LLM_URL: llama.cpp's OpenAI-compatible
 * API, docs/SERVER.md §9). They think within the call's time (localThinkingBudget). They cost
 * nothing, so their calls are recorded at $0 ("local"), with their tokens and time. They can
 * decide, not research.
 *
 * Research streams its search queries, sources and the memo as it's written, so the dashboard can
 * show the work as it happens. The structured decision streams too (headline, then each decision,
 * and reasoning summaries when the provider returns them), unless the bot runs it non-streamed
 * (`stream: false`), where one generateText call returns the whole answer and its cost.
 */

const toUsage = (usage: LanguageModelUsage | undefined): TokenUsage => ({
  input: usage?.inputTokens ?? 0,
  output: usage?.outputTokens ?? 0,
  total: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
})

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total })

const ZERO: TokenUsage = { input: 0, output: 0, total: 0 }

/** Models whose provider offers xAI's server-side web_search / x_search tools. */
export const hasLiveSearch = (model: string) => /^(xai|spacexai)\//.test(model)

const LOCAL_PREFIX = "local/"

/** Models on the local model server: "local/<its alias>", e.g. local/qwen3.6-35b-a3b-q2. */
export const isLocalModel = (model: string) => model.startsWith(LOCAL_PREFIX)

/** What a local call keeps for reading the prompt (~10 s) and writing the answer (up to ~4,500 tokens, ~100 s). */
const LOCAL_ANSWER_S = 120
/** The server's speed, a little under the 44–46 tokens/s it writes on its own. */
const LOCAL_TOKENS_PER_S = 40

/**
 * How long a local model may think, in tokens: what the call's timeout leaves after reading and
 * answering, between 256 and 4,096 (Qwen 3.6's decisions thought ~3,600 in step 0). The server
 * then ends the thinking and the answer follows under the schema's grammar.
 */
export const localThinkingBudget = (timeoutMs: number) => Math.round(Math.min(4_096, Math.max(256, (timeoutMs / 1000 - LOCAL_ANSWER_S) * LOCAL_TOKENS_PER_S)))

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
  /** The local model server (LLM_URL), for "local/…" models. Unset: they are refused. */
  localUrl?: string | null
}

const queryOf = (input: unknown): string | null => {
  const i = input as { query?: unknown; queries?: unknown; search_query?: unknown } | null
  const q = i?.query ?? i?.search_query ?? (Array.isArray(i?.queries) ? i.queries.join(" | ") : null)
  return typeof q === "string" && q.trim() ? cleanLine(q, 200) : null
}

const parseJson = (text: string | undefined): unknown => {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** A structured call that failed this close to its time limit timed out (timers can fire a moment early). */
const TIMEOUT_SLACK_MS = 1_000

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

  constructor(
    private readonly budget: Pick<AiBudget, "record" | "estimateByDuration">,
    private readonly log: Logger,
    private readonly enabled: boolean,
    { stream = true, memoMaxChars = 16_000, localUrl = null }: AiRunnerOptions = {},
  ) {
    this.stream = stream
    this.memoMaxChars = memoMaxChars
    this.local = localUrl ? createOpenAICompatible({ name: "local", baseURL: `${localUrl.replace(/\/+$/, "")}/v1`, includeUsage: true, supportsStructuredOutputs: true }) : null
  }

  get available() {
    return this.enabled
  }

  /** Why a model can't be used here, or null when it can. */
  private refusal(model: string): string | null {
    if (isLocalModel(model)) return this.local ? null : `${model} needs the local model server (LLM_URL not set)`
    return this.enabled ? null : "AI is disabled (AI_GATEWAY_API_KEY not set)"
  }

  /** The gateway takes the id as it is; a local model goes to the server under its alias. */
  private languageModel(model: string): LanguageModel {
    return isLocalModel(model) && this.local ? this.local.chatModel(model.slice(LOCAL_PREFIX.length)) : model
  }

  /** Records the call against the daily budget and returns the cost it was charged. `searches` is null for calls without tools. */
  private async record(task: AiTask, model: string, cycleId: string | null, usage: TokenUsage, cost: number | null, searches: number | null, started: number, error: string | null) {
    const durationMs = Date.now() - started
    const local = isLocalModel(model)
    // A call cut off by a timeout or abort reports no usage, but the provider still bills what it generated.
    const unreported = cost === null && usage.total === 0 && error !== null
    const costUsd = local ? 0 : (cost ?? (unreported ? await this.budget.estimateByDuration(task, model, durationMs).catch(() => 0) : estimateCost(usage.input, usage.output, searches ?? 0)))
    await this.budget
      .record({
        task,
        model,
        cycle_id: cycleId,
        input_tokens: usage.input,
        output_tokens: usage.output,
        ...(searches !== null ? { searches } : {}),
        cost_usd: costUsd,
        cost_source: local ? "local" : cost !== null ? "gateway" : "estimate",
        duration_ms: durationMs,
        ok: error === null,
        error,
      })
      .catch((e) => this.log.warn("recording AI call failed", { error: errorMessage(e) }))
    return costUsd
  }

  /** Live research. Never throws: failure yields an empty memo and the error. */
  async research(opts: {
    cycleId: string
    model: string
    fallback: string | null
    prompt: string
    xSearch: boolean
    fromDate: string
    timeoutMs: number
    signal?: AbortSignal
    /** research_gap for the news engine's short gap-fill research (costed separately). */
    task?: AiTask
    progress?: ResearchProgress
  }): Promise<ResearchResult> {
    const started = Date.now()
    const empty = (model: string, error: string, xSearch: boolean, usage: TokenUsage = ZERO, cost = 0): ResearchResult => ({
      memo: "",
      sources: [],
      queries: [],
      model,
      x_search: xSearch,
      duration_ms: Date.now() - started,
      usage,
      cost_usd: cost,
      error,
    })
    if (!this.enabled) return empty(opts.model, "AI is disabled (AI_GATEWAY_API_KEY not set)", false)

    // Attempt 1: web + X. Attempt 2: web only (X search is the flakiest part). Attempt 3: fallback model.
    const plan: { model: string; withX: boolean }[] = []
    if (hasLiveSearch(opts.model)) {
      if (opts.xSearch) plan.push({ model: opts.model, withX: true })
      plan.push({ model: opts.model, withX: false })
    }
    if (opts.fallback && opts.fallback !== opts.model && hasLiveSearch(opts.fallback)) plan.push({ model: opts.fallback, withX: false })
    if (!plan.length) return empty(opts.model, `research model ${opts.model} has no live search tools`, false)

    let lastError = "no attempt made"
    let totalCost = 0
    let totalUsage = ZERO
    for (const [i, step] of plan.entries()) {
      if (opts.signal?.aborted) break
      const attemptStarted = Date.now()
      const sources = new Map<string, ResearchSource>()
      const queries: string[] = []
      // xAI's search tools declare no input fields, so the SDK hands each call's input back as {}: the
      // query is read from the call's raw arguments, else from a web search's result.
      const rawInputs = new Map<string, string>()
      const queried = new Set<string>()
      const addQuery = (callId: string, input: unknown, tool: string) => {
        const q = queryOf(input)
        if (!q || queried.has(callId)) return
        queried.add(callId)
        queries.push(q)
        opts.progress?.onQuery?.(q, tool)
      }
      let searches = 0
      const reasoning = reasoningReporter(opts.progress?.onReasoning)
      let text = ""
      let usage = ZERO
      let cost: number | null = null
      let lastProgress = 0
      try {
        const result = streamText({
          model: step.model,
          prompt: opts.prompt,
          tools: {
            web_search: xai.tools.webSearch({}),
            ...(step.withX ? { x_search: xai.tools.xSearch({ fromDate: opts.fromDate }) } : {}),
          },
          temperature: 0.2,
          maxRetries: 2,
          abortSignal: opts.signal,
          timeout: { totalMs: opts.timeoutMs },
        })
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") {
            text += part.text
            if (Date.now() - lastProgress > PROGRESS_MS) {
              lastProgress = Date.now()
              opts.progress?.onText?.(text.length, cleanLine(text.slice(-240), 240))
            }
          } else if (part.type === "reasoning-delta") {
            reasoning(part.text)
          } else if (part.type === "source" && part.sourceType === "url") {
            const url = cleanUrl(part.url)
            if (url && !sources.has(url)) {
              const source = { url, title: cleanLine(part.title ?? domainOf(url), 200), domain: domainOf(url) }
              sources.set(url, source)
              opts.progress?.onSource?.(source)
            }
          } else if (part.type === "tool-input-delta") {
            rawInputs.set(part.id, (rawInputs.get(part.id) ?? "") + part.delta)
          } else if (part.type === "tool-call") {
            searches += 1
            addQuery(part.toolCallId, part.input, part.toolName)
            addQuery(part.toolCallId, parseJson(rawInputs.get(part.toolCallId)), part.toolName)
          } else if (part.type === "tool-result") {
            addQuery(part.toolCallId, (part.output as { action?: unknown } | null)?.action, part.toolName)
          } else if (part.type === "finish-step") {
            const c = gatewayCost(part.providerMetadata)
            if (c !== null) cost = (cost ?? 0) + c
          } else if (part.type === "finish") {
            usage = toUsage(part.totalUsage)
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          }
        }
        const memo = cleanText(text, this.memoMaxChars)
        if (!memo) throw new Error("research returned an empty memo")
        totalCost += await this.record(opts.task ?? "research", step.model, opts.cycleId, usage, cost, searches, attemptStarted, null)
        totalUsage = addUsage(totalUsage, usage)
        return {
          memo,
          sources: [...sources.values()].slice(0, 40),
          queries: [...new Set(queries)].slice(0, 60),
          model: step.model,
          x_search: step.withX,
          duration_ms: Date.now() - started,
          usage: totalUsage,
          cost_usd: totalCost,
          error: null,
        }
      } catch (error) {
        lastError = errorMessage(error).slice(0, 600)
        totalCost += await this.record(opts.task ?? "research", step.model, opts.cycleId, usage, cost, searches, attemptStarted, lastError)
        totalUsage = addUsage(totalUsage, usage)
        this.log.warn("research attempt failed", { attempt: i + 1, model: step.model, x_search: step.withX, error: lastError })
      }
    }
    return empty(opts.model, lastError, false, totalUsage, totalCost)
  }

  /**
   * Structured decision with up to three attempts at decreasing temperature. A schema failure is
   * first repaired in code; if the repair lost items and there's another attempt left, the model
   * is asked again with the exact validation error. After a timeout the fallback model takes over
   * at once (another try on a model that ran out of time would most likely time out too, and be
   * billed again); after other non-schema failures (outages) it takes the last attempt.
   */
  async structured<T>(opts: {
    task: AiTask
    cycleId: string
    model: string
    fallback: string | null
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
    // A fallback this runner can't use is no fallback.
    const fallback = opts.fallback && !this.refusal(opts.fallback) ? opts.fallback : null
    const temperatures = [0.3, 0.15, 0]
    let feedback = ""
    let lastError: unknown = null
    let model = opts.model
    let totalCost = 0
    let totalUsage = ZERO
    let schemaFailures = 0

    for (let attempt = 1; attempt <= temperatures.length; attempt++) {
      if (opts.signal?.aborted) throw new Error("aborted")
      const isLast = attempt === temperatures.length
      if (isLast && fallback && schemaFailures === 0 && lastError) model = fallback
      const started = Date.now()
      const reasoning = reasoningReporter(opts.progress?.onReasoning)
      // The gateway cost reported so far: per finished step when streamed. A failed non-streamed call reports none.
      let cost: number | null = null
      try {
        const call = {
          model: this.languageModel(model),
          instructions: opts.system,
          prompt: opts.prompt + feedback,
          output: Output.object({ schema: opts.schema, name: opts.name, description: opts.description }),
          temperature: temperatures[attempt - 1],
          maxRetries: 2,
          abortSignal: opts.signal,
          timeout: { totalMs: opts.timeoutMs },
          // Passed through to llama.cpp: Qwen's thinking switch, and the server's cap on it.
          ...(isLocalModel(model) ? { providerOptions: { local: { chat_template_kwargs: { enable_thinking: true }, thinking_budget_tokens: localThinkingBudget(opts.timeoutMs) } } } : {}),
        }
        if (!this.stream) {
          const result = await generateText(call)
          const usage = toUsage(result.totalUsage ?? result.usage)
          const callCost = gatewayCost(result.providerMetadata)
          totalCost += await this.record(opts.task, model, opts.cycleId, usage, callCost, null, started, null)
          totalUsage = addUsage(totalUsage, usage)
          return { output: result.output as T, attempts: attempt, repaired: false, model, cost_usd: totalCost, usage: totalUsage }
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
          } else if (part.type === "finish-step") {
            const c = gatewayCost(part.providerMetadata)
            if (c !== null) cost = (cost ?? 0) + c
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          }
        }
        const output = (await result.output) as T
        const usage = toUsage(await result.totalUsage)
        totalCost += await this.record(opts.task, model, opts.cycleId, usage, cost, null, started, null)
        totalUsage = addUsage(totalUsage, usage)
        return { output, attempts: attempt, repaired: false, model, cost_usd: totalCost, usage: totalUsage }
      } catch (error) {
        lastError = error
        let usage = ZERO
        if (NoObjectGeneratedError.isInstance(error)) {
          schemaFailures += 1
          usage = toUsage(error.usage)
          const repaired = opts.repair(error.text)
          if (repaired && (repaired.dropped === 0 || isLast)) {
            totalCost += await this.record(opts.task, model, opts.cycleId, usage, cost, null, started, null)
            totalUsage = addUsage(totalUsage, usage)
            this.log.warn("structured output repaired in code", { task: opts.task, attempt, dropped: repaired.dropped })
            return { output: repaired.report, attempts: attempt, repaired: true, model, cost_usd: totalCost, usage: totalUsage }
          }
        }
        const message = describeError(error)
        totalCost += await this.record(opts.task, model, opts.cycleId, usage, cost, null, started, message)
        totalUsage = addUsage(totalUsage, usage)
        this.log.warn("structured attempt failed", { task: opts.task, attempt, model, error: message })
        // The SDK words a timeout several ways (its own, or an abort during its retry back-off), so a
        // failure at the time limit is what counts.
        if (fallback && !NoObjectGeneratedError.isInstance(error) && Date.now() - started >= opts.timeoutMs - TIMEOUT_SLACK_MS) model = fallback
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
