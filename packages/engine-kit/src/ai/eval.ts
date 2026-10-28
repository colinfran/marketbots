/**
 * The local-model eval (docs/plans/LOCAL-AI.md §10 and §14, step 0): replays recorded decision
 * prompts against a llama.cpp server (OpenAI-compatible) and records, for each answer, whether it
 * parsed, how long it took and what the server measured. The server turns the JSON schema into a
 * grammar, so a well-behaved model can only write valid JSON; whether it still thinks first is
 * part of what this measures. Scoring against the recorded answer is each bot's own (its schema
 * and normalization). Run from each engine's src/eval/cli.ts, never by the engines themselves.
 */

export type ThinkingLevel = "off" | "low" | "medium" | "high"

/** How each model family switches its thinking (llama.cpp passes these to the chat template). */
export type ModelFamily = "gpt-oss" | "qwen" | "gemma" | "other"

export type EvalModel = { url: string; name: string; family: ModelFamily; thinking: ThinkingLevel }

export type EvalItem = { id: string; system: string; prompt: string; schema: Record<string, unknown> }

export type CallResult = {
  ok: boolean
  error: string | null
  content: string
  reasoning: string
  json: unknown
  wall_ms: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  prompt_ms: number
  prompt_per_s: number
  gen_ms: number
  gen_per_s: number
  finish_reason: string | null
}

type Message = { role: "system" | "user" | "assistant"; content: string }

