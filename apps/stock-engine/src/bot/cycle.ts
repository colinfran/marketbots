import { randomUUID } from "node:crypto"
import { affordCycle, type ResearchPlan } from "@mb/engine-kit/ai/budget"
import { errorMessage } from "@mb/engine-kit/log"
import type { CycleDoc, CycleKind, CycleStatus, ResearchResult } from "@mb/stock-core/db"
import type { CycleState } from "@mb/stock-core/events"
import { roundTo } from "@mb/stock-core/math"
import { botReportSchema, normalizeReport, type BotReport } from "@mb/stock-core/report"
import type { Phase } from "@mb/stock-core/settings"
import { addDays, formatTime } from "@mb/stock-core/time"
import type { EventFocus } from "@mb/stock-core/wire"
import { decisionPrompt, decisionSystemPrompt, eventSection, PROMPT_VERSION, researchGapFillPrompt, researchPrompt } from "../ai/prompts"
import { repairReport } from "../ai/repair"
import { buildContext } from "../market/context"
import { snapshotPrice } from "../market/indicators"
import type { EngineContext } from "./context"
import { executeDecisions } from "./execute"
import { enforceOvernightRules, ensureProtection, recordDailyStats } from "./maintenance"
import { syncOrders } from "./orders"
import { normalizeSeedDecisions, seedExits, seedOrderOf, type SeedOutcome } from "./seed"
import type { Session } from "./session"
import { writeAccountSnapshot } from "./site-data"
import { buildDossier, type Dossier } from "../wire/dossier"

/**
 * One cycle = one phase of the trading day:
 *   context (broker data + option chains) → research (Grok + web/X, streamed)
 *   → decision (Grok, structured, streamed) → risk checks + execution → record
 *
 * Every step is written to the cycle document and streamed as an event, so the dashboard shows
 * the whole thing as it happens: what data was gathered, each search and source, the memo being
 * written, the market read, each decision with every risk check, and the orders.
 */

export type CycleOutcome = {
  cycleId: string
  phase: Phase
  status: CycleStatus
  headline: string | null
  /** Seed cycles only: what was bought and what happened to each order. */
  seed?: SeedOutcome
}

export type CycleOptions = {
  phase: Phase
  session: Session
  trigger: string
  kind?: CycleKind
  /** Owner-requested tickers to evaluate. */
  requested?: string[]
  /** Why new entries are blocked right now (kill switch engaged mid-cycle), or null. */
  entriesBlocked?: () => string | null
  /** The owner's one-time seed: an intraday cycle that only buys long-term core holdings. */
  seed?: { id: string; amountUsd: number }
  /** Event cycles: what the news engine saw (merged by symbol). */
  events?: EventFocus[]
}

export type { ResearchPlan }

/**
 * Which Grok research a cycle runs. Full whenever the wire is off or
 * unhealthy. auto runs the gap-fill whenever the dossier has a gap on anything the cycle could
 * trade, or on the market (an unexplained move, an unconfirmed high-severity item), in any phase,
 * and skips Grok otherwise. The owner's one-time seed always gets the full research.
 */
export const researchPlan = (
  ctx: Pick<EngineContext, "settings">,
  { isEvent, isSeed = false, wireHealthy, dossier }: { isEvent: boolean; isSeed?: boolean; wireHealthy: boolean; dossier: Dossier | null },
): ResearchPlan => {
  const w = ctx.settings.current.wire
  if (isSeed) return { kind: "full", reason: "one-time seed" }
  if (isEvent) return w.event_research === "none" ? { kind: "none", reason: "event cycle with event_research none: the dossier is the evidence" } : { kind: "gap", reason: "event check (x_verify)" }
  if (!dossier) return { kind: "full", reason: "news engine off" }
  if (!wireHealthy) return { kind: "full", reason: "news engine unhealthy" }
  if (w.research_mode === "full") return { kind: "full", reason: "research_mode full" }
  if (w.research_mode === "gap_fill") return { kind: "gap", reason: "research_mode gap_fill" }
  if (dossier.unexplained.length || dossier.unconfirmed.length) return { kind: "gap", reason: `${dossier.unexplained.length} unexplained moves, ${dossier.unconfirmed.length} unconfirmed items` }
  return { kind: "none", reason: "no unexplained moves or unconfirmed items in our feeds" }
}

