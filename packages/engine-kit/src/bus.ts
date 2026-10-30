import type { EventDoc } from "@mb/core/db"
import { EVENT_SCHEMA_VERSION, type EngineEvent, type EventLevel, type EventVisibility } from "@mb/core/events"
import type { Collection } from "mongodb"
import { errorMessage, type Logger } from "./log"

/**
 * The engine's event bus, for a bot whose event map is `M`: every state change, research step,
 * decision and order event goes through here. It fans out to live WebSocket subscribers
 * synchronously, keeps a ring buffer for instant replay, and persists to MongoDB in small batches
 * (so a slow database never blocks trading).
 *
 * Sequence numbers: seq = max(last + 1, now_ms × 1000). They're strictly increasing within a run
 * and across restarts (the last persisted seq is loaded on boot) without a database round trip
 * per event. Ephemeral events (the bot's `ephemeral` set: tickers, heartbeats) carry seq 0 and are
 * never replayed.
 */

export type EmitMeta = {
  summary: string
  level?: EventLevel
  visibility?: EventVisibility
  instrument?: string
  cycle_id?: string
}

type Listener<M> = (event: EngineEvent<M>) => void

const RING_SIZE = 3_000
const FLUSH_MS = 250
const MAX_QUEUE = 20_000
const INITIAL_REPLAY = 150

export class EventBus<M> {
  private last = 0
  private ring: EngineEvent<M>[] = []
  private queue: EngineEvent<M>[] = []
  private listeners = new Set<Listener<M>>()
  private timer: NodeJS.Timeout | null = null
  private flushing: Promise<void> | null = null

  constructor(
    private readonly col: { events: Collection<EventDoc<EngineEvent<M>>> },
    private readonly log: Logger,
    private readonly retentionDays: number,
    private readonly ephemeral: ReadonlySet<keyof M>,
    private readonly clock: () => number = Date.now,
  ) {}

  async init() {
    const latest = await this.col.events.find({}, { projection: { _id: 1 } }).sort({ _id: -1 }).limit(1).next()
    this.last = latest?._id ?? 0
    const recent = await this.col.events.find({}).sort({ _id: -1 }).limit(INITIAL_REPLAY).toArray()
    this.ring = recent.reverse().map(({ _id, expires_at, ...event }) => event as EngineEvent<M>)
    this.timer = setInterval(() => void this.flush(), FLUSH_MS)
    this.timer.unref?.()
  }

  get lastSeq() {
    return this.last
  }

  /** An event in the bus's envelope without emitting it (seq 0 unless given): what the stream sends a viewer who just connected. */
  envelope<T extends keyof M>(type: T, data: M[T], meta: EmitMeta, seq = 0): EngineEvent<M, T> {
    return {
      v: EVENT_SCHEMA_VERSION,
      seq,
      ts: new Date(this.clock()).toISOString(),
      type,
      level: meta.level ?? "info",
      visibility: meta.visibility ?? "public",
      summary: meta.summary.slice(0, 300),
      ...(meta.instrument ? { instrument: meta.instrument } : {}),
      ...(meta.cycle_id ? { cycle_id: meta.cycle_id } : {}),
      data,
    }
  }

  emit<T extends keyof M>(type: T, data: M[T], meta: EmitMeta): EngineEvent<M, T> {
    const ephemeral = this.ephemeral.has(type)
    const seq = ephemeral ? 0 : Math.max(this.last + 1, this.clock() * 1000)
    if (!ephemeral) this.last = seq
    const event = this.envelope(type, data, meta, seq)
    if (!ephemeral) {
      this.ring.push(event)
      if (this.ring.length > RING_SIZE) this.ring.splice(0, this.ring.length - RING_SIZE)
      this.queue.push(event)
      if (this.queue.length > MAX_QUEUE) {
        const dropped = this.queue.splice(0, this.queue.length - MAX_QUEUE)
        this.log.warn("event queue overflow; dropped oldest unpersisted events", { dropped: dropped.length })
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.log.warn("event listener failed", { error: errorMessage(error), type })
      }
    }
    return event
  }

  subscribe(listener: Listener<M>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Events after `since`, oldest first. Without `since`, the most recent events (initial history
   * for a fresh client). `truncated` means the gap was larger than `limit`: the client should
   * reload its page data instead of trusting the replay to be complete.
   */
  async replay(since: number | undefined, limit = 1_000): Promise<{ events: EngineEvent<M>[]; truncated: boolean }> {
    if (since === undefined) return { events: this.ring.slice(-INITIAL_REPLAY), truncated: false }
    if (since >= this.last) return { events: [], truncated: false }
    const oldest = this.ring[0]?.seq
    if (oldest !== undefined && since >= oldest - 1) {
      const events = this.ring.filter((e) => e.seq > since)
      return { events: events.slice(-limit), truncated: events.length > limit }
    }
    try {
      const docs = await this.col.events.find({ _id: { $gt: since } }).sort({ _id: 1 }).limit(limit).toArray()
      const fromDb = docs.map(({ _id, expires_at, ...event }) => event as EngineEvent<M>)
      const lastDb = fromDb[fromDb.length - 1]?.seq ?? since
      const truncated = docs.length >= limit
      const tail = truncated ? [] : this.ring.filter((e) => e.seq > lastDb)
      return { events: [...fromDb, ...tail], truncated }
    } catch (error) {
      this.log.warn("replay from database failed; serving memory only", { error: errorMessage(error) })
      return { events: this.ring.filter((e) => e.seq > since), truncated: true }
    }
  }

  /** Persists queued events. Safe to call concurrently; failures keep the events for the next try. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing
    if (this.queue.length === 0) return Promise.resolve()
    const batch = this.queue.splice(0, 500)
    const expiresAt = (e: EngineEvent<M>) => new Date(Date.parse(e.ts) + this.retentionDays * 86_400_000)
    this.flushing = this.col.events
      .insertMany(batch.map((e) => ({ ...e, _id: e.seq, expires_at: expiresAt(e) })), { ordered: false })
      .then(() => undefined)
      .catch((error: { code?: number; writeErrors?: { code?: number }[] }) => {
        // Duplicate keys mean a previous attempt already stored them.
        const onlyDuplicates = error.code === 11000 || (error.writeErrors?.length && error.writeErrors.every((w) => w.code === 11000))
        if (!onlyDuplicates) {
          this.queue.unshift(...batch)
          this.log.warn("persisting events failed; will retry", { error: errorMessage(error), queued: this.queue.length })
        }
      })
      .finally(() => {
        this.flushing = null
      })
    return this.flushing
  }

  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (let i = 0; i < 5 && this.queue.length; i++) await this.flush()
  }
}
