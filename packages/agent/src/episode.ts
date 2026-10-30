import type { AgentStepDoc, EpisodeStatus } from "@mb/core/agent"
import type { TokenUsage } from "@mb/core/db"
import type { AgentSettings } from "@mb/core/settings"
import type { ModelCall } from "@mb/engine-kit/ai/monitor"
import type { z } from "zod"
import type { ChatFn, ChatMessage, ChatResult } from "./client"
import { callTool, cap, jsonSchemaOf, TOOL_RESULT_CHARS, type AgentTool, type ToolContext } from "./tools"

/**
 * One episode (docs/plans/LOCAL-AI.md §8.2): the brief, then steps. Each step is the model's
 * thinking (when its priority allows it) and one JSON object, constrained by a grammar to be either
 * a tool call with a short purpose or the final answer. Earlier steps stay in the prompt unchanged,
 * so the server's prompt cache reads only each new part.
 *
 * Limits: the last step may only answer, and so may every step once 60% of the time is gone, so
 * the answer gets the rest; the time limit is the hard stop. An answer that fails the schema is
 * asked for once more at a lower temperature, with the error; after that the episode ends with no
 * answer. Nothing here acts on the answer: the runtime hands it to the bot.
 */

export type EpisodeLimits = AgentSettings["limits"]["p0"]

export type EpisodeInput<A> = {
  chat: ChatFn
  model: string
  system: string
  brief: string
  tools: readonly AgentTool[]
  answer: z.ZodType<A>
  limits: EpisodeLimits
  ctx: ToolContext
  /** A step begins (its number). */
  onStepStart?: (n: number) => void
  onStep?: (step: AgentStepDoc) => void
  /** Each step's model call, for the live model feed: its thinking and its JSON as they stream, then its end. */
  call?: (n: number) => ModelCall
  now?: () => number
}

export type EpisodeResult<A> = {
  status: Exclude<EpisodeStatus, "running">
  answer: A | null
  steps: AgentStepDoc[]
  error: string | null
  usage: TokenUsage
}

/** What each step keeps: the full record (the history store's); the dashboard's copy is shorter (journal.ts). */
export const STEP_CAPS = { args: 2_000, result: TOOL_RESULT_CHARS, thinking: 40_000 } as const

/** Tool calls stop once this share of the time is used. */
const TOOL_SHARE = 0.6
const TEMPERATURE = 0.3
const RETRY_TEMPERATURE = 0.1
/** Room for the answer itself, on top of the thinking budget. */
const ANSWER_TOKENS = 4_000

const toolStep = (t: AgentTool) => ({
  type: "object",
  properties: {
    kind: { type: "string", enum: ["tool"] },
    purpose: { type: "string", description: "At most 25 words: what this call is for." },
    tool: { type: "string", enum: [t.name] },
    args: jsonSchemaOf(t.args),
  },
  required: ["kind", "purpose", "tool", "args"],
  additionalProperties: false,
})

const answerStep = (answer: Record<string, unknown>) => ({
  type: "object",
  properties: { kind: { type: "string", enum: ["answer"] }, answer },
  required: ["kind", "answer"],
  additionalProperties: false,
})

/** The protocol paragraph every agent system prompt ends with. */
export const toolProtocol = (tools: readonly AgentTool[], steps: number) => `TOOLS
Look things up before you decide: the brief is short on purpose. Each turn, return ONE JSON object: {"kind":"tool","purpose":"...","tool":"<name>","args":{...}} to call a tool, or {"kind":"answer","answer":{...}} with your final answer. You have at most ${steps} turns, the answer included; when time runs short you will be asked to answer.
${tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`

const words = (text: unknown, max: number) => (typeof text === "string" ? text.split(/\s+/).slice(0, max).join(" ").slice(0, 300) : null)

