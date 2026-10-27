import type { WireSettingsBase } from "@mb/core/settings"
import type { NotableReason, WireItemDoc, WireSourceHealth, WireSourceState, WireStatus } from "@mb/core/wire"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import type { Collection, UpdateFilter } from "mongodb"
import { ClusterIndex } from "./cluster"
import { WireFetch, type RequestText } from "./fetch"
import { buildSource } from "./kinds/index"
import type { StatuspageCategory } from "./kinds/statuspage"
import { DomainLimiter } from "./limiter"
import { normalizeRaw } from "./normalize"
import { isValid, notableReasons } from "./notable"
import { scoreSeverity } from "./severity"
import type { Lexicon, RawItem, SourceContext, SourceSpec, SymbolSets, WireEventSink, WireSource } from "./types"

/**
 * The news engine. It runs every catalog source (each isolated), pushes what they find through
 *
 *   normalize → dedupe → tag symbols → classify → relevance filter → cluster (confirmations)
 *   → severity → notable flag → store (wire_items) → wire.item event → item handlers (the policy)
 *
 * and reports per-source health for the heartbeat. It never throws into the engine: a broken
 * source, a bad payload or a database hiccup costs at most that batch of items, and trading goes
 * on exactly as it would without the wire.
 *
 * Generic over the bot's wire categories (`C`) and `wire` settings (`W`). Each engine binds it in
 * its own wire/wire.ts, which injects the category severity bases and its HTTP client.
 */

export type ItemEvent<C extends string> = { item: WireItemDoc<C>; backfill: boolean; confirmation: boolean }

export type WireDeps<C extends string, W extends WireSettingsBase> = {
  col: { wireItems: Collection<WireItemDoc<C>> }
  bus: WireEventSink<C>
  log: Logger
  settings: () => W
  catalog: SourceSpec<C, W>[]
  lexicon: Lexicon<C>
  /**
   * The bot's severity base per category (CATEGORY_BASE). It must have the fallback category and
   * the ones the generic source kinds set (see kinds/index.ts).
   */
  categoryBase: Readonly<Record<C | "general" | StatuspageCategory, number>>
  env: Readonly<Record<string, string | undefined>>
  symbols: () => SymbolSets
  /** Live mid price, for "move since first seen". */
  price: (symbol: string) => number | null
  userAgent: string
  /** The engine's HTTP client, for every source's fetches. */
  request: RequestText
  now?: () => Date
  fetch?: WireFetch
}

const DAY_MS = 86_400_000
const SEEN_MAX = 50_000
/** Base weight of a category found only in the summary, not the title. */
const SUMMARY_CATEGORY_WEIGHT = 0.5
/** Matching anomalies within this window add severity. */
const ANOMALY_WINDOW_MS = 15 * 60_000

type Counter = { items: number[]; dropped: number[]; lastLagS: number | null }

/**
 * An update that adds to an array field ($push, $addToSet). None of those fields depends on the
 * category, but the driver's types can't resolve a generic document's array fields, so the update
 * is checked against a concrete one.
 */
const pushUpdate = <C extends string>(update: UpdateFilter<WireItemDoc<string>>) => update as UpdateFilter<WireItemDoc<C>>

export class Wire<C extends string, W extends WireSettingsBase> {
  private readonly sources = new Map<string, WireSource<C>>()
  private readonly specs = new Map<string, SourceSpec<C, W>>()
  private readonly cluster = new ClusterIndex()
  private readonly seen = new Set<string>()
  private readonly counters = new Map<string, Counter>()
  private readonly anomalies = new Map<string, { at: number; kind: "price" | "volume" }[]>()
  private readonly handlers: ((e: ItemEvent<C>) => void | Promise<void>)[] = []
  private readonly fetcher: WireFetch
  private readonly now: () => Date
  private abort = new AbortController()
  private running = false

