import type { EngineStateDoc } from "@mb/core/db"
import type { EventFocus, WireTriggerDoc } from "@mb/core/wire"
import type { Collection } from "mongodb"
import type { Logger } from "../log"

/**
 * News-engine event cycles waiting to run. A trigger asks for a focused cycle; it starts at once
 * when nothing is running, trading is on and the minimum gap since the last event cycle has
 * passed. Otherwise it waits, merged by symbol ("MARKET" for market-wide, highest severity kept,
 * every item id kept), and runs the moment it can: when the gap timer fires, or when the engine
 * drains the queue again after its current cycle ends.
 *
 * What differs between the bots is injected:
 *   - `expireAfterMs`: how long a trigger may wait before it is dropped unrun (stock: 30 minutes),
 *     or null to keep it until it can run (crypto, until MARKETBOTS_PLAN 9.1).
 *   - `gate`: an extra condition for running one now (stock: the session's event window).
 */

const MIN = 60_000

/** A trigger waiting for its event cycle, and since when (ms). */
export type QueuedEvent = EventFocus & { queued_at: number }

export type EventCycleQueueOptions = {
  col: { wireTriggers: Collection<WireTriggerDoc> }
  log: Logger
  state: { readonly state: EngineStateDoc }
  settings: { readonly current: { wire: { event_min_gap_seconds: number } } }
  /** Whether a cycle is running. The queue then waits; the engine drains it again when the cycle ends. */
  busy: () => boolean
  /** Starts the event cycle for these triggers; `trigger` describes them, e.g. "event: held negative AAPL". */
  start: (events: QueuedEvent[], trigger: string) => void
  /** Triggers that waited longer than this are dropped unrun; null keeps them until they can run. */
  expireAfterMs: number | null
  /** An extra condition for running one now. Without it, the queue runs whenever trading does. */
  gate?: () => boolean
}

export class EventCycleQueue {
  private readonly queue = new Map<string, QueuedEvent>()
  private lastStartedAt = 0
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly o: EventCycleQueueOptions) {}

  get size() {
    return this.queue.size
  }

  get(key: string) {
    return this.queue.get(key)
  }

  /** What waits, by symbol ("MARKET" for market-wide), for the heartbeat. */
  keys() {
    return [...this.queue.keys()]
  }

  /** Queues a trigger's cycle, merged by symbol, and starts it if it can run now. */
  request(focus: EventFocus): "fired" | "queued" {
    const key = focus.symbol ?? "MARKET"
    const prev = this.queue.get(key)
    if (!prev || focus.severity >= prev.severity) {
      this.queue.set(key, { ...focus, item_ids: [...new Set([...(prev?.item_ids ?? []), ...focus.item_ids])], queued_at: prev?.queued_at ?? Date.now() })
    } else {
      prev.item_ids = [...new Set([...prev.item_ids, ...focus.item_ids])]
    }
    return this.drain() ? "fired" : "queued"
  }

  /** Starts the queued event cycle if it can run now. Returns whether one started. */
  drain(): boolean {
    this.expire()
    if (this.o.busy() || !this.queue.size) return false
    const st = this.o.state.state
    if (st.status !== "running" || st.kill_switch.engaged) return false
    if (this.o.gate && !this.o.gate()) return false
    const wait = this.lastStartedAt + this.o.settings.current.wire.event_min_gap_seconds * 1000 - Date.now()
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.drain()
        }, wait)
        this.timer.unref()
      }
      return false
    }
    const events = [...this.queue.values()]
    this.queue.clear()
    this.lastStartedAt = Date.now()
    const label = events.map((e) => `${e.rule.replace(/_/g, " ")} ${e.symbol ?? "market"}`).join(", ")
    this.o.start(events, `event: ${label}`)
    return true
  }

  /** Drops triggers that waited too long (say, queued just before the bell): stale news never starts a cycle. */
  expire(now = Date.now()) {
    const max = this.o.expireAfterMs
    if (max === null) return
    for (const [key, e] of this.queue) {
      if (now - e.queued_at <= max) continue
      this.queue.delete(key)
      const reason = `expired: waited ${Math.round((now - e.queued_at) / MIN)} min in the queue`
      void this.o.col.wireTriggers.updateOne({ _id: e.trigger_id }, { $set: { status: "suppressed", reason } }).catch(() => undefined)
      this.o.log.info("event trigger expired", { symbol: e.symbol, rule: e.rule, reason })
    }
  }

  /** Event-cycle latency: which cycle served each trigger, and how long it waited. */
  async served(events: QueuedEvent[], cycleId: string, startedAt: number) {
    for (const e of events) {
      await this.o.col.wireTriggers.updateOne({ _id: e.trigger_id }, { $set: { cycle_id: cycleId, queue_wait_ms: startedAt - e.queued_at } }).catch(() => undefined)
    }
  }

  /** Cancels the gap timer (shutdown). */
  stop() {
    if (this.timer) clearTimeout(this.timer)
  }
}
