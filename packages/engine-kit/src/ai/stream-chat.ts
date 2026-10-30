/**
 * One chat completion on the local model server (llama.cpp's OpenAI-compatible API), streamed:
 * its thinking (`reasoning_content`) and its answer arrive piece by piece, and each piece goes to
 * the caller as it comes, for the live model feed (./monitor). A server that answers with a plain
 * JSON completion instead (a test's fake, an old server) is read the same way.
 *
 * Throws when the server can't be reached, answers with an error, or the time runs out.
 */

export type StreamedReply = {
  content: string
  reasoning: string
  prompt_tokens: number
  completion_tokens: number
  /** The server's own generation speed, tokens/s (null if it sent none). */
  per_second: number | null
  finish: string | null
}

export type StreamChatOptions = {
  timeoutMs: number
  signal?: AbortSignal
  onReasoning?: (delta: string) => void
  onContent?: (delta: string) => void
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Posts `body` (model, messages, sampling…) to `<base>/v1/chat/completions` with streaming on. */
export const streamChat = async (base: string, body: Json, o: StreamChatOptions): Promise<StreamedReply> => {
  const timeout = AbortSignal.timeout(Math.max(1, o.timeoutMs))
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  const out: StreamedReply = { content: "", reasoning: "", prompt_tokens: 0, completion_tokens: 0, per_second: null, finish: null }
  const take = (chunk: unknown) => {
    if (!isObject(chunk)) return
    const choice = Array.isArray(chunk.choices) ? chunk.choices.find(isObject) : undefined
    // A stream sends `delta`s; a plain completion one `message`.
    const piece = choice && (isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : null)
    const reasoning = piece ? str(piece.reasoning_content) : ""
    const content = piece ? str(piece.content) : ""
    if (reasoning) {
      out.reasoning += reasoning
      o.onReasoning?.(reasoning)
    }
    if (content) {
      out.content += content
      o.onContent?.(content)
    }
    if (choice && typeof choice.finish_reason === "string") out.finish = choice.finish_reason
    const usage = isObject(chunk.usage) ? chunk.usage : null
    if (usage) {
      out.prompt_tokens = num(usage.prompt_tokens) ?? out.prompt_tokens
      out.completion_tokens = num(usage.completion_tokens) ?? out.completion_tokens
    }
    const timings = isObject(chunk.timings) ? chunk.timings : null
    if (timings) out.per_second = num(timings.predicted_per_second) ?? out.per_second
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream, application/json" },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal,
    })
    if (!res.ok) throw new Error(`the local model server answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      take(parse(await res.text()))
      return out
    }
    if (!res.body) throw new Error("the local model server sent no body")
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const bytes of res.body as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        const data = line.startsWith("data: ") ? line.slice(6).trim() : ""
        if (data && data !== "[DONE]") take(parse(data))
      }
    }
    return out
  } catch (error) {
    if (timeout.aborted && !o.signal?.aborted) throw new Error(`the local model timed out after ${Math.round(o.timeoutMs / 1000)} s`)
    throw error
  }
}
