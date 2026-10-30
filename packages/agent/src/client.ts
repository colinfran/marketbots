import { LOCAL_PREFIX } from "@mb/engine-kit/ai/models"

/**
 * The agent's model client: one chat completion on the local model server (llama.cpp's
 * OpenAI-compatible API, LLM_URL, docs/SERVER.md §9), constrained by a JSON schema that the server
 * turns into a grammar, so a step's answer is valid JSON by construction. The model thinks first
 * (when the step allows it), and its thinking streams back separately from the answer; the server
 * caches each slot's prompt, so a step only reads what is new since the last one.
 *
 * Streamed: a long answer would otherwise send nothing for minutes. Never throws: failures come back with `ok` false.
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string }

export type ChatRequest = {
  /** "local/<alias>", as in settings. */
  model: string
  messages: ChatMessage[]
  schema: Record<string, unknown>
  temperature: number
  /** 0 = no thinking; otherwise the server's cap on this step's thinking. */
  thinkingTokens: number
  maxTokens: number
  timeoutMs: number
  signal?: AbortSignal
  /** Each piece of thinking as it streams. */
  onReasoning?: (delta: string) => void
  /** Each piece of the answer (the step's JSON) as it streams. */
  onContent?: (delta: string) => void
}

export type ChatResult = {
  ok: boolean
  error: string | null
  /** True when the call was aborted or ran out of time (not a model or server failure). */
  aborted: boolean
  content: string
  reasoning: string
  json: unknown
  wall_ms: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  gen_per_s: number
  finish_reason: string | null
}

export type ChatFn = (request: ChatRequest) => Promise<ChatResult>

type Chunk = {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  timings?: { cache_n?: number; predicted_per_second?: number }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A chat function bound to the model server at `url`. */
export const llamaChat =
  (url: string, fetchFn: typeof fetch = (...args) => fetch(...args)): ChatFn =>
  async (r) => {
    const started = Date.now()
    const timeout = AbortSignal.timeout(Math.max(1, r.timeoutMs))
    const signal = r.signal ? AbortSignal.any([r.signal, timeout]) : timeout
    const result = (fields: Partial<ChatResult>): ChatResult => ({
      ok: false,
      error: null,
      aborted: false,
      content: "",
      reasoning: "",
      json: undefined,
      wall_ms: Date.now() - started,
      prompt_tokens: 0,
      completion_tokens: 0,
      cached_tokens: 0,
      gen_per_s: 0,
      finish_reason: null,
      ...fields,
    })
    const thinking = r.thinkingTokens > 0
    let content = ""
    let reasoning = ""
    try {
      const res = await fetchFn(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: r.model.startsWith(LOCAL_PREFIX) ? r.model.slice(LOCAL_PREFIX.length) : r.model,
          messages: r.messages,
          temperature: r.temperature,
          max_tokens: r.maxTokens,
          response_format: { type: "json_schema", json_schema: { name: "step", schema: r.schema, strict: true } },
          // Qwen's thinking switch and the server's cap on it; "none" is
          // llama.cpp's own switch for no thinking at all.
          chat_template_kwargs: { enable_thinking: thinking },
          ...(thinking ? { thinking_budget_tokens: r.thinkingTokens } : { reasoning_effort: "none" }),
          cache_prompt: true,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      })
      if (!res.ok || !res.body) return result({ error: `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}` })
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
          const piece = choice?.delta?.content ?? ""
          if (piece) {
            content += piece
            r.onContent?.(piece)
          }
          const delta = choice?.delta?.reasoning_content ?? ""
          if (delta) {
            reasoning += delta
            r.onReasoning?.(delta)
          }
          finish = choice?.finish_reason ?? finish
          usage = chunk?.usage ?? usage
          timings = chunk?.timings ?? timings
        }
      }
      const json = parse(content)
      return result({
        ok: json !== undefined,
        error: json === undefined ? `the answer is not JSON (finish: ${finish ?? "?"})` : null,
        content,
        reasoning,
        json,
        prompt_tokens: num(usage?.prompt_tokens),
        completion_tokens: num(usage?.completion_tokens),
        cached_tokens: num(timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens),
        gen_per_s: num(timings?.predicted_per_second),
        finish_reason: finish,
      })
    } catch (error) {
      const aborted = signal.aborted
      const message = aborted ? (r.signal?.aborted ? "aborted" : `timed out after ${Math.round(r.timeoutMs / 1000)} s`) : error instanceof Error ? error.message : String(error)
      return result({ error: message, aborted, content, reasoning })
    }
  }
