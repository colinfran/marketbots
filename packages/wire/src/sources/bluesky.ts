import type { WireSourceHealth } from "@mb/core/wire"
import WebSocket from "ws"
import { errorMessage } from "@mb/engine-kit/log"
import { backoffMs } from "@mb/engine-kit/util/async"
import type { Emit, RawItem, SourceContext, SourceSpec, WireSource } from "../types"

/**
 * Bluesky through Jetstream: a keyless WebSocket of every post by the
 * accounts we follow (`wantedDids`), as JSON. Each bot lists its curated accounts in its catalog
 * (owner-approved) and a keyword filter; only posts that match it enter the pipeline.
 *
 * Handles resolve to DIDs once per start. The cursor (the last event's time) is kept after every
 * event, so a reconnect resumes where it left off; after a restart it starts 10 minutes back, and
 * those replayed posts count as backfill (stored, never triggering). The two public Jetstream
 * hosts back each other up. Without approved accounts the source stays idle: an empty
 * `wantedDids` would mean the whole firehose.
 */

const HOSTS = ["wss://jetstream2.us-east.bsky.network", "wss://jetstream1.us-east.bsky.network"]
const REPLAY_US = 10 * 60 * 1_000_000
const MAX_TEXT = 300

type JetstreamEvent = {
  did: string
  time_us: number
  kind: string
  commit?: { operation: string; collection: string; rkey: string; record?: { text?: string; createdAt?: string; reply?: unknown; langs?: string[] } }
}

export type BlueskyOptions = {
  /** Handles (e.g. "coindesk.com") of the accounts to follow. */
  accounts: readonly string[]
  /** A post enters the pipeline only when its text matches. */
  keywords: RegExp
}

/** A Jetstream event → an item, or null when it isn't a new top-level post that matches. */
export const blueskyItem = (e: JetstreamEvent, handles: ReadonlyMap<string, string>, keywords: RegExp): RawItem<never> | null => {
  const c = e.commit
  if (e.kind !== "commit" || !c || c.operation !== "create" || c.collection !== "app.bsky.feed.post" || !c.record?.text) return null
  // Replies are conversation, not news.
  if (c.record.reply) return null
  const text = c.record.text.replace(/\s+/g, " ").trim()
  if (!keywords.test(text)) return null
  const handle = handles.get(e.did) ?? e.did
  const created = c.record.createdAt ? new Date(c.record.createdAt) : null
  const seen = new Date(Math.floor(e.time_us / 1000))
  return {
    sourceId: `${e.did}/${c.rkey}`,
    title: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text,
    url: `https://bsky.app/profile/${handle}/post/${c.rkey}`,
    // A post's own date can be anything its client wrote; never later than when it reached the relay.
    publishedAt: created && !Number.isNaN(created.getTime()) && created <= seen ? created : seen,
    tier: 3,
    kind: "news",
    meta: { author: handle },
  }
}

export class BlueskySource implements WireSource<never> {
  readonly tier = 3 as const
  private emit: Emit<never> | null = null
  private ws: WebSocket | null = null
  private timer: NodeJS.Timeout | null = null
  private cursor: number | null = null
  private startedUs = 0
  private host = 0
  private attempt = 0
  private dids: string[] = []
  private readonly handles = new Map<string, string>()
  private lastOkAt: Date | null = null
  private lastItemAt: Date | null = null
  private lastError: string | null = null

  constructor(
    readonly id: string,
    private readonly ctx: SourceContext,
    private readonly opts: BlueskyOptions,
  ) {}

  start(emit: Emit<never>) {
    this.emit = emit
    this.startedUs = Date.now() * 1000
    this.cursor ??= this.startedUs - REPLAY_US
    void this.resolve().then(() => this.connect())
  }

  stop() {
    this.emit = null
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  health(): WireSourceHealth {
    const idle = !this.opts.accounts.length
    const state = !this.emit ? "disabled" : idle ? "ok" : this.ws?.readyState === WebSocket.OPEN ? "ok" : this.lastOkAt ? "degraded" : "starting"
    return { id: this.id, state, last_item_at: this.lastItemAt, last_ok_at: this.lastOkAt, last_error: idle ? "no approved accounts yet" : this.lastError, items_24h: 0, dropped_24h: 0, lag_s: null, detail: idle ? "idle" : `${this.dids.length} of ${this.opts.accounts.length} accounts` }
  }

  /** Handle → DID for every account not yet resolved (public, keyless). */
  private async resolve() {
    for (const handle of this.opts.accounts) {
      if ([...this.handles.values()].includes(handle)) continue
      try {
        const res = await this.ctx.fetch.json<{ did?: string }>(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, { conditional: false })
        if (res?.did) this.handles.set(res.did, handle)
      } catch (error) {
        this.ctx.log.debug("bluesky handle not resolved", { handle, error: errorMessage(error) })
      }
    }
    this.dids = [...this.handles.keys()]
  }

  private connect() {
    if (!this.emit || !this.dids.length) return
    const params = new URLSearchParams({ wantedCollections: "app.bsky.feed.post" })
    for (const did of this.dids) params.append("wantedDids", did)
    if (this.cursor) params.set("cursor", String(this.cursor))
    const ws = new WebSocket(`${HOSTS[this.host % HOSTS.length]}/subscribe?${params}`)
    this.ws = ws
    ws.on("open", () => {
      this.attempt = 0
      this.lastError = null
    })
    ws.on("message", (raw) => this.onMessage(raw))
    ws.on("error", (error) => (this.lastError = errorMessage(error).slice(0, 200)))
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null
      if (!this.emit) return
      // Alternate hosts on failure.
      this.attempt += 1
      this.host += 1
      this.timer = setTimeout(() => this.connect(), Math.max(1_000, backoffMs(this.attempt, 1_000, 60_000)))
    })
  }

  private onMessage(raw: WebSocket.RawData) {
    let e: JetstreamEvent
    try {
      e = JSON.parse(raw.toString()) as JetstreamEvent
    } catch {
      return
    }
    this.lastOkAt = new Date()
    if (typeof e.time_us === "number") this.cursor = e.time_us
    const item = blueskyItem(e, this.handles, this.opts.keywords)
    if (!item || !this.emit) return
    this.lastItemAt = new Date()
    void this.emit([item], { backfill: e.time_us < this.startedUs }).catch((error) => (this.lastError = errorMessage(error).slice(0, 200)))
  }
}

/** A catalog entry for a bot's curated Bluesky accounts. */
export const blueskySpec = (opts: BlueskyOptions): SourceSpec<never> => ({
  id: "bluesky",
  kind: "custom",
  interval_s: 60,
  tier: 3,
  wire_kind: "news",
  default_enabled: true,
  note: `Bluesky Jetstream, ${opts.accounts.length} curated accounts`,
  create: (spec, ctx) => new BlueskySource(spec.id, ctx, opts),
})