/** How old a failed attempt's research may be for the scheduler's retry of the phase to reuse it. */
const RESEARCH_REUSE_MINUTES = 20

/**
 * The research a scheduled cycle can reuse instead of paying for it again: the previous scheduled
 * attempt of the same phase failed after its research (so no report holds it), with the same mode,
 * at most RESEARCH_REUSE_MINUTES ago.
 */
const reusableResearch = async (
  ctx: Pick<EngineContext, "col">,
  { cycleId, day, phase, mode, now = new Date() }: { cycleId: string; day: string; phase: Phase; mode: ResearchResult["mode"]; now?: Date },
) => {
  const last = await ctx.col.cycles.findOne({ _id: { $ne: cycleId }, trading_day: day, phase, kind: "scheduled" }, { sort: { started_at: -1 }, projection: { status: 1, research: 1 } })
  const research = last?.status === "failed" ? last.research : undefined
  if (!last || !research || research.mode !== mode || now.getTime() - research.at.getTime() > RESEARCH_REUSE_MINUTES * 60_000) return null
  return { cycleId: last._id, research }
}

/** "10:03 ET": wire times in stock prompts. */
const etTime = (d: Date) => formatTime(d)

/** Seed cycles look at the index ETFs the owner leaned toward, with full technicals. */
const SEED_REFERENCE = ["SPY", "QQQ"]

