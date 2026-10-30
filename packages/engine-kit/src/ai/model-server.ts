import type { ModelSlot } from "@mb/core/events"
import type { ModelEventSink } from "./monitor"

/**
 * The model server's slots (llama.cpp's `GET /slots`), read every second and streamed as
 * `llm.status`: which slots are working, on how long a prompt, and how much they have written. The
 * server is shared by both bots and the news summaries, so each engine shows all of it. Only while
 * a viewer could see it: `wanted` (someone is connected to the stream).
 */

const INTERVAL_MS = 1_000
const TIMEOUT_MS = 2_000

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0)

/** `/slots`' answer as the dashboard reads it. */
export const readSlots = (body: unknown): ModelSlot[] =>
  (Array.isArray(body) ? body.filter(isObject) : []).map((s) => {
    const next = Array.isArray(s.next_token) ? s.next_token.find(isObject) : undefined
    return {
      id: int(s.id),
      busy: s.is_processing === true,
      prompt_tokens: int(s.n_prompt_tokens),
      prompt_done: int(s.n_prompt_tokens_processed),
      decoded: next ? int(next.n_decoded) : 0,
      n_ctx: int(s.n_ctx),
    }
  })

export class ModelServerStatus {
  private timer: NodeJS.Timeout | null = null
  private polling = false
  /** The latest reading, for a viewer who just connected. */
  latest: { ok: boolean; error: string | null; slots: ModelSlot[] } | null = null

  constructor(
    private readonly d: {
      url: string
      bus: ModelEventSink
      /** Whether anyone would see it (viewers on the stream). */
      wanted: () => boolean
      intervalMs?: number
    },
  ) {}

  start() {
    this.timer = setInterval(() => void this.poll(), this.d.intervalMs ?? INTERVAL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One read. */
  async poll() {
    if (this.polling || !this.d.wanted()) return
    this.polling = true
    try {
      let data: { ok: boolean; error: string | null; slots: ModelSlot[] }
      try {
        const res = await fetch(`${this.d.url.replace(/\/+$/, "")}/slots`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
        data = res.ok ? { ok: true, error: null, slots: readSlots(await res.json()) } : { ok: false, error: `the model server answered ${res.status}`, slots: [] }
      } catch (error) {
        data = { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "unreachable", slots: [] }
      }
      this.latest = data
      this.d.bus.emit("llm.status", data, { summary: data.ok ? `Model server: ${data.slots.filter((s) => s.busy).length} of ${data.slots.length} slots busy` : `Model server: ${data.error}`, level: "debug" })
    } finally {
      this.polling = false
    }
  }
}
