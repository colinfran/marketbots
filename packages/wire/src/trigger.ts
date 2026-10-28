import { randomUUID } from "node:crypto"
import { utcDay } from "@mb/core/db"
import type { WireSettingsBase } from "@mb/core/settings"
import type { EventFocus, WireItemDoc, WireTriggerAction, WireTriggerDoc, WireTriggerStatus } from "@mb/core/wire"
import type { AiBudget } from "@mb/engine-kit/ai/budget"
import { errorMessage, type Logger } from "@mb/engine-kit/log"
import type { Collection } from "mongodb"
import { isConfirmed } from "./notable"
import type { WireEventSink } from "./types"

/**
 * When an item is out of the ordinary enough to act on. Each bot's rules
 * (wire/policy.ts in each engine) turn an item into candidate triggers; every candidate then
 * passes the same gates, in order, and is recorded in `wire_triggers` with the reason it fired or
 * didn't:
 *
 *   mode → item fresh (first seen within trigger_max_age_minutes, never a backfill, not old news)
 *   → confirmation (entries only) → shadow → engine running, kill switch off → market open
 *   (stocks) → per-symbol cooldown → hourly and daily caps → AI budget → fire now, or queue.
 *
 * The policy never trades. A trigger only asks the engine for a focused cycle, where the AI and the
 * risk engine decide as always. The one exception is the owner's `emergency_action` for a held
 * position hit by a critical, confirmed, negative event, which only ever reduces risk.
 *
 * Generic over the bot's wire categories (`C`) and its settings (`S`); each engine binds it in its
 * own wire/policy.ts.
 */

/**
 * The settings the gates read: the bot's whole settings document (its rules get it too), with the
 * shared `wire` section and the bot's emergency action ("review" does nothing more).
 */
type PolicySettings = { wire: WireSettingsBase & { emergency_action: string } }

export type Candidate = {
  rule: string
  action: WireTriggerAction
  /** Symbols the trigger is about; [] = market-wide. */
  symbols: string[]
  /** Opens a position if acted on: needs confirmation. */
  entry: boolean
  /** Also run the owner's emergency action on the held symbols. */
  emergency?: boolean
  /** Also send an alert. */
  alert?: boolean
  /** Send an alert when the market is closed and the trigger has to wait (stocks). */
  alertWhenClosed?: boolean
}

export type RulesContext<S extends PolicySettings> = { held: ReadonlySet<string>; universe: ReadonlySet<string>; settings: S; now: Date; hasRecentNews: (symbol: string) => Promise<boolean> }

export type Rules<C extends string, S extends PolicySettings> = (item: WireItemDoc<C>, ctx: RulesContext<S>) => Promise<Candidate[]>

export type PolicyDeps<C extends string, S extends PolicySettings> = {
  col: { wireTriggers: Collection<WireTriggerDoc>; wireItems: Collection<WireItemDoc<C>> }
  bus: WireEventSink<C>
  log: Logger
  settings: () => S
  rules: Rules<C, S>
  engine: () => { running: boolean; killSwitch: boolean }
  /** Stocks: whether event cycles can run now (regular session, past the opening buffer, before the close). */
  session?: () => { open: boolean; reason: string }
  held: () => string[]
  universe: () => string[]
  budget: Pick<AiBudget, "canAfford" | "estimate">
  /** Hands a focus to the engine: started now, or waiting behind a running cycle or the minimum gap. */
  request: (focus: EventFocus) => "fired" | "queued"
  markNotable: (ids: string[], reason: "triggered") => Promise<unknown>
  /** Runs the owner's emergency action on a held symbol; returns what was done. */
  emergency: (symbol: string, focus: EventFocus) => Promise<string>
  alert: (title: string, message: string) => Promise<void>
  now?: () => Date
}

const DAY_MS = 86_400_000
/** News older than this (by the source's own date) never triggers, even when we only just saw it. */
const MAX_PUBLISHED_AGE_MS = 2 * 3_600_000
/** An anomaly counts as explained by news on its symbol within this window. */
const EXPLAIN_MS = 2 * 3_600_000

export type GateResult = { status: WireTriggerStatus; reason: string }

export class WirePolicy<C extends string, S extends PolicySettings> {
  /** item|rule → last outcome, so a confirmation re-checks only entries held back as unconfirmed. */
  private readonly evaluated = new Map<string, string>()
  private readonly now: () => Date

  constructor(private readonly d: PolicyDeps<C, S>) {
    this.now = d.now ?? (() => new Date())
  }

