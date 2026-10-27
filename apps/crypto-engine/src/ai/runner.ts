import { xai } from "@ai-sdk/xai"
import type { AiTask, ResearchSource, TokenUsage } from "@mb/crypto-core/db"
import { generateText, NoObjectGeneratedError, Output, streamText, type LanguageModelUsage } from "ai"
import type { z } from "zod"
import { errorMessage, type Logger } from "../log"
import { cleanLine, cleanText, cleanUrl, domainOf } from "../util/text"
import { estimateCost, gatewayCost, type AiBudget } from "./budget"

/**
 * Model calls go through Vercel AI Gateway (AI_GATEWAY_API_KEY) with plain "provider/model" ids,
 * exactly like stockmarketbot. Web and X search are xAI's server-side tools, so Grok runs the
 * searches itself; other gateway models can be configured for decisions, but research needs a
 * model with live search tools.
 *
 * Research streams (queries, sources and memo progress go to the live dashboard as they happen).
 * Decisions use generateText with a structured schema, a repair pass and feedback retries.
 */

const toUsage = (usage: LanguageModelUsage | undefined): TokenUsage => ({
  input: usage?.inputTokens ?? 0,
  output: usage?.outputTokens ?? 0,
  total: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
})

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, total: a.total + b.total })

/** Models whose provider offers xAI's server-side web_search / x_search tools. */
export const hasLiveSearch = (model: string) => /^(xai|spacexai)\//.test(model)

export type ResearchProgress = {
  onQuery?: (query: string, tool: string) => void
  onSource?: (source: ResearchSource) => void
  onText?: (chars: number, excerpt: string) => void
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

const queryOf = (input: unknown): string | null => {
  const i = input as { query?: unknown; queries?: unknown; search_query?: unknown } | null
  const q = i?.query ?? i?.search_query ?? (Array.isArray(i?.queries) ? i.queries.join(" | ") : null)
  return typeof q === "string" && q.trim() ? cleanLine(q, 200) : null
}

export class AiRunner {
  constructor(
    private readonly budget: AiBudget,
    private readonly log: Logger,
    private readonly enabled: boolean,
  ) {}

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
    const empty = (model: string, error: string, xSearch: boolean, usage: TokenUsage = { input: 0, output: 0, total: 0 }, cost = 0): ResearchResult => ({
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
    let totalUsage: TokenUsage = { input: 0, output: 0, total: 0 }
    for (const [i, step] of plan.entries()) {
      if (opts.signal?.aborted) break
      const attemptStarted = Date.now()
      const sources = new Map<string, ResearchSource>()
      const queries: string[] = []
      let text = ""
      let usage: TokenUsage = { input: 0, output: 0, total: 0 }
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
            if (Date.now() - lastProgress > 1_500) {
              lastProgress = Date.now()
              opts.progress?.onText?.(text.length, cleanLine(text.slice(-240), 240))
            }
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
        const memo = cleanText(text, 12_000)
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
   * is asked again with the exact validation error. The last attempt switches to the fallback
   * model when the primary keeps failing for non-schema reasons (outage, timeouts).
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
  }): Promise<{ output: T; attempts: number; repaired: boolean; model: string; cost_usd: number; usage: TokenUsage }> {
    if (!this.enabled) throw new Error("AI is disabled (AI_GATEWAY_API_KEY not set)")
    const temperatures = [0.3, 0.15, 0]
    let feedback = ""
    let lastError: unknown = null
    let model = opts.model
    let totalCost = 0
    let totalUsage: TokenUsage = { input: 0, output: 0, total: 0 }
    let schemaFailures = 0

    for (let attempt = 1; attempt <= temperatures.length; attempt++) {
      if (opts.signal?.aborted) throw new Error("aborted")
      const isLast = attempt === temperatures.length
      if (isLast && opts.fallback && schemaFailures === 0 && lastError) model = opts.fallback
      const started = Date.now()
      try {
        const result = await generateText({
          model,
          instructions: opts.system,
          prompt: opts.prompt + feedback,
          output: Output.object({ schema: opts.schema, name: opts.name, description: opts.description }),
          temperature: temperatures[attempt - 1],
          maxRetries: 2,
          abortSignal: opts.signal,
          timeout: { totalMs: opts.timeoutMs },
        })
        const usage = toUsage(result.totalUsage ?? result.usage)
        const cost = gatewayCost(result.providerMetadata)
        totalCost += await this.record(opts.task, model, opts.cycleId, usage, cost, 0, started, null)
        totalUsage = addUsage(totalUsage, usage)
        return { output: result.output as T, attempts: attempt, repaired: false, model, cost_usd: totalCost, usage: totalUsage }
      } catch (error) {
        lastError = error
        let usage: TokenUsage = { input: 0, output: 0, total: 0 }
        if (NoObjectGeneratedError.isInstance(error)) {
          schemaFailures += 1
          usage = toUsage(error.usage)
          const repaired = opts.repair(error.text)
          if (repaired && (repaired.dropped === 0 || isLast)) {
            totalCost += await this.record(opts.task, model, opts.cycleId, usage, null, 0, started, null)
            totalUsage = addUsage(totalUsage, usage)
            this.log.warn("structured output repaired in code", { task: opts.task, attempt, dropped: repaired.dropped })
            return { output: repaired.report, attempts: attempt, repaired: true, model, cost_usd: totalCost, usage: totalUsage }
          }
        }
        const message = describeError(error)
        totalCost += await this.record(opts.task, model, opts.cycleId, usage, null, 0, started, message)
        totalUsage = addUsage(totalUsage, usage)
        this.log.warn("structured attempt failed", { task: opts.task, attempt, model, error: message })
        feedback = `\n\nIMPORTANT: your previous answer was rejected: ${message}\nReturn ONLY one JSON object that matches the schema exactly (every field present, correct types, numbers as numbers, enums spelled exactly as listed).`
      }
    }
    throw new Error(`${opts.task} failed after ${temperatures.length} attempts: ${describeError(lastError)}`)
  }
}

const describeError = (error: unknown) => {
  const cause = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : ""
  return `${errorMessage(error)}${cause}`.slice(0, 1_200)
}