export const runCycle = async (
  ctx: EngineContext,
  { phase, session, trigger, kind, requested: asked = [], entriesBlocked = () => null, seed, events = [] }: CycleOptions,
): Promise<CycleOutcome> => {
  const isEvent = kind === "event"
  const eventSymbols = events.map((e) => e.symbol).filter((s): s is string => !!s)
  const requested = seed ? [...new Set([...asked, ...SEED_REFERENCE])] : isEvent ? [...new Set([...asked, ...eventSymbols])] : asked
  const { col, bus, alerts, log } = ctx
  const settings = ctx.settings.current
  const cycleId = randomUUID()
  const started = Date.now()
  const doc: CycleDoc = {
    _id: cycleId,
    phase,
    trading_day: session.day,
    trigger,
    ...(kind ? { kind } : {}),
    ...(isEvent ? { wire_trigger_id: events[0]?.trigger_id ?? null, wire_item_ids: [...new Set(events.flatMap((e) => e.item_ids))] } : {}),
    status: "running",
    started_at: new Date(),
    finished_at: null,
    duration_ms: null,
    error: null,
    report_id: null,
    steps: [],
    ai_cost_usd: 0,
    settings_version: ctx.settings.version,
  }
  await col.cycles.insertOne(doc)
  const meta = { cycle_id: cycleId }
  bus.emit("cycle.started", { cycle_id: cycleId, phase, trigger }, { summary: seed ? `One-time seed started ($${seed.amountUsd.toLocaleString("en-US")})` : `${label(phase)} cycle started (${trigger})`, ...meta })
  if (seed) bus.emit("seed.started", { seed_id: seed.id, cycle_id: cycleId, amount_usd: seed.amountUsd }, { summary: `One-time seed of $${seed.amountUsd.toLocaleString("en-US")} started`, ...meta })
  const seedOutcome: SeedOutcome | undefined = seed ? { allocations: [], orders: [], notes: [], rationale: null, executed: 0 } : undefined

  const state = (s: CycleState, detail?: string) => {
    ctx.setCycleState(s, detail)
    bus.emit("cycle.state", { cycle_id: cycleId, state: s, ...(detail ? { detail } : {}) }, { summary: detail ? `${STATE_TEXT[s]}: ${detail}` : STATE_TEXT[s], level: "debug", ...meta })
  }

  const step = async <T>(name: string, fn: () => Promise<T>, detail?: (value: T) => string): Promise<T> => {
    try {
      const value = await fn()
      const text = detail?.(value) ?? null
      await col.cycles.updateOne({ _id: cycleId }, { $push: { steps: { name, at: new Date(), ok: true, detail: text } } })
      bus.emit("cycle.step", { cycle_id: cycleId, name, ok: true, detail: text }, { summary: text ? `${name}: ${text}` : name, ...meta })
      return value
    } catch (error) {
      const message = errorMessage(error).slice(0, 500)
      await col.cycles.updateOne({ _id: cycleId }, { $push: { steps: { name, at: new Date(), ok: false, detail: message } } })
      bus.emit("cycle.step", { cycle_id: cycleId, name, ok: false, detail: message }, { summary: `${name} failed: ${message}`, level: "warn", ...meta })
      throw error
    }
  }

  let aiCost = 0
  // The scheduler retries its own phases when they fail: their research is kept for the retry.
  const retriable = kind === "scheduled"
  let keptResearch: CycleDoc["research"] | null = null
  const finish = async (status: CycleStatus, fields: Partial<CycleDoc> = {}) => {
    await col.cycles.updateOne({ _id: cycleId }, { $set: { status, finished_at: new Date(), duration_ms: Date.now() - started, ai_cost_usd: roundTo(aiCost, 4), ...fields } })
    ctx.setCycleState("idle")
  }
  const skip = async (reason: string): Promise<CycleOutcome> => {
    await finish("skipped", { error: reason })
    bus.emit("cycle.skipped", { phase, reason }, { summary: `${label(phase)} cycle skipped: ${reason}`, level: "warn", ...meta })
    return { cycleId, phase, status: "skipped", headline: null, seed: seedOutcome }
  }
  /** Code-level close rules run even when the AI can't. */
  const closeFallback = async () => {
    if (phase !== "close") return []
    return step("overnight rules", () => enforceOvernightRules(ctx), (notes) => (notes.length ? notes.join("; ") : "nothing to sell")).catch((e) => [`fallback failed: ${errorMessage(e)}`])
  }

  try {
    if (phase === "postmarket") {
      state("reviewing", "daily stats")
      await step("daily stats", () => recordDailyStats(ctx, session.day))
    }

    state("gathering_data", "account, positions, quotes, technicals, news")
    const { context, chains } = await step("context", () => buildContext(ctx, phase, session, { requested, scope: isEvent ? "event" : "full" }), ({ context: c }) =>
      [
        `${c.positions.length} stock positions`,
        `${c.options.positions.length} options positions`,
        `${c.instruments.length} instruments`,
        `${c.news.length} headlines`,
        ...(c.options.chains.length ? [`option chains for ${c.options.chains.map((x) => x.underlying).join(", ")}`] : []),
      ].join(", "),
    )
    bus.emit(
      "context.built",
      {
        cycle_id: cycleId,
        positions: context.positions.length,
        option_positions: context.options.positions.length,
        instruments: context.instruments.length,
        headlines: context.news.length,
        equity: context.risk.equity,
        day_pnl_pct: context.risk.day_pnl_pct,
        new_buys_allowed: context.risk.new_buys_allowed,
        flags: context.risk.notes,
      },
      { summary: `Broker data ready: equity $${context.risk.equity.toLocaleString("en-US")}, day ${context.risk.day_pnl_pct >= 0 ? "+" : ""}${context.risk.day_pnl_pct}%, new buys ${context.risk.new_buys_allowed ? "allowed" : "blocked"}`, ...meta },
    )
    if (context.options.chains.length) {
      bus.emit(
        "options.chains",
        { cycle_id: cycleId, underlyings: context.options.chains.map((c) => ({ symbol: c.underlying, contracts: c.contracts.length })) },
        { summary: `Option chains: ${context.options.chains.map((c) => `${c.underlying} (${c.contracts.length})`).join(", ")}`, ...meta },
      )
    }

    if (!ctx.ai.available) {
      await closeFallback()
      return await skip("AI is disabled (AI_GATEWAY_API_KEY not set)")
    }

    // ─── Our research: the wire dossier replaces the broker headlines ──
    const wire = ctx.wire && settings.wire.mode !== "off" ? ctx.wire : null
    const subjects = [...new Set([...requested, ...context.positions.map((p) => p.symbol), ...context.options.positions.map((p) => p.underlying), ...context.instruments.map((i) => i.symbol)])]
    const dossier = wire
      ? await buildDossier(col, { symbols: subjects, since: new Date(Date.now() - 24 * 3_600_000), now: new Date(), price: (s) => ctx.prices.fresh(s, 5 * 60_000), timeLabel: etTime, reviewThreshold: settings.wire.thresholds.review }).catch((error) => {
          log.warn("wire dossier failed", { error: errorMessage(error) })
          return null
        })
      : null
    if (dossier) {
      context.news = []
      bus.emit("wire.dossier", { cycle_id: cycleId, rows: dossier.rows, total: dossier.items.length }, { summary: `Our research: ${dossier.items.length} items`, ...meta })
    }
    const eventText = isEvent ? eventSection(events) : undefined
    const wireHealthy = !!wire && wire.healthy()
    // Scheduled cycles leave the event reserve alone; event cycles (and the owner's seed) may use the whole budget.
    const reservePct = !isEvent && !seed && settings.wire.mode === "live" ? settings.wire.event_budget_reserve_pct : 0
    // Research the budget can't pay for is dropped when the decision still fits and our feeds are up.
    const { plan, afford } = await affordCycle(ctx.budget, researchPlan(ctx, { isEvent, isSeed: !!seed, wireHealthy, dossier }), { reservePct, feedsUp: wireHealthy && !!dossier })
    if (!afford.ok) {
      bus.emit("budget.exhausted", { spent_usd: afford.status.spent_usd, budget_usd: afford.status.budget_usd }, { summary: `AI budget exhausted ($${afford.status.spent_usd.toFixed(2)} of $${afford.status.budget_usd}); no AI cycles until midnight ET`, level: "warn", ...meta })
      await alerts.send("warning", "Daily AI budget exhausted", `Spent $${afford.status.spent_usd.toFixed(2)} of $${afford.status.budget_usd}. No new AI decisions until midnight ET; stops and options exits keep running.`, { key: `budget|${session.day}` })
      await closeFallback()
      return await skip("daily AI budget exhausted")
    }

    // ─── Research ───────────────────────────────────────────────────────
    const researchId = randomUUID()
    const focus = [...new Set([...requested, ...context.positions.map((p) => p.symbol), ...context.options.positions.map((p) => p.underlying)])]
    const mode = plan.kind === "full" ? "full" : plan.kind === "gap" ? "gap_fill" : "skipped"
    const reuse = retriable && plan.kind !== "none" ? await reusableResearch(ctx, { cycleId, day: session.day, phase, mode }) : null
    const researching = plan.kind !== "none" && !reuse
    if (researching) {
      state("researching", focus.length ? focus.join(", ") : "the market")
      bus.emit("research.started", { cycle_id: cycleId, research_id: researchId, phase, model: settings.ai.models.research, focus }, { summary: plan.kind === "gap" ? "Checking X and gaps our feeds left" : `Researching the ${label(phase).toLowerCase()} with web + X search`, ...meta })
    }
    const skipped: ResearchResult = { memo: "", sources: [], queries: [], model: settings.ai.models.research, x_search: false, duration_ms: 0, error: null, usage: { input: 0, output: 0, total: 0 }, cost_usd: 0 }
    const research = await step(
      "research",
      async () =>
        reuse
          ? { ...reuse.research, cost_usd: 0 }
          : plan.kind === "none"
            ? skipped
            : ctx.ai.research({
          cycleId,
          model: settings.ai.models.research,
          fallback: settings.ai.models.fallback,
          prompt: plan.kind === "full" ? researchPrompt(phase, context, settings, { seed }) : researchGapFillPrompt(phase, context, { wire: dossier?.text ?? "", event: eventText }),
          task: plan.kind === "gap" ? "research_gap" : "research",
          xSearch: settings.ai.x_search,
          // Premarket looks back to yesterday's session; later phases only care about today.
          fromDate: phase === "premarket" ? addDays(session.day, -1) : session.day,
          timeoutMs: (isEvent ? settings.wire.event_research_timeout_seconds : settings.ai.research_timeout_seconds) * 1000,
          signal: ctx.signal,
          progress: {
            onQuery: (query, tool) => bus.emit("research.query", { research_id: researchId, query, tool }, { summary: `${tool === "x_search" ? "Searching X" : "Searching the web"}: ${query}`, level: "debug", ...meta }),
            onSource: (s) => bus.emit("research.source", { research_id: researchId, title: s.title ?? s.url, url: s.url, domain: s.domain ?? "" }, { summary: `Reading: ${s.title ?? s.url}`, level: "debug", ...meta }),
            onText: (chars, excerpt) => bus.emit("research.progress", { research_id: researchId, chars, excerpt }, { summary: `Writing the research memo (${chars.toLocaleString("en-US")} chars)`, level: "debug", ...meta }),
            onReasoning: settings.ai.stream_reasoning ? (chars, excerpt) => bus.emit("ai.reasoning", { cycle_id: cycleId, task: "research", chars, excerpt }, { summary: "Reasoning (research)", level: "debug", ...meta }) : undefined,
          },
        }),
      (r) =>
        reuse
          ? `reused from the failed attempt at ${etTime(reuse.research.at)}, ${r.sources.length} sources`
          : plan.kind === "none"
            ? `skipped: ${plan.reason}`
            : r.error
              ? `failed: ${r.error}`
              : `${plan.kind === "gap" ? "gap-fill, " : ""}${r.sources.length} sources, ${r.queries.length} searches${r.x_search ? "" : " (web only)"}, ${Math.round(r.duration_ms / 1000)}s`,
    )
    aiCost += research.cost_usd ?? 0
    await col.cycles.updateOne({ _id: cycleId }, { $set: { research_plan: plan, ...(plan.kind === "none" ? { research_skip_reason: plan.reason } : {}) } })
    if (researching) {
      bus.emit(
        "research.completed",
        { research_id: researchId, sources: research.sources.length, queries: research.queries.length, duration_ms: research.duration_ms, cost_usd: roundTo(research.cost_usd ?? 0, 4), error: research.error },
        { summary: research.error ? `Research failed: ${research.error}` : `Research done: ${research.sources.length} sources, ${research.queries.length} searches`, level: research.error ? "warn" : "info", ...meta },
      )
    }
    if (research.error) {
      await alerts.send("warning", `Research failed (${phase}), continuing with broker data only`, research.error, { fields: { Model: research.model, Cycle: cycleId }, path: `/journal/${session.day}` })
    }
    const researchDoc: ResearchResult = {
      memo: research.memo,
      sources: research.sources,
      queries: research.queries,
      model: research.model,
      x_search: research.x_search,
      duration_ms: research.duration_ms,
      error: research.error,
      usage: research.usage,
      cost_usd: roundTo(research.cost_usd ?? 0, 4),
      mode,
      ...(reuse ? { reused_from: reuse.cycleId } : {}),
      ...(dossier ? { dossier: dossier.rows } : {}),
    }
    if (retriable && research.memo && !research.error) keptResearch = { ...researchDoc, at: reuse?.research.at ?? new Date() }

    // ─── Decision ───────────────────────────────────────────────────────
    state("deciding", settings.ai.models.decision)
    bus.emit("ai.decision.started", { cycle_id: cycleId, model: settings.ai.models.decision }, { summary: `Deciding with ${settings.ai.models.decision}`, ...meta })
    const allowDecisions = phase === "intraday" || phase === "close"
    const decision = await step(
      "decision",
      async () => {
        const result = await ctx.ai.structured({
          task: "decision",
          cycleId,
          model: settings.ai.models.decision,
          fallback: settings.ai.models.fallback,
          system: decisionSystemPrompt(settings),
          prompt: decisionPrompt(phase, context, research, settings, { seed, wire: dossier ? dossier.text : undefined, event: eventText, researchSkipped: plan.kind === "none" ? plan.reason : null }),
          schema: botReportSchema,
          name: "bot_report",
          description: "StockMarketBot cycle report: market read, catalysts, watchlist, decisions (stocks and options), risks, lessons.",
          repair: repairReport,
          timeoutMs: (isEvent ? settings.wire.event_decision_timeout_seconds : settings.ai.decision_timeout_seconds) * 1000,
          signal: ctx.signal,
          progress: {
            onPartial: (chars, partial) => {
              const p = partial as { headline?: unknown; decisions?: unknown[] } | undefined
              const headline = typeof p?.headline === "string" ? p.headline.slice(0, 160) : null
              const n = Array.isArray(p?.decisions) ? p.decisions.length : 0
              bus.emit("ai.decision.progress", { cycle_id: cycleId, chars, headline, decisions: n }, { summary: headline ? `Writing: “${headline}”${n ? ` · ${n} decisions so far` : ""}` : `Writing the decision (${chars.toLocaleString("en-US")} chars)`, level: "debug", ...meta })
            },
            onReasoning: settings.ai.stream_reasoning ? (chars, excerpt) => bus.emit("ai.reasoning", { cycle_id: cycleId, task: "decision", chars, excerpt }, { summary: "Reasoning (decision)", level: "debug", ...meta }) : undefined,
          },
        })
        return { ...result, report: normalizeReport(result.output as BotReport, { allowDecisions }) }
      },
      (d) => `${d.report.decisions.length} decisions (attempt ${d.attempts}${d.repaired ? ", repaired in code" : ""}): ${d.report.headline}`,
    ).catch(async (error) => {
      bus.emit("ai.decision.failed", { cycle_id: cycleId, error: errorMessage(error).slice(0, 500) }, { summary: "AI decision failed; no trades this cycle", level: "warn", ...meta })
      throw error
    })
    aiCost += decision.cost_usd
    const report = seed && seedOutcome ? await prepareSeed(ctx, decision.report, seed.amountUsd, context.risk.equity, new Set(context.positions.map((p) => p.symbol)), seedOutcome) : decision.report
    // Wire items whose URLs the AI listed as sources now count as notable (they reach the Live page).
    if (wire && dossier) {
      const cited = report.sources.flatMap((s) => (dossier.idByUrl.has(s.url) ? [dossier.idByUrl.get(s.url)!] : []))
      if (cited.length) await wire.markNotable(cited, "cited").catch((e) => log.warn("marking cited items failed", { error: errorMessage(e) }))
    }
    bus.emit("ai.decision.completed", { cycle_id: cycleId, decisions: report.decisions.length, attempts: decision.attempts, repaired: decision.repaired, cost_usd: roundTo(decision.cost_usd, 4) }, { summary: `${report.decisions.length} decisions${decision.repaired ? " (repaired in code)" : ""}`, ...meta })
    bus.emit(
      "ai.report",
      {
        cycle_id: cycleId,
        phase,
        headline: report.headline,
        summary: report.summary,
        sentiment: report.market.sentiment,
        regime: report.market.regime,
        stance: report.market.stance,
        confidence: report.market.confidence,
        key_drivers: report.market.key_drivers,
        watchlist: report.watchlist.map((w) => w.symbol),
      },
      { summary: report.headline, ...meta },
    )

    // ─── Execution ──────────────────────────────────────────────────────
    const reportId = randomUUID()
    state("executing", `${report.decisions.length} decisions`)
    const execution = await step(
      "execution",
      () => executeDecisions(ctx, { cycleId, reportId, phase, report, chains, entriesBlocked, triggerKind: kind, wireItemIds: isEvent ? eventItemsBySymbol(events) : undefined }),
      (e) => `${e.executed} executed, ${e.rejected} rejected, ${e.failed} failed, ${e.noop} no-op`,
    )
    if (seedOutcome) {
      const buys = await col.decisions.find({ cycle_id: cycleId, action: "buy" }).toArray()
      seedOutcome.orders = buys.map(seedOrderOf)
      seedOutcome.executed = buys.filter((d) => d.status === "executed").length
    }
    if (execution.failed > 0) {
      await alerts.send("error", `${execution.failed} order${execution.failed > 1 ? "s" : ""} failed (${phase})`, execution.notes.join("\n") || "See the report for details.", { fields: { Cycle: cycleId }, path: `/research/${reportId}` })
    }
    // Grok is told the overnight rules; this makes sure a "hold" or a forgotten position can't break them.
    await closeFallback()
    if (phase === "intraday" || phase === "close") {
      state("protecting")
      await step("protection", async () => {
        await syncOrders(col, ctx.alpaca)
        return ensureProtection(ctx)
      }, (notes) => (notes.length ? notes.join("; ") : "all positions protected"))
      await writeAccountSnapshot(ctx).catch((e) => log.warn("account snapshot failed", { error: errorMessage(e) }))
    }

    await col.reports.insertOne({
      _id: reportId,
      cycle_id: cycleId,
      phase,
      trading_day: session.day,
      created_at: new Date(),
      model: decision.model,
      attempts: decision.attempts,
      repaired: decision.repaired,
      research: researchDoc,
      report,
      context,
      execution,
      usage: decision.usage,
      cost_usd: roundTo(aiCost, 4),
      settings_version: ctx.settings.version,
    })
    await finish("succeeded", { report_id: reportId })
    bus.emit(
      "cycle.completed",
      {
        cycle_id: cycleId,
        phase,
        report_id: reportId,
        duration_ms: Date.now() - started,
        decisions: report.decisions.length,
        executed: execution.executed,
        rejected: execution.rejected,
        failed: execution.failed,
        ai_cost_usd: roundTo(aiCost, 4),
        headline: report.headline,
      },
      { summary: `${label(phase)} cycle done: ${execution.executed} executed, ${execution.rejected} rejected (${Math.round((Date.now() - started) / 1000)}s, $${aiCost.toFixed(2)} AI)`, ...meta },
    )
    log.info("cycle completed", { cycle_id: cycleId, phase, prompt_version: PROMPT_VERSION, executed: execution.executed })
    return { cycleId, phase, status: "succeeded", headline: report.headline, seed: seedOutcome }
  } catch (error) {
    let message = errorMessage(error)
    log.error("cycle failed", { cycle_id: cycleId, phase, error: message })
    // Never leave intraday trades open overnight just because the AI step failed.
    const notes = await closeFallback()
    if (notes.length) message += ` | fallback: ${notes.join("; ")}`
    await finish("failed", { error: message.slice(0, 1000), ...(keptResearch ? { research: keptResearch } : {}) })
    bus.emit("cycle.failed", { cycle_id: cycleId, phase, error: message.slice(0, 500) }, { summary: `${label(phase)} cycle failed: ${message.slice(0, 200)}`, level: "error", ...meta })
    await alerts.send("error", `${phase} cycle failed`, message, { fields: { Day: session.day, Cycle: cycleId, Duration: `${Math.round((Date.now() - started) / 1000)}s` }, path: `/journal/${session.day}` })
    return { cycleId, phase, status: "failed", headline: null, seed: seedOutcome ? { ...seedOutcome, notes: [...seedOutcome.notes, message.slice(0, 300)] } : undefined }
  }
}