export const runEpisode = async <A>(input: EpisodeInput<A>): Promise<EpisodeResult<A>> => {
  const now = input.now ?? Date.now
  const { limits, tools, ctx } = input
  const started = now()
  const hardStop = started + limits.seconds * 1000
  const toolStop = started + limits.seconds * 1000 * TOOL_SHARE
  const answerJson = jsonSchemaOf(input.answer)
  const anyStep = { anyOf: [...tools.map(toolStep), answerStep(answerJson)] }
  const answerOnly = answerStep(answerJson)
  const messages: ChatMessage[] = [
    { role: "system", content: `${input.system}\n\n${toolProtocol(tools, limits.steps)}` },
    { role: "user", content: input.brief },
  ]
  const steps: AgentStepDoc[] = []
  const usage: TokenUsage = { input: 0, output: 0, total: 0 }
  const done = (status: EpisodeResult<A>["status"], answer: A | null, error: string | null): EpisodeResult<A> => ({ status, answer, steps, error, usage })
  let retried = false

  for (let n = 1; n <= limits.steps + 1; n++) {
    if (ctx.signal.aborted) return done("aborted", null, "aborted")
    const remaining = hardStop - now()
    if (remaining <= 0) return done("no_answer", null, `out of time (${limits.seconds} s)`)
    // The step after the last is only the one retry of a rejected answer.
    if (n > limits.steps && !retried) break
    const mustAnswer = retried || n >= limits.steps || now() >= toolStop || tools.length === 0
    input.onStepStart?.(n)
    const call = input.call?.(n)
    const res: ChatResult = await input.chat({
      model: input.model,
      messages,
      schema: mustAnswer ? answerOnly : anyStep,
      temperature: retried ? RETRY_TEMPERATURE : TEMPERATURE,
      thinkingTokens: limits.thinking_tokens,
      maxTokens: limits.thinking_tokens + ANSWER_TOKENS,
      timeoutMs: remaining,
      signal: ctx.signal,
      onReasoning: (delta) => call?.thinking(delta),
      onContent: (delta) => call?.output(delta),
    })
    call?.end({ ok: res.ok, error: res.error, prompt_tokens: res.prompt_tokens, completion_tokens: res.completion_tokens, tokens_per_s: res.gen_per_s || null })
    usage.input += res.prompt_tokens
    usage.output += res.completion_tokens
    usage.total += res.prompt_tokens + res.completion_tokens
    const parsed = (res.ok ? res.json : undefined) as { kind?: string; tool?: string; purpose?: string; args?: unknown; answer?: unknown } | undefined
    const record = (fields: Partial<AgentStepDoc>): AgentStepDoc => {
      const step: AgentStepDoc = {
        n,
        kind: "invalid",
        tool: null,
        purpose: null,
        args: null,
        result: null,
        thinking: res.reasoning ? cap(res.reasoning, STEP_CAPS.thinking) : null,
        ms: res.wall_ms,
        prompt_tokens: res.prompt_tokens,
        cached_tokens: res.cached_tokens,
        completion_tokens: res.completion_tokens,
        gen_per_s: Math.round(res.gen_per_s * 10) / 10,
        error: null,
        ...fields,
      }
      steps.push(step)
      input.onStep?.(step)
      return step
    }

    if (!res.ok) {
      record({ error: res.error })
      if (res.aborted) return ctx.signal.aborted ? done("aborted", null, "aborted") : done("no_answer", null, res.error)
      if (!retried && res.content) {
        retried = true
        messages.push({ role: "assistant", content: res.content }, { role: "user", content: `That was not valid JSON (${res.error}). Answer now with ONE JSON object: {"kind":"answer","answer":{...}}.` })
        continue
      }
      return done(res.content ? "invalid" : "failed", null, res.error)
    }

    if (parsed?.kind === "tool" && !mustAnswer) {
      const name = typeof parsed.tool === "string" ? parsed.tool : ""
      const call = await callTool(tools, name, parsed.args, ctx)
      record({ kind: "tool", tool: name, purpose: words(parsed.purpose, 25), args: cap(JSON.stringify(parsed.args ?? {}), STEP_CAPS.args), result: cap(call.result, STEP_CAPS.result), error: call.error })
      const left = limits.steps - n
      const nextMustAnswer = left <= 1 || now() >= toolStop
      messages.push(
        { role: "assistant", content: res.content },
        { role: "user", content: `TOOL RESULT (${name}):\n${call.result}\n\n${nextMustAnswer ? "Time to answer: return your final answer now." : `${left} turns left, the answer included.`}` },
      )
      continue
    }

    const checked = input.answer.safeParse(parsed?.answer)
    if (parsed?.kind === "answer" && checked.success) {
      record({ kind: "answer" })
      return done("answered", checked.data, null)
    }
    const why = parsed?.kind !== "answer" ? "a tool call where only the answer was allowed" : checked.error!.issues.slice(0, 5).map((i) => `${i.path.join(".") || "answer"}: ${i.message}`).join("; ")
    record({ kind: "invalid", error: why.slice(0, 600) })
    if (retried) return done("invalid", null, why.slice(0, 600))
    retried = true
    messages.push({ role: "assistant", content: res.content }, { role: "user", content: `Your answer was rejected: ${why}. Return ONLY {"kind":"answer","answer":{...}} matching the schema exactly.` })
  }
  return done("no_answer", null, `out of steps (${limits.steps})`)
}