export const templateKwargs = (family: ModelFamily, thinking: ThinkingLevel): Record<string, unknown> => {
  if (family === "gpt-oss") return { reasoning_effort: thinking === "off" ? "low" : thinking }
  if (family === "qwen" || family === "gemma") return { enable_thinking: thinking !== "off" }
  return {}
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** One chat completion constrained by `schema`. Never throws: failures come back with ok false. */
export const complete = async (
  model: EvalModel,
  messages: Message[],
  schema: Record<string, unknown>,
  { temperature = 0.3, maxTokens = 16_000, timeoutMs = 600_000 }: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<CallResult> => {
  const started = Date.now()
  const failed = (error: string): CallResult => ({
    ok: false,
    error,
    content: "",
    reasoning: "",
    json: undefined,
    wall_ms: Date.now() - started,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    prompt_ms: 0,
    prompt_per_s: 0,
    gen_ms: 0,
    gen_per_s: 0,
    finish_reason: null,
  })
  try {
    const res = await fetch(`${model.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.name,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } },
        chat_template_kwargs: templateKwargs(model.family, model.thinking),
        // llama.cpp's own switch: "none" turns thinking off, any other value reaches the template.
        reasoning_effort: model.thinking === "off" ? (model.family === "gpt-oss" ? "low" : "none") : model.thinking,
        cache_prompt: true,
        // Streamed: a long answer would otherwise send nothing for minutes, and fetch gives up
        // waiting for the response headers after 300 s.
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok || !res.body) return failed(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    type Chunk = {
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
      timings?: { cache_n?: number; prompt_ms?: number; prompt_per_second?: number; predicted_ms?: number; predicted_per_second?: number }
    }
    let content = ""
    let reasoning = ""
    let finish: string | null = null
    let usage: Chunk["usage"]
    let timings: Chunk["timings"]
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const bytes of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        const data = line.startsWith("data: ") ? line.slice(6).trim() : ""
        if (!data || data === "[DONE]") continue
        const chunk = parse(data) as Chunk | undefined
        const choice = chunk?.choices?.[0]
        content += choice?.delta?.content ?? ""
        reasoning += choice?.delta?.reasoning_content ?? ""
        finish = choice?.finish_reason ?? finish
        usage = chunk?.usage ?? usage
        timings = chunk?.timings ?? timings
      }
    }
    const json = parse(content)
    return {
      ok: json !== undefined,
      error: json === undefined ? `answer is not JSON (finish: ${finish ?? "?"})` : null,
      content,
      reasoning,
      json,
      wall_ms: Date.now() - started,
      prompt_tokens: num(usage?.prompt_tokens),
      completion_tokens: num(usage?.completion_tokens),
      cached_tokens: num(timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens),
      prompt_ms: num(timings?.prompt_ms),
      prompt_per_s: num(timings?.prompt_per_second),
      gen_ms: num(timings?.predicted_ms),
      gen_per_s: num(timings?.predicted_per_second),
      finish_reason: finish,
    }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}

export type EpisodeTool = {
  name: string
  description: string
  /** Canned output for the scripted loop: the eval measures latency, not the tools. */
  result: (args: unknown) => string
}

export type EpisodeStep = { kind: "tool" | "answer" | "invalid"; tool: string | null; purpose: string | null; call: CallResult }

export type EpisodeResult = { steps: EpisodeStep[]; answered: boolean; answer: unknown; wall_ms: number }

/**
 * A scripted agent episode (§8.2): every step is one JSON object, either a tool call with a short
 * purpose or the final answer in the bot's decision schema. Tool results are canned. The first
 * `minTools` steps may only call a tool (to time a real loop); after `maxTools` calls, the step
 * schema allows only the answer. Earlier steps stay in the prompt
 * unchanged, so the server's prompt cache only has to read each new part.
 */
export const runEpisode = async (
  model: EvalModel,
  { system, brief, tools, answerSchema, minTools = 0, maxTools = 5, timeoutMs = 600_000 }: { system: string; brief: string; tools: EpisodeTool[]; answerSchema: Record<string, unknown>; minTools?: number; maxTools?: number; timeoutMs?: number },
): Promise<EpisodeResult> => {
  const started = Date.now()
  const toolStep = {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["tool"] },
      purpose: { type: "string", description: "At most 25 words: what this call is for." },
      tool: { type: "string", enum: tools.map((t) => t.name) },
      args: { type: "object" },
    },
    required: ["kind", "purpose", "tool", "args"],
    additionalProperties: false,
  }
  const answerStep = {
    type: "object",
    properties: { kind: { type: "string", enum: ["answer"] }, answer: answerSchema },
    required: ["kind", "answer"],
    additionalProperties: false,
  }
  const toolList = tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")
  const messages: Message[] = [
    {
      role: "system",
      content: `${system}\n\nTOOLS\nYou may look things up before you answer. Each turn, return ONE JSON object: either {"kind":"tool","purpose":"...","tool":"<name>","args":{...}} to call a tool, or {"kind":"answer","answer":{...}} with your final answer. At most ${maxTools} tool calls.\n${toolList}`,
    },
    { role: "user", content: brief },
  ]
  const steps: EpisodeStep[] = []
  for (let i = 0; i <= maxTools; i++) {
    const last = i === maxTools
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) break
    const call = await complete(model, messages, last ? answerStep : i < minTools ? toolStep : { anyOf: [toolStep, answerStep] }, { timeoutMs: remaining })
    const step = call.json as { kind?: string; tool?: string; purpose?: string; args?: unknown; answer?: unknown } | undefined
    if (!call.ok || !step || (step.kind !== "tool" && step.kind !== "answer")) {
      steps.push({ kind: "invalid", tool: null, purpose: null, call })
      return { steps, answered: false, answer: null, wall_ms: Date.now() - started }
    }
    if (step.kind === "answer") {
      steps.push({ kind: "answer", tool: null, purpose: null, call })
      return { steps, answered: true, answer: step.answer, wall_ms: Date.now() - started }
    }
    const tool = tools.find((t) => t.name === step.tool)
    steps.push({ kind: "tool", tool: step.tool ?? null, purpose: step.purpose ?? null, call })
    messages.push({ role: "assistant", content: call.content })
    messages.push({ role: "user", content: `TOOL RESULT (${step.tool}):\n${tool ? tool.result(step.args) : "unknown tool"}` })
  }
  return { steps, answered: false, answer: null, wall_ms: Date.now() - started }
}

/** Percentile of a list of numbers (nearest rank); 0 for an empty list. */
export const percentile = (values: number[], p: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
