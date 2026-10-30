import type { WireSettingsBase, WireSummariesSettings } from "@mb/core/settings"
import type { WireArticle, WireArticleStatus, WireItemDoc, WireSourceHealth, WireSourceState } from "@mb/core/wire"
import { NO_MODEL_CALLS, type ModelCalls } from "@mb/engine-kit/ai/monitor"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import { HttpError } from "@mb/engine-kit/util/http"
import { cleanLine } from "@mb/engine-kit/util/text"
import type { RequestText } from "../fetch"
import { articleContext, chat, checkSummary, extractArticle, MIN_WORDS, servedModel, type Extracted, type Reply } from "./article"
import { isEnglish, skipReason, type SummaryCandidate } from "./select"

/**
 * Article summaries: a small queue in each engine that takes the
 * items worth it (select.ts), has the scraper extract the article, has the local model summarize
 * it, checks the summary (article.ts, numbers.ts) and stores the outcome on the wire item as
 * `article`. Never the article text.
 *
 * It is never on the trigger path: `offer` only queues and returns, after the item's trigger
 * handlers have run, and the work starts on a later turn of the event loop. One article at a time.
 * It never throws into the wire:
 *   - the scraper or the model unreachable, erroring or timing out: the item goes back in the
 *     queue (tried twice at most), and summaries back off from 1 to 30 minutes;
 *   - the server must answer and list its model (not 503 while loading) before the scraper is
 *     spent on an article; the model it lists is the one recorded;
 *   - the speed guard: a reply written slower than MIN_TOKENS_PER_S pauses summaries for 30
 *     minutes. llama.cpp doesn't say where its tensors sit, but a model spilled into system RAM,
 *     or crowded off the GPUs, writes far slower (docs/plans/LOCAL-AI.md §5.1);
 *   - at most `max_per_hour` articles an hour, none in the `pause_hours` (UTC);
 *   - a full queue drops its lowest-severity item; an item still queued 12 hours after it was
 *     first seen, or whose article is over a day old, is not summarized.
 * Its health shows as the source `enrich:summaries` (not a catalog source).
 */

export const ENRICH_SOURCE_ID = "enrich:summaries"

const QUEUE_MAX = 50
const TRIES_MAX = 2
const STALE_MS = 12 * 3_600_000
const OLD_ARTICLE_MS = 86_400_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const SLOW_PAUSE_MS = 30 * 60_000
/**
 * The speed guard's floor. On its own the model writes 40–50 tokens/s, and less per stream while
 * other slots share the server; spilled into system RAM, 15–20.
 */
export const MIN_TOKENS_PER_S = 20
/** A shorter reply says little about speed. */
const MIN_TIMED_TOKENS = 32
const MAX_BACKOFF_MS = 30 * 60_000
/** A wait is re-checked at least this often, so a settings change applies soon. */
const RECHECK_MS = 5 * 60_000
const TRIED_MAX = 5_000

export type EnricherTimeouts = { extractMs: number; chatMs: number; modelsMs: number }

/** The spike's lesson: a generous timeout, because a host stall once held a 4 s call for 27 s. */
const DEFAULT_TIMEOUTS: EnricherTimeouts = { extractMs: 60_000, chatMs: 60_000, modelsMs: 10_000 }

export type EnricherDeps = {
  /** Writes the outcome onto the wire item. */
  store: (id: string, article: WireArticle) => Promise<unknown>
  log: Logger
  /** The live `wire` settings: its mode and the `summaries` section. */
  settings: () => Pick<WireSettingsBase, "mode" | "summaries">
  /** SCRAPER_URL and LLM_URL. */
  env: Readonly<Record<string, string | undefined>>
  /** Who is asking, sent to the scraper as `X-Client` (its per-caller queue share): "crypto", "stock". */
  client: string
  request: RequestText
  now?: () => Date
  /** State changes, reported like a source's (the wire emits `wire.source`). */
  onState?: (state: WireSourceState, error: string | null) => void
  timeouts?: Partial<EnricherTimeouts>
  /** The live model feed: each summary streams there. */
  models?: ModelCalls
}

