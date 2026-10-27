"use client"

import type { EngineEvent, EngineRunStatus, CycleState } from "@mb/crypto-core/events"
import { eventEnvelopeSchema } from "@mb/crypto-core/events"
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react"

/**
 * The browser's connection to the engine's live event stream.
 *
 * Connection: fetch a 60s token from /api/stream-token → open the WebSocket → send the token as
 * the first frame, with the last seq seen so the engine replays anything missed. Reconnects
 * with exponential backoff + jitter (a fresh token each time), and treats 45s of silence as a
 * dead connection (the engine pings every 15s). The dashboard works without it: pages are
 * server-rendered from MongoDB, and the stream only makes them live.
 */

export type StreamStatus = "connecting" | "live" | "reconnecting" | "offline" | "unconfigured"
export type Ticker = { bid: number; ask: number; last: number; change_pct: number | null; at: number }

type Snapshot = {
  status: StreamStatus
  scope: "public" | "owner" | null
  lastEventAt: number | null
  events: EngineEvent[]
  tickers: Record<string, Ticker>
  engine: { status: EngineRunStatus; cycle_state: CycleState | null; at: number } | null
  /** Bumped when the replay couldn't cover a gap, so pages refetch server data. */
  gapCount: number
}

const MAX_EVENTS = 300
const SILENCE_MS = 45_000

class StreamStore {
  snapshot: Snapshot = { status: "connecting", scope: null, lastEventAt: null, events: [], tickers: {}, engine: null, gapCount: 0 }
  private listeners = new Set<() => void>()
  private eventListeners = new Set<(e: EngineEvent) => void>()
  private ws: WebSocket | null = null
  private lastSeq = 0
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private lastMessageAt = 0
  private stopped = false
  private started = false

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  onEvent = (fn: (e: EngineEvent) => void) => {
    this.eventListeners.add(fn)
    return () => {
      this.eventListeners.delete(fn)
    }
  }
  get = () => this.snapshot

  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const fn of this.listeners) fn()
  }

  seed(events: EngineEvent[]) {
    if (this.snapshot.events.length) return
    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    this.lastSeq = Math.max(this.lastSeq, sorted.at(-1)?.seq ?? 0)
    this.set({ events: sorted.slice(-MAX_EVENTS).reverse() })
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
        this.set({ status: "live", scope: frame.scope as Snapshot["scope"] })
      } else if (frame.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: frame.t }))
      } else if (frame.type === "replay_done" && frame.truncated) {
        this.set({ gapCount: this.snapshot.gapCount + 1 })
      } else if (frame.type === "event") {
        const parsed = eventEnvelopeSchema.safeParse(frame.event)
        if (parsed.success) this.ingest(parsed.data as unknown as EngineEvent)
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      this.retry()
    }
  }

  private ingest(e: EngineEvent) {
    // Persisted events carry a unique seq (dedupe on replay); high-frequency ones carry 0.
    if (e.seq > 0) {
      if (e.seq <= this.lastSeq) return
      this.lastSeq = e.seq
    }
    const patch: Partial<Snapshot> = { lastEventAt: Date.now() }
    if (e.type === "market.ticker") {
      const d = e.data as { symbol: string; bid: number; ask: number; last: number; change_pct: number | null }
      patch.tickers = { ...this.snapshot.tickers, [d.symbol]: { bid: d.bid, ask: d.ask, last: d.last, change_pct: d.change_pct, at: Date.now() } }
    } else if (e.type === "engine.heartbeat" || e.type === "engine.status") {
      const d = e.data as { status: EngineRunStatus; cycle_state?: CycleState }
      patch.engine = { status: d.status, cycle_state: d.cycle_state ?? this.snapshot.engine?.cycle_state ?? null, at: Date.now() }
    } else if (e.type === "cycle.state") {
      const d = e.data as { state: CycleState }
      patch.engine = { status: this.snapshot.engine?.status ?? "running", cycle_state: d.state, at: Date.now() }
    }
    if (e.type !== "market.ticker" && e.type !== "engine.heartbeat") {
      patch.events = [e, ...this.snapshot.events].slice(0, MAX_EVENTS)
    }
    this.set(patch)
    for (const fn of this.eventListeners) fn(e)
  }
}

const StreamContext = createContext<StreamStore | null>(null)

export function StreamProvider({ children, initialEvents }: { children: React.ReactNode; initialEvents: EngineEvent[] }) {
  const [store] = useState(() => {
    const s = new StreamStore()
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

export function useStream(): Snapshot {
  const store = useStore()
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** Calls `fn` for every new event (for side effects like refreshing server data). */
export function useStreamEvents(fn: (e: EngineEvent) => void) {
  const store = useStore()
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  useEffect(() => store.onEvent((e) => ref.current(e)), [store])
}