  /** News explains a move; our own readings (funding, odds, attention: `meta.metric`, see metrics.ts) only describe it. */
  private hasRecentNews = async (symbol: string) => {
    const now = this.now().getTime()
    const n = await this.d.col.wireItems.countDocuments(
      { symbols: symbol, kind: { $nin: ["anomaly", "calendar"] }, "meta.metric": { $exists: false }, first_seen_at: { $gte: new Date(now - EXPLAIN_MS), $lte: new Date(now + EXPLAIN_MS) } },
      { limit: 1 },
    )
    return n > 0
  }

  async candidates(item: WireItemDoc<C>) {
    return this.d.rules(item, { held: new Set(this.d.held()), universe: new Set(this.d.universe()), settings: this.d.settings(), now: this.now(), hasRecentNews: this.hasRecentNews })
  }

  /** The gates, in order. `dryRun` skips the side effects (used by wire.replay). */
  async gate(item: WireItemDoc<C>, c: Candidate, { backfill, dryRun = false }: { backfill: boolean; dryRun?: boolean }): Promise<GateResult> {
    const w = this.d.settings().wire
    const now = this.now()
    if (w.mode === "off") return { status: "suppressed", reason: "wire is off" }
    if (backfill || item.meta.backfill === true) return { status: "suppressed", reason: "backfill: items from a source's first poll never trigger" }
    if (now.getTime() - item.first_seen_at.getTime() > w.trigger_max_age_minutes * 60_000) return { status: "suppressed", reason: `stale: first seen more than ${w.trigger_max_age_minutes} min ago` }
    if (now.getTime() - item.published_at.getTime() > MAX_PUBLISHED_AGE_MS) return { status: "suppressed", reason: "old news: published more than 2 h ago" }
    if (c.entry && w.entry_confirmation && !isConfirmed(item)) return { status: "suppressed", reason: "unconfirmed: entries need a tier-1 source, two independent outlets, or a matching price move" }
    if (w.mode === "shadow") return { status: "shadow", reason: "shadow mode: logged, not acted on" }
    if (c.action === "alert_only") return { status: "fired", reason: "alert" }
    const engine = this.d.engine()
    if (!engine.running || engine.killSwitch) return { status: "suppressed", reason: engine.killSwitch ? "kill switch engaged" : "engine is paused" }
    const session = this.d.session?.()
    if (session && !session.open) return { status: "suppressed", reason: `market closed: ${session.reason}` }
    const keys = c.symbols.length ? c.symbols : ["MARKET"]
    const since = new Date(now.getTime() - w.symbol_cooldown_minutes * 60_000)
    const recent = await this.d.col.wireTriggers.findOne({ status: { $in: ["fired", "queued"] }, action: { $nin: ["alert_only", "emergency"] }, at: { $gte: since }, symbols: c.symbols.length ? { $in: c.symbols } : { $size: 0 } })
    if (recent) return { status: "suppressed", reason: `cooldown: ${keys.join(", ")} triggered at ${recent.at.toISOString().slice(11, 16)}Z` }
    const counted = { status: { $in: ["fired", "queued"] as WireTriggerStatus[] }, action: { $nin: ["alert_only", "emergency"] as WireTriggerAction[] } }
    const [hour, day] = await Promise.all([
      this.d.col.wireTriggers.countDocuments({ ...counted, at: { $gte: new Date(now.getTime() - 3_600_000) } }),
      this.d.col.wireTriggers.countDocuments({ ...counted, at: { $gte: new Date(`${utcDay(now)}T00:00:00Z`) } }),
    ])
    if (hour >= w.max_event_cycles_per_hour) return { status: "suppressed", reason: `hourly cap (${w.max_event_cycles_per_hour}) reached` }
    if (day >= w.max_event_cycles_per_day) return { status: "suppressed", reason: `daily cap (${w.max_event_cycles_per_day}) reached` }
    const estimate = (w.event_research === "x_verify" ? await this.d.budget.estimate("research_gap") : 0) + (await this.d.budget.estimate("decision"))
    const afford = await this.d.budget.canAfford(estimate)
    if (!afford.ok) return { status: "suppressed", reason: `AI budget: $${afford.status.remaining_usd.toFixed(2)} left` }
    return { status: dryRun ? "fired" : "queued", reason: "ok" }
  }