  constructor(private readonly d: WireDeps<C, W>) {
    this.now = d.now ?? (() => new Date())
    this.fetcher = d.fetch ?? new WireFetch(new DomainLimiter(), d.userAgent, d.request)
    for (const spec of d.catalog) this.specs.set(spec.id, spec)
  }

  /** Called for every stored item, and again when a later copy confirms one. */
  onItem(fn: (e: ItemEvent<C>) => void | Promise<void>) {
    this.handlers.push(fn)
  }

  /** Why a catalog source is off, or null when it should run. */
  disabledReason(spec: SourceSpec<C, W>, s: W = this.d.settings()): string | null {
    if (s.mode === "off") return "wire is off"
    if (s.disabled_sources.includes(spec.id)) return "disabled in settings"
    if (!spec.default_enabled) return "off by default"
    if (spec.key_env && !this.d.env[spec.key_env]) return `${spec.key_env} not set`
    if (spec.kind === "headless" && !this.d.env.SCRAPER_URL) return "SCRAPER_URL not set (no scraper sidecar)"
    return null
  }

  async start() {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    await this.rebuildMemory().catch((e) => this.d.log.warn("wire memory rebuild failed", { error: errorMessage(e) }))
    this.reconcile()
  }

  stop() {
    this.running = false
    this.abort.abort()
    for (const s of this.sources.values()) s.stop()
    this.sources.clear()
  }

  /** Starts and stops sources to match the settings (mode, disabled sources). Safe to call any time. */
  reconcile() {
    if (!this.running) return
    const s = this.d.settings()
    for (const spec of this.specs.values()) {
      const off = this.disabledReason(spec, s)
      const source = this.sources.get(spec.id)
      if (off && source) {
        source.stop()
        this.sources.delete(spec.id)
      } else if (!off && !source) {
        try {
          const created = buildSource(spec, this.context(), (id, state, error) => this.onSourceState(id, state, error))
          this.sources.set(spec.id, created)
          created.start((items, opts) => this.ingest(spec.id, items, opts).then(() => undefined), this.abort.signal)
        } catch (error) {
          this.d.log.warn("wire source failed to start", { source: spec.id, error: errorMessage(error) })
        }
      }
    }
  }

  private context(): SourceContext<W> {
    return { fetch: this.fetcher, log: this.d.log, env: this.d.env, symbols: this.d.symbols, now: this.now, settings: this.d.settings }
  }

  private onSourceState(id: string, state: WireSourceState, error: string | null) {
    const bad = state === "degraded" || state === "down"
    this.d.bus.emit("wire.source", { id, state, error }, { summary: bad ? `News source ${id} ${state}${error ? `: ${error.slice(0, 120)}` : ""}` : `News source ${id} ${state}`, level: bad ? "warn" : "debug" })
  }

  /** Re-learns the last 24 hours (dedupe ids, clusters and their domains) so a restart doesn't re-ingest them as new. */
  private async rebuildMemory() {
    const since = new Date(this.now().getTime() - DAY_MS)
    const docs = await this.d.col.wireItems
      .find({ first_seen_at: { $gte: since } }, { projection: { _id: 1, cluster_id: 1, title: 1, symbols: 1, first_seen_at: 1, domain: 1, confirmations: 1 } })
      .sort({ first_seen_at: 1 })
      .limit(20_000)
      .toArray()
    for (const d of docs) {
      this.remember(d._id)
      if (d.cluster_id !== d._id) continue
      this.cluster.add(d._id, d.title, d.symbols, d.first_seen_at.getTime(), d.domain)
    }
    this.d.log.info("wire memory rebuilt", { items: docs.length, clusters: this.cluster.size })
  }

