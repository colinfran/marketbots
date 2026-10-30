import type { EngineEvent, EventVisibility, ModelEventDataMap, ModelEventType } from "@mb/core/events"
import type { EmitMeta } from "../bus"
import { ModelServerStatus } from "./model-server"
import { ModelMonitor, type ModelEventSink } from "./monitor"

/**
 * The live model feed, wired for an engine: the monitor every model call reports to (./monitor),
 * the model server's slots every second while someone watches (./model-server), and what a viewer
 * who just connected is sent after the stream's replay: the calls running now with their text so
 * far, and the latest slots.
 */
export const startModelFeed = <M extends ModelEventDataMap>(d: {
  bus: ModelEventSink & { envelope<T extends keyof M>(type: T, data: M[T], meta: EmitMeta): EngineEvent<M, T> }
  stream: { readonly clientCount: number; setSnapshot(fn: () => EngineEvent<M>[]): void }
  /** The model server (LLM_URL); without it there are no calls and no slots. */
  llmUrl: string | null | undefined
  /** Who may see the model's text: owner-only unless the bot's agent.public_thinking. */
  visibility: () => EventVisibility
}) => {
  const models = new ModelMonitor({ bus: d.bus, visibility: d.visibility })
  const server = d.llmUrl ? new ModelServerStatus({ url: d.llmUrl, bus: d.bus, wanted: () => d.stream.clientCount > 0 }) : null
  server?.start()
  d.stream.setSnapshot(() => {
    const events: { type: ModelEventType; data: ModelEventDataMap[ModelEventType]; meta: EmitMeta }[] = [...models.snapshot()]
    if (server?.latest) events.push({ type: "llm.status", data: server.latest, meta: { summary: "Model server", level: "debug" } })
    return events.map((e) => d.bus.envelope(e.type, e.data as M[ModelEventType], e.meta))
  })
  return {
    models,
    stop: () => {
      models.stop()
      server?.stop()
    },
  }
}
