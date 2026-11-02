import { STATUS_DETAIL_ID, type AiCallDoc, type EngineStateDoc, type EngineStatusBase } from "@mb/core/db"
import type { BaseEventDataMap } from "@mb/core/events"
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
 * The fields the bot names in `detail` (large, and slow to change) go to their own document
 * instead, once a minute: the database is a small shared one, and rewriting tens of kilobytes every
 * few seconds was most of the bots' traffic to it. For the same reason the counts the beat reads
 * (the latest AI call, errors in the last hour, triggers today) are read once a minute too.
 */

/** How often the `detail` fields are rewritten. */
const DETAIL_MS = 60_000
/** How often the beat reads its counts again. */
const READS_MS = 60_000

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
    /** Holds both documents: `engine` and `STATUS_DETAIL_ID`. */
    engineStatus: { replaceOne(filter: { _id?: unknown }, doc: object, options: { upsert: true }): Promise<unknown> }
  }
  bus: { readonly lastSeq: number; emit(type: "engine.heartbeat", data: HeartbeatData<D>, meta: EmitMeta): unknown }
  calls: { today(): Promise<{ calls: number }> }
  ai: { readonly available: boolean }
  state: { readonly state: EngineStateDoc }
  stream: { readonly clientCount: number }
  wire: { health(extra: { triggers_today: number }): WireStatus }
  /** The news engine's trigger policy: how many triggers fired today. */
  policy: { triggersToday(): Promise<number> }
  instance: string
  version: string
  /** The engine's run status, cycle state and current task, read at each beat. */
  run: () => { status: D["status"]; cycle_state: D["cycle_state"]; current_task: string | null }
  /** The bot's document: the shared parts and its own section, in its field order. */
  doc: (parts: StatusParts<D["status"], D["cycle_state"]>) => D
  /** The document's fields written apart, once a minute, in the `STATUS_DETAIL_ID` document. */
  detail: readonly (keyof D & string)[]
}

export class StatusReporter<D extends Base> {
  private readonly startedAt = new Date()
  private readonly sampler = new ResourceSampler()
  private triggersToday = 0
  private detailAt = 0
  private reads: { at: number; lastAi: AiCallDoc | null; errors: number } = { at: 0, lastAi: null, errors: 0 }

  constructor(private readonly d: StatusReporterDeps<D>) {}

  async write() {
    const { col, bus, calls, stream } = this.d
    const today = await calls.today().catch(() => null)
    if (Date.now() - this.reads.at >= READS_MS) {
      const lastAi = await col.aiCalls.findOne({}, { sort: { at: -1 } }).catch(() => null)
      const errors = await col.events.countDocuments({ level: "error", ts: { $gte: new Date(Date.now() - 3_600_000).toISOString() } }).catch(() => 0)
      this.triggersToday = await this.d.policy.triggersToday().catch(() => this.triggersToday)
      this.reads = { at: Date.now(), lastAi, errors }
    }
    const { lastAi, errors } = this.reads
    const run = this.d.run()
    const parts: StatusParts<D["status"], D["cycle_state"]> = {
      run: { _id: "engine", at: new Date(), instance: this.d.instance, version: this.d.version, started_at: this.startedAt, status: run.status, cycle_state: run.cycle_state, current_task: run.current_task },
      live: { kill_switch: this.d.state.state.kill_switch.engaged, ws_clients: stream.clientCount, event_seq: bus.lastSeq },
      usage: {
        ai: {
          calls_today: today?.calls ?? 0,
          last_call_at: lastAi?.at ?? null,
          last_error: lastAi && !lastAi.ok ? lastAi.error : null,
          enabled: this.d.ai.available,
        },
        system: this.sampler.sample(),
      },
      health: { errors_last_hour: errors, wire: this.d.wire.health({ triggers_today: this.triggersToday }) },
    }
    const doc = this.d.doc(parts)
    const detail = new Set<string>(this.d.detail)
    // The detail first: a new `engine` document never stands without one.
    if (Date.now() - this.detailAt >= DETAIL_MS) {
      const fields = Object.entries(doc).filter(([k, v]) => detail.has(k) && v !== undefined)
      await col.engineStatus.replaceOne({ _id: STATUS_DETAIL_ID }, { _id: STATUS_DETAIL_ID, at: parts.run.at, ...Object.fromEntries(fields) }, { upsert: true })
      this.detailAt = Date.now()
    }
    await col.engineStatus.replaceOne({ _id: "engine" }, Object.fromEntries(Object.entries(doc).filter(([k]) => !detail.has(k))), { upsert: true })
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
