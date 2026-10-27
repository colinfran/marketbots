import { xai } from "@ai-sdk/xai"
import type { AiTask, TokenUsage } from "@mb/core/db"
import { generateText, NoObjectGeneratedError, Output, parsePartialJson, streamText, type LanguageModelUsage } from "ai"
import type { z } from "zod"
import { errorMessage, type Logger } from "../log"
import { cleanLine, cleanText, cleanUrl, domainOf } from "../util/text"
import { estimateCost, gatewayCost, type AiBudget } from "./budget"

/**
 * Model calls go through Vercel AI Gateway (AI_GATEWAY_API_KEY) with plain "provider/model" ids.
 * Web and X search are xAI's server-side tools, so Grok runs the searches itself; other gateway
 * models can be configured for decisions, but research needs a model with live search tools.
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
}

const queryOf = (input: unknown): string | null => {
  const i = input as { query?: unknown; queries?: unknown; search_query?: unknown } | null
  const q = i?.query ?? i?.search_query ?? (Array.isArray(i?.queries) ? i.queries.join(" | ") : null)
  return typeof q === "string" && q.trim() ? cleanLine(q, 200) : null
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

  constructor(
    private readonly budget: Pick<AiBudget, "record" | "estimateByDuration">,
    private readonly log: Logger,
    private readonly enabled: boolean,
    { stream = true, memoMaxChars = 16_000 }: AiRunnerOptions = {},
  ) {
    this.stream = stream
    this.memoMaxChars = memoMaxChars
  }

  get available() {
    return this.enabled
  }

  /** Records the call against the daily budget and returns the cost it was charged. */
  private async record(task: AiTask, model: string, cycleId: string | null, usage: TokenUsage, cost: number | null, toolCalls: number, started: number, error: string | null) {
    const durationMs = Date.now() - started
    // A call cut off by a timeout or abort reports no usage, but the provider still bills what it generated.
    const unreported = cost === null && usage.total === 0 && error !== null
    const costUsd = cost ?? (unreported ? await this.budget.estimateByDuration(task, model, durationMs).catch(() => 0) : estimateCost(usage.input, usage.output, toolCalls))
    await this.budget
      .record({
        task,
        model,
        cycle_id: cycleId,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cost_usd: costUsd,
        cost_source: cost !== null ? "gateway" : "estimate",
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
          } else if (part.type === "tool-call") {
            const q = queryOf(part.input)
            if (q) {
              queries.push(q)
              opts.progress?.onQuery?.(q, part.toolName)
            }
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
        totalCost += await this.record(opts.task ?? "research", step.model, opts.cycleId, usage, cost, queries.length, attemptStarted, null)
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
        totalCost += await this.record(opts.task ?? "research", step.model, opts.cycleId, usage, cost, queries.length, attemptStarted, lastError)
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
    if (!this.enabled) throw new Error("AI is disabled (AI_GATEWAY_API_KEY not set)")
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
      if (isLast && opts.fallback && schemaFailures === 0 && lastError) model = opts.fallback
      const started = Date.now()
      const reasoning = reasoningReporter(opts.progress?.onReasoning)
      // The gateway cost reported so far: per finished step when streamed. A failed non-streamed call reports none.
      let cost: number | null = null
      try {
        const call = {
          model,
          instructions: opts.system,
          prompt: opts.prompt + feedback,
          output: Output.object({ schema: opts.schema, name: opts.name, description: opts.description }),
          temperature: temperatures[attempt - 1],
          maxRetries: 2,
          abortSignal: opts.signal,
          timeout: { totalMs: opts.timeoutMs },
        }
        if (!this.stream) {
          const result = await generateText(call)
          const usage = toUsage(result.totalUsage ?? result.usage)
          const callCost = gatewayCost(result.providerMetadata)
          totalCost += await this.record(opts.task, model, opts.cycleId, usage, callCost, 0, started, null)
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
        totalCost += await this.record(opts.task, model, opts.cycleId, usage, cost, 0, started, null)
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
            totalCost += await this.record(opts.task, model, opts.cycleId, usage, cost, 0, started, null)
            totalUsage = addUsage(totalUsage, usage)
            this.log.warn("structured output repaired in code", { task: opts.task, attempt, dropped: repaired.dropped })
            return { output: repaired.report, attempts: attempt, repaired: true, model, cost_usd: totalCost, usage: totalUsage }
          }
        }
        const message = describeError(error)
        totalCost += await this.record(opts.task, model, opts.cycleId, usage, cost, 0, started, message)
        totalUsage = addUsage(totalUsage, usage)
        this.log.warn("structured attempt failed", { task: opts.task, attempt, model, error: message })
        // The SDK words a timeout several ways (its own, or an abort during its retry back-off), so a
        // failure at the time limit is what counts.
        if (opts.fallback && !NoObjectGeneratedError.isInstance(error) && Date.now() - started >= opts.timeoutMs - TIMEOUT_SLACK_MS) model = opts.fallback
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
