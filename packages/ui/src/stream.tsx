"use client"

import type { EngineEvent, ModelCallKind, ModelEventDataMap, ModelSlot } from "@mb/core/events"
import { eventEnvelopeSchema } from "@mb/core/events"
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react"

/**
 * The browser's connection to an engine's live event stream.
 *
 * Connection: fetch a 60s token from /api/stream-token → open the WebSocket → send the token as
 * the first frame, with the last seq seen so the engine replays anything missed. Reconnects
 * with exponential backoff + jitter (a fresh token each time), and treats 45s of silence as a
 * dead connection (the engine pings every 15s). The dashboard works without it: pages are
 * server-rendered from MongoDB, and the stream only makes them live.
 *
 * Generic over the bot's events. The bot passes how many events to keep and how to read its
 * `market.ticker` payload (the event has a different shape in each bot).
 */

/** Any bot's event, as the shared components read it. */
export type AnyEvent = EngineEvent<Record<string, unknown>>

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline" | "unconfigured"
export type Ticker = { bid: number | null; ask: number | null; last: number; change_pct: number | null; at: number }

/** A bot's `market.ticker` payload, read into a symbol and its quote. */
export type MapTicker = (data: unknown) => { symbol: string; bid: number | null; ask: number | null; last: number; change_pct: number | null }

export type StreamConfig = { maxEvents: number; mapTicker: MapTicker }

/** Engine run status and cycle state as the stream last reported them. */
export type StreamEngine = { status: string; cycle_state: string | null; at: number }

/** A model call as the live model feed shows it: what it is for, what it has written, how it ended. */
export type ModelCallView = {
  id: string
  kind: ModelCallKind
  label: string
  model: string
  subject: string | null
  episode_id: string | null
  step: number | null
  started_at: number
  thinking: string
  output: string
  done: (Omit<ModelEventDataMap["llm.done"], "call_id"> & { at: number }) | null
}

/** The model server's slots, as last read. */
export type ModelServerView = { ok: boolean; error: string | null; slots: ModelSlot[]; at: number }

/** The live model feed: the calls running now and the last ones that ended (newest first), and the model server. */
export type ModelFeed = { calls: ModelCallView[]; server: ModelServerView | null }

export type StreamSnapshot<E extends AnyEvent = AnyEvent> = {
  status: StreamStatus
  scope: "public" | "owner" | null
  lastEventAt: number | null
  events: E[]
  tickers: Record<string, Ticker>
  engine: StreamEngine | null
  /** Bumped when the replay couldn't cover a gap, so pages refetch server data. */
  gapCount: number
  models: ModelFeed
}

const SILENCE_MS = 45_000
/** Finished model calls kept for the feed, besides the running ones. */
const KEEP_FINISHED_CALLS = 30
/** Text kept per call (the newest). */
const CALL_CHARS = 60_000

const tail = (s: string) => (s.length > CALL_CHARS ? s.slice(s.length - CALL_CHARS) : s)

/** The live model feed after one of its events (llm.*). */
export const applyModelEvent = (feed: ModelFeed, e: { type: string; data: unknown }, now = Date.now()): ModelFeed => {
  if (e.type === "llm.status") {
    const d = e.data as ModelEventDataMap["llm.status"]
    return { ...feed, server: { ...d, at: now } }
  }
  if (e.type === "llm.call") {
    const d = e.data as ModelEventDataMap["llm.call"]
    // Announced again (the snapshot after a reconnect): it is still running.
    if (feed.calls.some((c) => c.id === d.call_id)) return { ...feed, calls: feed.calls.map((c) => (c.id === d.call_id ? { ...c, done: null } : c)) }
    const call: ModelCallView = { id: d.call_id, kind: d.kind, label: d.label, model: d.model, subject: d.subject, episode_id: d.episode_id, step: d.step, started_at: Date.parse(d.started_at) || now, thinking: "", output: "", done: null }
    return { ...feed, calls: trim([call, ...feed.calls]) }
  }
  if (e.type === "llm.delta") {
    const d = e.data as ModelEventDataMap["llm.delta"]
    const pieces = new Map(d.calls.map((c) => [c.call_id, c]))
    return {
      ...feed,
      calls: feed.calls.map((c) => {
        const p = pieces.get(c.id)
        if (!p) return c
        return d.full ? { ...c, thinking: p.thinking, output: p.output } : { ...c, thinking: tail(c.thinking + p.thinking), output: tail(c.output + p.output) }
      }),
    }
  }
  if (e.type === "llm.done") {
    const { call_id, ...done } = e.data as ModelEventDataMap["llm.done"]
    return { ...feed, calls: feed.calls.map((c) => (c.id === call_id ? { ...c, done: { ...done, at: now } } : c)) }
  }
  return feed
}

/** Every running call, and the newest finished ones. */
const trim = (calls: ModelCallView[]) => {
  let finished = 0
  return calls.filter((c) => !c.done || ++finished <= KEEP_FINISHED_CALLS)
}

class StreamStore {
  snapshot: StreamSnapshot = { status: "connecting", scope: null, lastEventAt: null, events: [], tickers: {}, engine: null, gapCount: 0, models: { calls: [], server: null } }
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(e: AnyEvent) => void>()
  private ws: WebSocket | null = null
  private lastSeq = 0
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private lastMessageAt = 0
  private stopped = false
  private started = false

  constructor(private readonly config: StreamConfig) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  onEvent = (fn: (e: AnyEvent) => void) => {
    this.eventListeners.add(fn)
    return () => {
      this.eventListeners.delete(fn)
    }
  }
  get = () => this.snapshot