  /** Called by the wire for every stored item and every confirmation. Never throws. */
  async onItem(e: { item: WireItemDoc<C>; backfill: boolean; confirmation: boolean }) {
    try {
      if (e.item.severity < this.d.settings().wire.thresholds.annotate) return
      for (const c of await this.candidates(e.item)) {
        const key = `${e.item._id}|${c.rule}`
        const before = this.evaluated.get(key)
        // A confirmation only re-checks an entry that was held back for lack of one.
        if (before && !(e.confirmation && before.startsWith("unconfirmed"))) continue
        const gate = await this.gate(e.item, c, { backfill: e.backfill })
        this.evaluated.set(key, gate.reason)
        if (this.evaluated.size > 20_000) this.evaluated.delete(this.evaluated.keys().next().value!)
        // Backfill is the expected state after every restart: not worth an audit row.
        if (gate.reason.startsWith("backfill")) continue
        await this.act(e.item, c, gate)
      }
    } catch (error) {
      this.d.log.warn("wire policy failed", { item: e.item._id, error: errorMessage(error) })
    }
  }

  private async act(item: WireItemDoc<C>, c: Candidate, gate: GateResult) {
    const s = this.d.settings()
    const now = this.now()
    const doc: WireTriggerDoc = {
      _id: randomUUID(),
      at: now,
      rule: c.rule,
      action: c.action,
      status: gate.status,
      reason: gate.reason,
      item_ids: [item._id],
      symbols: c.symbols,
      severity: item.severity,
      cycle_id: null,
      queue_wait_ms: null,
      expires_at: new Date(now.getTime() + s.wire.retention_days * DAY_MS),
    }
    const go = gate.status === "queued"
    const focus = (symbol: string | null): EventFocus => ({ symbol, rule: c.rule, action: c.action, severity: item.severity, polarity: item.polarity, item_ids: [item._id], trigger_id: doc._id, headline: item.title })
    if (go) {
      // One request per symbol (the engine's queue merges by symbol); market-wide reviews have none.
      const results = (c.symbols.length ? c.symbols : [null]).map((sym) => this.d.request(focus(sym)))
      doc.status = results.includes("fired") ? "fired" : "queued"
      doc.reason = doc.status === "fired" ? "event cycle started" : "queued behind a running cycle or the minimum gap"
    } else if (gate.status === "fired" && c.action === "alert_only") {
      doc.reason = "alert sent"
    }
    await this.d.col.wireTriggers.insertOne(doc)
    const acted = doc.status === "fired" || doc.status === "queued"
    this.d.bus.emit(
      "wire.trigger",
      { trigger_id: doc._id, rule: doc.rule, action: doc.action, status: doc.status, reason: doc.reason, symbols: doc.symbols, severity: doc.severity, item_ids: doc.item_ids },
      { summary: `${acted ? "Trigger" : `Trigger ${doc.status}`}: ${doc.rule} on ${doc.symbols.join(", ") || "the market"}${acted ? "" : ` (${doc.reason})`}`, level: acted ? "info" : "debug", instrument: doc.symbols[0] },
    )
    if (acted) await this.d.markNotable([item._id], "triggered")
    const closed = gate.reason.startsWith("market closed")
    if ((acted && c.alert) || (closed && c.alertWhenClosed)) {
      await this.d.alert(`News: ${c.rule.replace(/_/g, " ")}${closed ? " (market closed)" : ""}`, `${item.title}${item.url ? `\n${item.url}` : ""}`)
    }
    if (go && c.emergency && s.wire.emergency_action !== "review") {
      for (const symbol of c.symbols) {
        const note = await this.d.emergency(symbol, focus(symbol)).catch((e) => `failed: ${errorMessage(e)}`)
        await this.d.col.wireTriggers.insertOne({ ...doc, _id: randomUUID(), action: "emergency", status: "fired", reason: `${s.wire.emergency_action}: ${note}`, symbols: [symbol] })
      }
    }
  }

  /** What the policy would do with a stored item now (owner command wire.replay). No side effects. */
  async replay(item: WireItemDoc<C>): Promise<string> {
    const cands = await this.candidates(item)
    if (!cands.length) return `no rule applies (severity ${item.severity}, ${item.category}, polarity ${item.polarity})`
    const lines: string[] = []
    for (const c of cands) {
      const g = await this.gate(item, c, { backfill: false, dryRun: true })
      lines.push(`${c.rule} → ${c.action} on ${c.symbols.join(", ") || "the market"}: ${g.status === "fired" ? "would fire" : `${g.status} (${g.reason})`}`)
    }
    return lines.join("; ")
  }

  /** Fired or queued triggers today, for the heartbeat. */
  async triggersToday() {
    return this.d.col.wireTriggers.countDocuments({ status: { $in: ["fired", "queued"] }, at: { $gte: new Date(`${utcDay(this.now())}T00:00:00Z`) } })
  }
}
