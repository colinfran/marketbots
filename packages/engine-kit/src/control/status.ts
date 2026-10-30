import type { AiCallDoc, EngineStateDoc, EngineStatusBase } from "@mb/core/db"
import type { BaseEventDataMap } from "@mb/core/events"
import type { AiSettingsBase } from "@mb/core/settings"
import type { WireStatus } from "@mb/core/wire"
import type { Collection } from "mongodb"
import type { EmitMeta } from "../bus"
import { ResourceSampler } from "../heartbeat"

/**
 * The heartbeat: the engine's observed state, written to `engine_status` every few seconds (the
 * dashboard's Admin page and status pill read it), with a short `engine.heartbeat` streamed on
 * every third beat.
 *
 * The reporter gathers the fields both bots write. The bot's `doc` places them, with its own
 * section (venue or broker health, market, schedule, last cycle…), in its document's field order.
 */

type Base = EngineStatusBase<string, string>

/** The shared fields, in four groups the bot spreads into its document. */
export type StatusParts<S extends string, C extends string> = {
  /** `_id` … `current_task`: who runs, since when, and what it is doing. */
  run: Pick<EngineStatusBase<S, C>, "_id" | "at" | "instance" | "version" | "started_at" | "status" | "cycle_state" | "current_task">
  /** `kill_switch`, `ws_clients`, `event_seq`. */
  live: Pick<EngineStatusBase<S, C>, "kill_switch" | "ws_clients" | "event_seq">
  /** `ai`, `system`: AI calls and process resources. */
  usage: Pick<EngineStatusBase<S, C>, "ai" | "system">
  /** `errors_last_hour`, `wire`. */
  health: { errors_last_hour: number; wire: WireStatus }
}

type HeartbeatData<D extends Base> = BaseEventDataMap<string, D["status"], D["cycle_state"]>["engine.heartbeat"]

export type StatusReporterDeps<D extends Base> = {
  col: {
    aiCalls: Collection<AiCallDoc>
    events: { countDocuments(filter: { level: "error"; ts: { $gte: string } }): Promise<number> }
    engineStatus: { replaceOne(filter: { _id: "engine" }, doc: D, options: { upsert: true }): Promise<unknown> }
  }
  bus: { readonly lastSeq: number; emit(type: "engine.heartbeat", data: HeartbeatData<D>, meta: EmitMeta): unknown }
  calls: { today(): Promise<{ calls: number }> }
  settings: { readonly current: { ai: { models: AiSettingsBase["models"] } } }
  ai: { readonly available: boolean }
  state: { readonly state: EngineStateDoc }
  stream: { readonly clientCount: number }
  wire: { health(extra: { triggers_today: number; event_queue: string[] }): WireStatus }
  /** The news engine's trigger policy: how many triggers fired today. */
  policy: { triggersToday(): Promise<number> }
  instance: string
  version: string
  /** The engine's run status, cycle state and current task, read at each beat. */
  run: () => { status: D["status"]; cycle_state: D["cycle_state"]; current_task: string | null }
  /** Triggers waiting for an event cycle (none where the agent takes them). */
  eventQueue?: () => string[]
  /** The bot's document: the shared parts and its own section, in its field order. */
  doc: (parts: StatusParts<D["status"], D["cycle_state"]>) => D
}

export class StatusReporter<D extends Base> {
  private readonly startedAt = new Date()
  private readonly sampler = new ResourceSampler()
  private triggersToday = 0

  constructor(private readonly d: StatusReporterDeps<D>) {}

  async write() {
    const { col, bus, calls, settings, stream } = this.d
    const today = await calls.today().catch(() => null)
    const lastAi = await col.aiCalls.findOne({}, { sort: { at: -1 } }).catch(() => null)
    const errors = await col.events.countDocuments({ level: "error", ts: { $gte: new Date(Date.now() - 3_600_000).toISOString() } }).catch(() => 0)
    this.triggersToday = await this.d.policy.triggersToday().catch(() => this.triggersToday)
    const s = settings.current
    const run = this.d.run()
    const parts: StatusParts<D["status"], D["cycle_state"]> = {
      run: { _id: "engine", at: new Date(), instance: this.d.instance, version: this.d.version, started_at: this.startedAt, status: run.status, cycle_state: run.cycle_state, current_task: run.current_task },
      live: { kill_switch: this.d.state.state.kill_switch.engaged, ws_clients: stream.clientCount, event_seq: bus.lastSeq },
      usage: {
        ai: {
          models: s.ai.models,
          calls_today: today?.calls ?? 0,
          last_call_at: lastAi?.at ?? null,
          last_error: lastAi && !lastAi.ok ? lastAi.error : null,
          enabled: this.d.ai.available,
        },
        system: this.sampler.sample(),
      },
      health: { errors_last_hour: errors, wire: this.d.wire.health({ triggers_today: this.triggersToday, event_queue: this.d.eventQueue?.() ?? [] }) },
    }
    await col.engineStatus.replaceOne({ _id: "engine" }, this.d.doc(parts), { upsert: true })
    if (Math.floor(Date.now() / 5_000) % 3 === 0) {
      const now = this.d.run()
      bus.emit(
        "engine.heartbeat",
        { status: now.status, cycle_state: now.cycle_state, ws_clients: stream.clientCount, uptime_s: parts.usage.system.uptime_s, ai_calls_today: parts.usage.ai.calls_today },
        { summary: `Engine ${now.status}, ${now.cycle_state}`, level: "debug" },
      )
    }
  }
}