  private set(patch: Partial<StreamSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const fn of this.listeners) fn()
  }

  seed(events: AnyEvent[]) {
    if (this.snapshot.events.length) return
    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    this.lastSeq = Math.max(this.lastSeq, sorted.at(-1)?.seq ?? 0)
    this.set({ events: sorted.slice(-this.config.maxEvents).reverse() })
  }

  start() {
    if (this.started) return
    this.started = true
    this.stopped = false
    void this.connect()
    this.watchdog = setInterval(() => {
      if (this.snapshot.status === "live" && Date.now() - this.lastMessageAt > SILENCE_MS) this.ws?.close()
    }, 5_000)
  }

  stop() {
    this.stopped = true
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    if (this.watchdog) clearInterval(this.watchdog)
    this.ws?.close()
  }

  private retry() {
    if (this.stopped) return
    this.attempt += 1
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt, 5)) * (0.5 + Math.random() / 2)
    this.set({ status: this.attempt > 4 ? "offline" : "reconnecting" })
    this.timer = setTimeout(() => void this.connect(), delay)
  }

  private async connect() {
    let config: { url: string | null; token: string | null; scope: "public" | "owner" | null }
    try {
      const res = await fetch("/api/stream-token", { cache: "no-store" })
      config = await res.json()
    } catch {
      return this.retry()
    }
    if (!config.url || !config.token) return this.set({ status: "unconfigured" })
    let ws: WebSocket
    try {
      ws = new WebSocket(config.url)
    } catch {
      return this.retry()
    }
    this.ws = ws
    ws.onopen = () => {
      this.lastMessageAt = Date.now()
      ws.send(JSON.stringify({ type: "auth", token: config.token, ...(this.lastSeq ? { since: this.lastSeq } : {}) }))
    }
    ws.onmessage = (msg) => {
      this.lastMessageAt = Date.now()
      let frame: { type: string; [k: string]: unknown }
      try {
        frame = JSON.parse(String(msg.data))
      } catch {
        return
      }
      if (frame.type === "hello") {
        this.attempt = 0
        // Calls that were running when the connection dropped: the snapshot after the replay revives the ones still running.
        const now = Date.now()
        const calls = this.snapshot.models.calls.map((c) => (c.done ? c : { ...c, done: { ok: false, error: "the live stream reconnected", ms: now - c.started_at, prompt_tokens: 0, completion_tokens: 0, tokens_per_s: null, at: now } }))
        this.set({ status: "live", scope: frame.scope as StreamSnapshot["scope"], models: { ...this.snapshot.models, calls } })
      } else if (frame.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: frame.t }))
      } else if (frame.type === "replay_done" && frame.truncated) {
        this.set({ gapCount: this.snapshot.gapCount + 1 })
      } else if (frame.type === "event") {
        const parsed = eventEnvelopeSchema.safeParse(frame.event)
        if (parsed.success) this.ingest(parsed.data as unknown as AnyEvent)
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.retry()
    }
  }

  private ingest(e: AnyEvent) {
    // Persisted events carry a unique seq (dedupe on replay); high-frequency ones carry 0.
    if (e.seq > 0) {
      if (e.seq <= this.lastSeq) return
      this.lastSeq = e.seq
    }
    const patch: Partial<StreamSnapshot> = { lastEventAt: Date.now() }
    if (e.type.startsWith("llm.")) {
      // The live model feed keeps its own state: its deltas would crowd every other event out of the list.
      patch.models = applyModelEvent(this.snapshot.models, e)
      this.set(patch)
      for (const fn of this.eventListeners) fn(e)
      return
    }
    if (e.type === "market.ticker") {
      const { symbol, ...quote } = this.config.mapTicker(e.data)
      patch.tickers = { ...this.snapshot.tickers, [symbol]: { ...quote, at: Date.now() } }
    } else if (e.type === "engine.heartbeat" || e.type === "engine.status") {
      const d = e.data as { status: string; cycle_state?: string }
      patch.engine = { status: d.status, cycle_state: d.cycle_state ?? this.snapshot.engine?.cycle_state ?? null, at: Date.now() }
    } else if (e.type === "cycle.state") {
      const d = e.data as { state: string }
      patch.engine = { status: this.snapshot.engine?.status ?? "running", cycle_state: d.state, at: Date.now() }
    }
    if (e.type !== "market.ticker" && e.type !== "engine.heartbeat") {
      patch.events = [e, ...this.snapshot.events].slice(0, this.config.maxEvents)
    }
    this.set(patch)
    for (const fn of this.eventListeners) fn(e)
  }
}

const StreamContext = createContext<StreamStore | null>(null)

export function StreamProvider({ children, initialEvents, config }: { children: React.ReactNode; initialEvents: AnyEvent[]; config: StreamConfig }) {
  const [store] = useState(() => {
    const s = new StreamStore(config)
    s.seed(initialEvents)
    return s
  })
  useEffect(() => {
    store.start()
    return () => store.stop()
  }, [store])
  return <StreamContext.Provider value={store}>{children}</StreamContext.Provider>
}

const useStore = () => {
  const store = useContext(StreamContext)
  if (!store) throw new Error("useStream must be used inside <StreamProvider>")
  return store
}

/** The live stream's state; `E` is the bot's event type. */
export function useStream<E extends AnyEvent = AnyEvent>(): StreamSnapshot<E> {
  const store = useStore()
  return useSyncExternalStore(store.subscribe, store.get, store.get) as StreamSnapshot<E>
}

/** Calls `fn` for every new event (for side effects like refreshing server data). */
export function useStreamEvents<E extends AnyEvent = AnyEvent>(fn: (e: E) => void) {
  const store = useStore()
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  useEffect(() => store.onEvent((e) => ref.current(e as E)), [store])
}