/** What the queue keeps of an item. */
export type EnrichCandidate = SummaryCandidate & Pick<WireItemDoc<string>, "first_seen_at" | "published_at">

type Queued = EnrichCandidate & { tries: number }

type Service = "scraper" | "llm"

/** Whether a UTC hour falls in one of the pause ranges ("22-6": 22:00 to 06:00, end excluded). */
export const inPauseHours = (hour: number, ranges: readonly string[]) =>
  ranges.some((r) => {
    const [from, to] = r.split("-").map(Number)
    return from < to ? hour >= from && hour < to : hour >= from || hour < to
  })

export class Enricher {
  private queue: Queued[] = []
  private readonly tried = new Set<string>()
  /** When each article was taken on, for the hourly cap. */
  private readonly started: number[] = []
  private readonly outcomes: { at: number; status: WireArticleStatus }[] = []
  private running: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly failures: Record<Service, number> = { scraper: 0, llm: 0 }
  private retryAt = 0
  private slowPausedUntil = 0
  private state: WireSourceState = "ok"
  private lastError: string | null = null
  private lastOkAt: Date | null = null
  private lastItemAt: Date | null = null
  private lastMs: number | null = null
  private lastSpeed: number | null = null
  private readonly now: () => Date
  private readonly timeouts: EnricherTimeouts