  private remember(id: string) {
    this.seen.add(id)
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value!)
  }

  private counter(source: string): Counter {
    let c = this.counters.get(source)
    if (!c) {
      c = { items: [], dropped: [], lastLagS: null }
      this.counters.set(source, c)
    }
    return c
  }

  private count(source: string, key: "items" | "dropped", at: number) {
    const list = this.counter(source)[key]
    list.push(at)
    if (list.length > 20_000 || (list.length > 100 && list[0] < at - DAY_MS)) {
      const cutoff = at - DAY_MS
      const keep = list.findIndex((t) => t >= cutoff)
      list.splice(0, keep < 0 ? list.length : keep)
    }
  }

  /** A price or volume anomaly on a symbol: items about it within ±15 minutes gain severity. */
  recordAnomaly(symbol: string, kind: "price" | "volume", at = this.now()) {
    const list = (this.anomalies.get(symbol) ?? []).filter((a) => at.getTime() - a.at <= ANOMALY_WINDOW_MS)
    list.push({ at: at.getTime(), kind })
    this.anomalies.set(symbol, list)
  }

  private anomalyPoints(symbols: string[], at: number) {
    let points = 0
    for (const s of symbols) {
      for (const a of this.anomalies.get(s) ?? []) {
        if (Math.abs(at - a.at) > ANOMALY_WINDOW_MS) continue
        points = Math.max(points, a.kind === "price" ? 15 : this.d.lexicon.volumeAnomalyPoints)
      }
    }
    return points
  }

  /** The pipeline. Public so custom sources and tests can push items directly. */
  async ingest(source: string, raws: RawItem<C>[], { backfill = false }: { backfill?: boolean } = {}): Promise<{ stored: WireItemDoc<C>[]; dropped: number; duplicates: number; confirmed: number }> {
    const result = { stored: [] as WireItemDoc<C>[], dropped: 0, duplicates: 0, confirmed: 0 }
    const s = this.d.settings()
    if (s.mode === "off") return result
    const spec = this.specs.get(source)
    const sets = this.d.symbols()
    const known = [...new Set([...sets.universe, ...sets.held, ...sets.focus])]
    const universe = new Set(sets.universe)
    const held = new Set(sets.held)
    const focus = new Set(sets.focus)
    for (const raw of raws) {
      try {
        const now = this.now()
        const n = normalizeRaw(source, raw, now)
        if (!n) continue
        if (this.seen.has(n.id)) {
          result.duplicates += 1
          continue
        }
        this.remember(n.id)
        // The title says what a story is about; summaries mention other assets in passing
        // ("drained 400 ETH"), so they only fill in when the title says nothing.
        const lead = (n.summary ?? "").slice(0, 200)
        const lx = this.d.lexicon
        const titleSymbols = lx.tag(n.title, known)
        // Amounts ("400 ETH", "2.5 million shares") are mentions, not subjects.
        const symbols = raw.symbols ?? (titleSymbols.length ? titleSymbols : lx.tag(lead.replace(/\b\d[\d,.]*\s?(?:k|m|b|million|billion)?\s+[a-z]{2,8}\b/gi, " "), known))
        const titleCategory = lx.classify(n.title)
        const category = raw.category ?? (titleCategory !== "general" ? titleCategory : lx.classify(lead, spec?.category_hint))
        // A category only the summary supports is a passing mention ("…as hacks rise"): half weight.
        const fromSummary = !raw.category && titleCategory === "general" && category !== "general" && category !== spec?.category_hint
        const kind = raw.kind ?? spec?.wire_kind ?? "news"
        const tier = raw.tier ?? spec?.tier ?? 3
        const marketWide = symbols.length === 0 && (raw.marketWide ?? lx.marketWide(n.title, category))
        if (!(symbols.length || marketWide || kind === "anomaly")) {
          result.dropped += 1
          this.count(source, "dropped", now.getTime())
          continue
        }

        const root = this.cluster.match(n.title, symbols, now.getTime())
        if (root) {
          result.duplicates += 1
          if (this.cluster.confirm(root, n.title, n.domain) && n.domain) {
            result.confirmed += 1
            await this.addConfirmation(root.id, { domain: n.domain, url: n.url, at: now }, backfill)
          }
          continue
        }

        const isHeld = symbols.some((x) => held.has(x))
        const override = raw.baseSeverity ?? lx.baseSeverity?.(`${n.title} ${lead}`, category)
        const { severity, parts } = scoreSeverity(
          {
            category,
            tier,
            baseOverride: fromSummary ? (override ?? this.d.categoryBase[category]) * SUMMARY_CATEGORY_WEIGHT : override,
            held: isHeld,
            candidate: symbols.some((x) => focus.has(x) || universe.has(x)),
            marketWide,
            confirmations: 0,
            anomalyPoints: kind === "anomaly" ? 0 : this.anomalyPoints(symbols, now.getTime()),
          },
          this.d.categoryBase,
        )
        const prices: Record<string, number> = {}
        for (const sym of symbols) {
          const p = this.d.price(sym)
          if (p !== null && Number.isFinite(p)) prices[sym] = p
        }
        const doc: WireItemDoc<C> = {
          _id: n.id,
          cluster_id: n.id,
          source,
          tier,
          kind,
          category,
          title: n.title,
          summary: n.summary,
          url: n.url,
          domain: n.domain,
          symbols,
          published_at: n.published_at,
          first_seen_at: now,
          polarity: raw.polarity ?? (lx.polarity(n.title) || lx.polarity(lead)),
          severity,
          severity_parts: parts,
          confirmations: [],
          price_at_seen: prices,
          meta: { ...raw.meta, ...(backfill ? { backfill: true } : {}) },
          notable: false,
          notable_reasons: [],
          expires_at: new Date(now.getTime() + s.retention_days * DAY_MS),
        }
        doc.notable_reasons = notableReasons(doc, { now, held, focus, thresholds: s.thresholds })
        doc.notable = doc.notable_reasons.length > 0
        try {
          await this.d.col.wireItems.insertOne(doc)
        } catch (error) {
          if ((error as { code?: number }).code === 11000) {
            result.duplicates += 1
            continue
          }
          throw error
        }
        this.cluster.add(doc._id, doc.title, symbols, now.getTime(), doc.domain)
        this.count(source, "items", now.getTime())
        this.counter(source).lastLagS = Math.round((now.getTime() - n.published_at.getTime()) / 1000)
        result.stored.push(doc)
        if (severity >= s.thresholds.annotate) this.emitItem(doc)
        await this.notify({ item: doc, backfill, confirmation: false })
      } catch (error) {
        this.d.log.warn("wire item failed", { source, error: errorMessage(error) })
      }
    }
    return result
  }

  private emitItem(doc: WireItemDoc<C>) {
    this.d.bus.emit(
      "wire.item",
      {
        id: doc._id,
        source: doc.source,
        tier: doc.tier,
        kind: doc.kind,
        category: doc.category,
        title: doc.title,
        url: doc.url,
        symbols: doc.symbols,
        severity: doc.severity,
        first_seen_at: doc.first_seen_at.toISOString(),
        notable: doc.notable,
        notable_reasons: doc.notable_reasons,
      },
      { summary: `${doc.symbols.length ? `${doc.symbols.join(", ")}: ` : ""}${doc.title.slice(0, 160)}`, level: doc.notable ? "info" : "debug", instrument: doc.symbols[0] },
    )
  }

  private async notify(e: ItemEvent<C>) {
    for (const fn of this.handlers) {
      try {
        await fn(e)
      } catch (error) {
        this.d.log.warn("wire item handler failed", { item: e.item._id, error: errorMessage(error) })
      }
    }
  }

  /** A later copy from another domain: recorded on the root, which gains severity and may become confirmed and notable. */
  private async addConfirmation(rootId: string, c: { domain: string; url: string | null; at: Date }, backfill: boolean) {
    const updated = await this.d.col.wireItems.findOneAndUpdate({ _id: rootId, "confirmations.domain": { $ne: c.domain } }, pushUpdate<C>({ $push: { confirmations: c } }), { returnDocument: "after" })
    if (!updated) return
    const parts = { ...updated.severity_parts, confirmation: Math.min(16, 8 * updated.confirmations.length) }
    const severity = Math.max(0, Math.min(100, Math.round(Object.values(parts).reduce((a, b) => a + b, 0))))
    const s = this.d.settings()
    const sets = this.d.symbols()
    const item: WireItemDoc<C> = { ...updated, severity, severity_parts: parts }
    const reasons = notableReasons(item, { now: this.now(), held: new Set(sets.held), focus: new Set(sets.focus), thresholds: s.thresholds }, updated.notable_reasons)
    item.notable_reasons = reasons
    item.notable = updated.notable || reasons.length > 0
    await this.d.col.wireItems.updateOne({ _id: rootId }, { $set: { severity, severity_parts: parts, notable: item.notable, notable_reasons: reasons } })
    if (item.notable && !updated.notable) this.emitNotable(item, reasons[0])
    await this.notify({ item, backfill, confirmation: true })
  }

  private emitNotable(item: WireItemDoc<C>, reason: NotableReason) {
    this.d.bus.emit(
      "wire.notable",
      { id: item._id, reason, notable_reasons: item.notable_reasons, title: item.title, symbols: item.symbols, severity: item.severity },
      { summary: `${item.symbols.length ? `${item.symbols.join(", ")}: ` : ""}${item.title.slice(0, 160)}`, instrument: item.symbols[0] },
    )
  }

  /** Marks items notable for a reason (triggered, cited). Only valid items qualify; each reason is added once. */
  async markNotable(ids: string[], reason: NotableReason) {
    const now = this.now()
    const marked: string[] = []
    for (const id of [...new Set(ids)]) {
      try {
        const doc = await this.d.col.wireItems.findOne({ _id: id })
        if (!doc || doc.notable_reasons.includes(reason) || !isValid(doc, now)) continue
        const reasons = [...doc.notable_reasons, reason]
        const res = await this.d.col.wireItems.updateOne({ _id: id, notable_reasons: { $ne: reason } }, pushUpdate<C>({ $set: { notable: true }, $addToSet: { notable_reasons: reason } }))
        if (!res.modifiedCount) continue
        marked.push(id)
        this.emitNotable({ ...doc, notable: true, notable_reasons: reasons }, reason)
      } catch (error) {
        this.d.log.warn("marking a wire item notable failed", { id, error: errorMessage(error) })
      }
    }
    return marked
  }

  /** Health for the heartbeat. `extra` comes from the policy and the engine's event queue. */
  health(extra: { triggers_today?: number; event_queue?: string[] } = {}): WireStatus {
    const now = this.now().getTime()
    const s = this.d.settings()
    const within = (list: number[], ms: number) => list.filter((t) => t >= now - ms).length
    const sources: WireSourceHealth[] = [...this.specs.values()].map((spec) => {
      const running = this.sources.get(spec.id)
      const c = this.counters.get(spec.id)
      const base: WireSourceHealth = running?.health() ?? { id: spec.id, state: "disabled", last_item_at: null, last_ok_at: null, last_error: this.disabledReason(spec, s), items_24h: 0, dropped_24h: 0, lag_s: null }
      return { ...base, items_24h: c ? within(c.items, DAY_MS) : 0, dropped_24h: c ? within(c.dropped, DAY_MS) : 0, lag_s: c?.lastLagS ?? null }
    })
    const itemsLastHour = [...this.counters.values()].reduce((n, c) => n + within(c.items, 3_600_000), 0)
    return { mode: s.mode, sources, items_last_hour: itemsLastHour, triggers_today: extra.triggers_today ?? 0, event_queue: extra.event_queue ?? [] }
  }

  /** Healthy enough for gap-fill research: at least half the running wave-1 sources are ok. */
  healthy(): boolean {
    const running = [...this.sources.values()].map((s) => s.health().state)
    if (!running.length) return false
    return running.filter((st) => st === "ok").length >= running.length / 2
  }
}