/**
 * Seed cycles: keep only Grok's core buys (capped at the amount + 5%), give each exit levels a
 * long-term hold can live with, and record the allocation. Execution then applies every normal
 * risk check.
 */
const prepareSeed = async (ctx: EngineContext, report: BotReport, amountUsd: number, equity: number, held: ReadonlySet<string>, outcome: SeedOutcome): Promise<BotReport> => {
  const { decisions, notes } = normalizeSeedDecisions(report.decisions, { held, equity, amountUsd })
  outcome.notes.push(...notes)
  outcome.rationale = report.summary
  const snapshots = decisions.length ? await ctx.alpaca.getSnapshots(decisions.map((d) => d.symbol)).catch(() => ({}) as Record<string, never>) : {}
  const prepared = decisions.map((d) => {
    const price = snapshotPrice(snapshots[d.symbol])
    if (price === null) return d
    const exits = seedExits(d, price, ctx.settings.current.risk)
    outcome.notes.push(...exits.notes)
    return { ...d, stop_loss: exits.stop_loss, take_profit: exits.take_profit }
  })
  outcome.allocations = prepared.map((d) => ({
    symbol: d.symbol,
    weight_pct: amountUsd > 0 ? roundTo((((d.allocation_pct ?? 0) / 100) * equity * 100) / amountUsd, 1) : 0,
    notional_usd: roundTo(((d.allocation_pct ?? 0) / 100) * equity, 2),
    thesis: d.rationale,
  }))
  return { ...report, decisions: prepared }
}

const label = (phase: Phase) => ({ premarket: "Premarket", intraday: "Intraday", close: "Closing", postmarket: "Postmarket" })[phase]

const STATE_TEXT: Record<CycleState, string> = {
  idle: "Idle",
  gathering_data: "Gathering broker data",
  loading_options: "Loading option chains",
  researching: "Researching",
  deciding: "Deciding",
  executing: "Executing decisions",
  protecting: "Checking protection",
  reviewing: "Reviewing the day",
}

/** Event decisions record the wire items behind them: per symbol, plus every market-wide item. */
const eventItemsBySymbol = (events: EventFocus[]): Record<string, string[]> => {
  const market = events.filter((e) => !e.symbol).flatMap((e) => e.item_ids)
  const out: Record<string, string[]> = { "*": market }
  for (const e of events) if (e.symbol) out[e.symbol] = [...new Set([...(out[e.symbol] ?? []), ...e.item_ids, ...market])]
  return out
}