  constructor(private readonly d: EnricherDeps) {
    this.now = d.now ?? (() => new Date())
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...d.timeouts }
  }

  /** Why summaries are off, or null when they run. */
  disabledReason(): string | null {
    const s = this.d.settings()
    if (s.mode === "off") return "wire is off"
    if (!s.summaries.enabled) return "off in settings"
    if (!this.d.env.LLM_URL) return "LLM_URL not set (no local model)"
    if (!this.d.env.SCRAPER_URL) return "SCRAPER_URL not set (no scraper sidecar)"
    return null
  }

  start() {
    this.stopped = false
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
  }

  /** Considers an item for a summary. Returns at once; the work happens later, off the trigger path. */
  offer(item: EnrichCandidate): void {
    if (this.stopped || this.disabledReason()) return
    if (this.tried.has(item._id) || this.queue.some((q) => q._id === item._id)) return
    if (skipReason(item, this.d.settings().summaries)) return
    if (this.now().getTime() - item.published_at.getTime() > OLD_ARTICLE_MS) return
    const entry: Queued = {
      _id: item._id,
      cluster_id: item.cluster_id,
      kind: item.kind,
      title: item.title,
      url: item.url,
      severity: item.severity,
      notable: item.notable,
      first_seen_at: item.first_seen_at,
      published_at: item.published_at,
      tries: 0,
    }
    if (this.queue.length >= QUEUE_MAX) {
      const lowest = this.queue.reduce((a, b) => (b.severity < a.severity || (b.severity === a.severity && b.first_seen_at < a.first_seen_at) ? b : a))
      if (lowest.severity >= entry.severity) return
      this.queue.splice(this.queue.indexOf(lowest), 1)
    }
    this.queue.push(entry)
    this.kick()
  }

  /** Resolves once the queue has been worked through as far as it can be now (tests). */
  async idle() {
    while (this.running) await this.running
  }

  private kick() {
    if (this.stopped || this.running || this.timer) return
    this.running = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run())
      .catch((error) => this.d.log.warn("article summaries stopped on an error", { error: errorMessage(error) }))
      .finally(() => {
        this.running = null
      })
  }

  private later(ms: number) {
    this.timer = setTimeout(() => {
      this.timer = null
      this.kick()
    }, Math.min(Math.max(ms, 1_000), RECHECK_MS))
    this.timer.unref?.()
  }

  private async run() {
    while (!this.stopped && this.queue.length) {
      if (this.disabledReason()) {
        this.queue = []
        return
      }
      this.refreshState()
      const wait = this.waitMs()
      if (wait > 0) return this.later(wait)
      const item = this.take()
      const s = this.d.settings().summaries
      if (this.now().getTime() - item.first_seen_at.getTime() > STALE_MS || skipReason(item, s)) continue
      const result = await this.summarize(item, s)
      if (this.stopped) return
      if (result === "retry" && item.tries + 1 < TRIES_MAX) this.queue.push({ ...item, tries: item.tries + 1 })
      else this.remember(item._id)
    }
  }

  /** The most severe item, the newest among equals. */
  private take(): Queued {
    let best = 0
    for (let i = 1; i < this.queue.length; i++) {
      const a = this.queue[i]
      const b = this.queue[best]
      if (a.severity > b.severity || (a.severity === b.severity && a.first_seen_at > b.first_seen_at)) best = i
    }
    return this.queue.splice(best, 1)[0]
  }

  private remember(id: string) {
    this.tried.add(id)
    if (this.tried.size > TRIED_MAX) this.tried.delete(this.tried.values().next().value!)
  }

  /** How long until the next article may start (0: now): backoff, the speed guard, pause hours, the hourly cap. */
  private waitMs(): number {
    const now = this.now()
    const t = now.getTime()
    const s = this.d.settings().summaries
    while (this.started.length && this.started[0] <= t - HOUR_MS) this.started.shift()
    const waits = [this.retryAt - t, this.slowPausedUntil - t]
    if (inPauseHours(now.getUTCHours(), s.pause_hours)) waits.push(HOUR_MS - (t % HOUR_MS))
    if (this.started.length >= s.max_per_hour) waits.push(this.started[this.started.length - s.max_per_hour] + HOUR_MS - t)
    return Math.max(0, ...waits)
  }

  /** One article. "retry": a service failed, so the item may be tried again later. */
  private async summarize(item: Queued, s: WireSummariesSettings): Promise<"done" | "retry"> {
    const scraper = this.d.env.SCRAPER_URL!
    const llm = this.d.env.LLM_URL!
    const url = item.url!
    const started = this.now().getTime()

    // The model server first: if it is out, or still loading its model, nothing runs and the
    // scraper isn't spent on the article.
    let model: string
    try {
      model = await servedModel(this.d.request, llm, this.timeouts.modelsMs)
    } catch (error) {
      return this.failed("llm", error)
    }
    const finish = async (outcome: Omit<WireArticle, "model" | "ms" | "at">) => {
      const at = this.now()
      // Absent fields stay absent (the driver would store an undefined as null).
      const defined = Object.fromEntries(Object.entries(outcome).filter(([, v]) => v !== undefined)) as typeof outcome
      await this.record(item._id, { ...defined, model, ms: at.getTime() - started, at })
      return "done" as const
    }

    this.started.push(started)
    let extracted: Extracted
    try {
      extracted = await extractArticle(this.d.request, scraper, { url, skipDomains: s.skip_domains, client: this.d.client, timeoutMs: this.timeouts.extractMs })
    } catch (error) {
      // A 4xx (other than 429) is the scraper refusing this request, not the scraper failing.
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) return finish({ status: "failed", reason: `the scraper refused it (${error.status})` })
      return this.failed("scraper", error)
    }
    this.failures.scraper = 0
    if (extracted.status !== "ok") return finish({ status: extracted.status, reason: extracted.reason })
    const words = extracted.words
    if (words < MIN_WORDS) return finish({ status: "skipped", reason: `too short (${words} words)`, words })
    if (!isEnglish(extracted.text, extracted.lang)) return finish({ status: "skipped", reason: `not English${extracted.lang ? ` (${extracted.lang.slice(0, 12)})` : ""}`, words })

    const context = articleContext({ title: extracted.title ?? item.title, host: new URL(url).hostname.replace(/^www\./, ""), published: extracted.published, text: extracted.text })
    let reply: Reply
    const call = (this.d.models ?? NO_MODEL_CALLS).start({ kind: "summary", label: `Summary: ${cleanLine(extracted.title ?? item.title, 160)}`, model })
    try {
      reply = await chat(llm, { model, context, timeoutMs: this.timeouts.chatMs, call })
      call.end({ ok: true, completion_tokens: reply.tokens, tokens_per_s: reply.perSecond })
    } catch (error) {
      call.end({ ok: false, error: errorMessage(error) })
      return this.failed("llm", error)
    }
    this.failures.llm = 0
    this.lastOkAt = this.now()
    if (reply.perSecond !== null) this.lastSpeed = reply.perSecond
    const checked = checkSummary(reply.content, context)
    await finish(checked.status === "ok" ? { status: "ok", summary: checked.summary, key_points: checked.key_points, words } : { status: checked.status, reason: checked.reason, words })
    this.guardSpeed(model, reply)
    this.refreshState()
    return "done"
  }

  /** The speed guard: a slow reply means the model no longer runs (wholly) on the GPUs, so summaries stop adding to its load for a while. */
  private guardSpeed(model: string, reply: Reply) {
    if (reply.perSecond === null || reply.tokens < MIN_TIMED_TOKENS || reply.perSecond >= MIN_TOKENS_PER_S) return
    this.slowPausedUntil = this.now().getTime() + SLOW_PAUSE_MS
    this.lastError = `${model} wrote ${reply.perSecond.toFixed(1)} tokens/s (floor ${MIN_TOKENS_PER_S}): paused for ${SLOW_PAUSE_MS / 60_000} min`
    this.d.log.warn("article summaries paused: the local model is slow", { model, tokens: reply.tokens, per_second: reply.perSecond })
  }

  private failed(service: Service, error: unknown): "retry" {
    const n = ++this.failures[service]
    this.retryAt = this.now().getTime() + Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (n - 1))
    this.lastError = `${service === "llm" ? "local model" : "scraper"}: ${errorMessage(error)}`.slice(0, 300)
    this.d.log.debug("article summary failed", { service, error: this.lastError })
    this.refreshState()
    return "retry"
  }

  private async record(id: string, article: WireArticle) {
    if (this.stopped) return
    try {
      await this.d.store(id, article)
    } catch (error) {
      this.d.log.warn("storing an article summary failed", { id, error: errorMessage(error) })
      return
    }
    const at = article.at.getTime()
    this.outcomes.push({ at, status: article.status })
    while (this.outcomes.length && this.outcomes[0].at < at - DAY_MS) this.outcomes.shift()
    if (article.status === "ok") this.lastItemAt = article.at
    this.lastMs = article.ms
    this.d.log.debug("article summary", { id, status: article.status, reason: article.reason, ms: article.ms })
    this.refreshState()
  }

  private currentState(): WireSourceState {
    if (this.disabledReason()) return "disabled"
    const t = this.now().getTime()
    return this.failures.scraper > 0 || this.failures.llm > 0 || t < this.slowPausedUntil ? "degraded" : "ok"
  }

  private refreshState() {
    const state = this.currentState()
    if (state === "ok") this.lastError = null
    if (state === this.state) return
    this.state = state
    if (state === "degraded") this.d.log.warn("article summaries degraded", { error: this.lastError })
    this.d.onState?.(state, state === "degraded" ? this.lastError : null)
  }

  health(): WireSourceHealth {
    const t = this.now().getTime()
    const off = this.disabledReason()
    const day = this.outcomes.filter((o) => o.at >= t - DAY_MS)
    const count = (status: WireArticleStatus) => day.filter((o) => o.status === status).length
    const base = { id: ENRICH_SOURCE_ID, last_item_at: this.lastItemAt, last_ok_at: this.lastOkAt, items_24h: count("ok"), dropped_24h: day.length - count("ok"), lag_s: null }
    if (off) return { ...base, state: "disabled", last_error: off, detail: null }
    const s = this.d.settings().summaries
    const parts = [`24 h: ${count("ok")} ok, ${count("rejected")} rejected, ${count("skipped")} skipped, ${count("failed")} failed`]
    if (this.queue.length) parts.push(`${this.queue.length} queued`)
    if (inPauseHours(new Date(t).getUTCHours(), s.pause_hours)) parts.push("pause hours")
    if (this.started.filter((at) => at > t - HOUR_MS).length >= s.max_per_hour) parts.push(`hourly cap (${s.max_per_hour}) reached`)
    if (this.lastMs !== null) parts.push(`last took ${(this.lastMs / 1000).toFixed(1)} s${this.lastSpeed !== null ? ` (${Math.round(this.lastSpeed)} tokens/s)` : ""}`)
    const state = this.currentState()
    return { ...base, state, last_error: state === "ok" ? null : this.lastError, detail: parts.join(" · ") }
  }
}
