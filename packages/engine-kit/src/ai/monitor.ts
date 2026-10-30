import { randomUUID } from "node:crypto"
import type { EventVisibility, ModelCallKind, ModelEventDataMap, ModelEventType } from "@mb/core/events"
import type { EmitMeta } from "../bus"
import { cleanLine, stripInvisible } from "../util/text"

/**
 * The live model feed: every call an engine makes to the local model (an agent step, an article
 * summary, a research step) reports here, and the dashboards show it as it is written.
 *
 * A call is announced when it starts (`llm.call`) and when it ends (`llm.done`). In between, once a
 * second, one `llm.delta` carries what every running call wrote since the last one: its thinking
 * and its output, new text only. A viewer who connects mid-call gets the text so far
 * (`snapshot`, sent by the stream server after its replay). All of it is ephemeral (seq 0): the
 * finished work is kept where it belongs (the agent's episodes, the wire item's summary).
 *
 * The text is the model's, and quotes untrusted news text: it is sanitized and shown as text, and
 * owner-only unless the bot's `agent.public_thinking` is on (`visibility`).
 */

export type ModelCallStart = { kind: ModelCallKind; label: string; model: string; subject?: string | null; episode_id?: string | null; step?: number | null }

export type ModelCallEnd = { ok: boolean; error?: string | null; prompt_tokens?: number; completion_tokens?: number; tokens_per_s?: number | null }

/** One call's handle: its streamed text, then its end (once; later calls are ignored). */
export type ModelCall = { readonly id: string; thinking(delta: string): void; output(delta: string): void; end(e: ModelCallEnd): void }

/** What the code that calls the model needs: a way to start a call. */
export type ModelCalls = { start(info: ModelCallStart): ModelCall }

/** For code (and tests) with nowhere to report to. */
export const NO_MODEL_CALLS: ModelCalls = {
  start: () => ({ id: "", thinking: () => undefined, output: () => undefined, end: () => undefined }),
}

export type ModelEventSink = { emit<T extends ModelEventType>(type: T, data: ModelEventDataMap[T], meta: EmitMeta): unknown }

/** Text kept per call (the newest), and what a snapshot sends of it. */
const KEEP_CHARS = 60_000
const SNAPSHOT_CHARS = 20_000
const FLUSH_MS = 1_000

type Running = {
  id: string
  start: ModelEventDataMap["llm.call"]
  thinking: string
  output: string
  /** How much of each was sent already. */
  sent: { thinking: number; output: number }
  /** Characters dropped from the front when the text outgrew KEEP_CHARS. */
  dropped: { thinking: number; output: number }
  ended: boolean
}

const tail = (s: string, max: number) => (s.length > max ? s.slice(s.length - max) : s)
/** The model's text as it may be shown: invisible characters out, spacing kept. */
const clean = stripInvisible

export class ModelMonitor implements ModelCalls {
  private readonly running = new Map<string, Running>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly d: {
      bus: ModelEventSink
      /** Who may see the model's text. */
      visibility: () => EventVisibility
      now?: () => number
      flushMs?: number
    },
  ) {}

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  start(info: ModelCallStart): ModelCall {
    const id = randomUUID()
    const start: ModelEventDataMap["llm.call"] = {
      call_id: id,
      kind: info.kind,
      label: cleanLine(info.label, 200),
      model: info.model.replace(/^local\//, ""),
      subject: info.subject ?? null,
      episode_id: info.episode_id ?? null,
      step: info.step ?? null,
      started_at: new Date(this.now()).toISOString(),
    }
    const run: Running = { id, start, thinking: "", output: "", sent: { thinking: 0, output: 0 }, dropped: { thinking: 0, output: 0 }, ended: false }
    this.running.set(id, run)
    this.d.bus.emit("llm.call", start, { summary: `Model: ${start.label}`, level: "debug" })
    this.ensureTimer()
    const append = (key: "thinking" | "output", delta: string) => {
      if (run.ended || !delta) return
      run[key] += delta
      if (run[key].length > KEEP_CHARS) {
        // Keep the newest text; what was cut was sent already, or never will be.
        const cut = run[key].length - KEEP_CHARS
        run[key] = run[key].slice(cut)
        run.dropped[key] += cut
        run.sent[key] = Math.max(0, run.sent[key] - cut)
      }
    }
    return {
      id,
      thinking: (delta) => append("thinking", delta),
      output: (delta) => append("output", delta),
      end: (e) => {
        if (run.ended) return
        this.flush([run])
        run.ended = true
        this.running.delete(id)
        const ms = this.now() - Date.parse(start.started_at)
        this.d.bus.emit(
          "llm.done",
          {
            call_id: id,
            ok: e.ok,
            error: e.error ? cleanLine(e.error, 300) : null,
            ms,
            prompt_tokens: e.prompt_tokens ?? 0,
            completion_tokens: e.completion_tokens ?? 0,
            tokens_per_s: e.tokens_per_s ? Math.round(e.tokens_per_s * 10) / 10 : null,
          },
          { summary: `Model ${e.ok ? "done" : "failed"}: ${start.label}`, level: "debug" },
        )
        if (!this.running.size) this.stopTimer()
      },
    }
  }

  /** The running calls and their text so far, as events for a viewer who just connected. */
  snapshot(): { type: ModelEventType; data: ModelEventDataMap[ModelEventType]; meta: EmitMeta }[] {
    const runs = [...this.running.values()]
    if (!runs.length) return []
    return [
      ...runs.map((r) => ({ type: "llm.call" as const, data: r.start, meta: { summary: `Model: ${r.start.label}`, level: "debug" as const } })),
      {
        type: "llm.delta" as const,
        data: { full: true, calls: runs.map((r) => ({ call_id: r.id, thinking: clean(tail(r.thinking, SNAPSHOT_CHARS)), output: clean(tail(r.output, SNAPSHOT_CHARS)) })) },
        meta: { summary: "Model text so far", level: "debug" as const, visibility: this.d.visibility() },
      },
    ]
  }

  /** Stops the flush timer (shutdown). */
  stop() {
    this.stopTimer()
  }

  private ensureTimer() {
    if (this.timer) return
    this.timer = setInterval(() => this.flush([...this.running.values()]), this.d.flushMs ?? FLUSH_MS)
    this.timer.unref?.()
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One `llm.delta` with each call's new text, if any. */
  private flush(runs: Running[]) {
    const calls = runs.flatMap((r) => {
      const thinking = r.thinking.slice(r.sent.thinking)
      const output = r.output.slice(r.sent.output)
      if (!thinking && !output) return []
      r.sent = { thinking: r.thinking.length, output: r.output.length }
      return [{ call_id: r.id, thinking: clean(thinking), output: clean(output) }]
    })
    if (calls.length) this.d.bus.emit("llm.delta", { full: false, calls }, { summary: "Model text", level: "debug", visibility: this.d.visibility() })
  }
}
