// Mirrored in cryptomarketbot and stockmarketbot: keep in sync.
import type { WireSourceHealth, WireSourceState, WireTier } from "@mb/stock-core/wire"
import { errorMessage } from "@mb/engine-kit/log"
import { sleep } from "@mb/engine-kit/util/async"
import { HttpError } from "@mb/engine-kit/util/http"
import type { Emit, RawItem, SourceContext, SourceSpec, WireSource } from "./types"

/**
 * The loop every polled source runs in. Each source is isolated: its errors are caught here and
 * only change its own health. Failures back off exponentially (up to 30 minutes). Repeated
 * 403/429 answers mean the site doesn't want us polling: the source is marked degraded and slows
 * right down. A poll returning null means "nothing changed" (HTTP 304).
 *
 * The first successful poll after start is a backfill: its items are stored but never trigger.
 */

const MAX_BACKOFF_MS = 30 * 60_000
const BLOCKED_AFTER = 3
const DOWN_AFTER = 5

export type PollFn = () => Promise<RawItem[] | null>

export class PollingSource implements WireSource {
  readonly id: string
  readonly tier: WireTier
  private state: WireSourceState = "starting"
  private lastOkAt: Date | null = null
  private lastItemAt: Date | null = null
  private lastError: string | null = null
  private failures = 0
  private blocked = 0
  private polled = false
  private abort: AbortController | null = null

  constructor(
    private readonly spec: SourceSpec,
    private readonly ctx: SourceContext,
    private readonly poll: PollFn,
    private readonly onState: (id: string, state: WireSourceState, error: string | null) => void = () => undefined,
  ) {
    this.id = spec.id
    this.tier = spec.tier
  }

  start(emit: Emit, signal: AbortSignal) {
    this.abort = new AbortController()
    const stop = this.abort.signal
    signal.addEventListener("abort", () => this.abort?.abort(), { once: true })
    void (async () => {
      // Spread the first polls out so a boot doesn't hit every source at the same instant.
      await sleep(Math.random() * Math.min(10_000, this.spec.interval_s * 1000), stop)
      while (!stop.aborted) {
        await this.tick(emit)
        await sleep(this.delayMs(), stop)
      }
    })()
  }

  stop() {
    this.abort?.abort()
  }

  /** One poll. Exposed for tests. */
  async tick(emit: Emit) {
    try {
      const items = await this.poll()
      this.failures = 0
      this.blocked = 0
      this.lastOkAt = this.ctx.now()
      this.lastError = null
      this.setState("ok", null)
      if (items?.length) {
        this.lastItemAt = this.ctx.now()
        await emit(items, { backfill: !this.polled })
      }
      if (items) this.polled = true
    } catch (error) {
      const message = errorMessage(error).slice(0, 300)
      this.lastError = message
      if (error instanceof HttpError && (error.status === 403 || error.status === 429)) this.blocked += 1
      else this.failures += 1
      this.setState(this.blocked >= BLOCKED_AFTER ? "degraded" : this.failures >= DOWN_AFTER ? "down" : this.state === "starting" ? "degraded" : this.state, message)
      this.ctx.log.debug("wire source poll failed", { source: this.id, error: message })
    }
  }

  private delayMs() {
    const base = this.spec.interval_s * 1000
    const n = Math.max(this.failures, this.blocked >= BLOCKED_AFTER ? this.blocked + 3 : 0)
    return n ? Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(n, 10)) : base
  }

  private setState(state: WireSourceState, error: string | null) {
    if (state === this.state) return
    this.state = state
    this.onState(this.id, state, error)
  }

  health(): WireSourceHealth {
    return { id: this.id, state: this.state, last_item_at: this.lastItemAt, last_ok_at: this.lastOkAt, last_error: this.lastError, items_24h: 0, dropped_24h: 0, lag_s: null }
  }
}
