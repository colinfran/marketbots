import { randomUUID } from "node:crypto"
import type { CandidateRecord, CycleKind, DecisionAction, DecisionDoc, PositionDoc, RegimeSnapshot, SeedAllocation, SeedOrder, SymbolFeatures } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { cryptoReportSchema, MAX_HORIZON_HOURS, normalizeCryptoReport, type NormalizedCryptoDecision } from "@mb/crypto-core/report"
import type { Settings } from "@mb/crypto-core/settings"
import type { StrategyId } from "@mb/crypto-core/strategies"
import type { EventFocus } from "@mb/crypto-core/wire"
import { ACCOUNT_ID, MODE } from "@mb/crypto-core/venues"
import { CRYPTO_PROMPT_VERSION, cryptoDecisionPrompt, cryptoDecisionSystemPrompt, cryptoGapFillPrompt, cryptoResearchPrompt, eventSection, type CryptoSubject } from "../ai/prompts"
import { repairCryptoReport } from "../ai/repair"
import type { ResearchResult } from "../ai/runner"
import { errorMessage } from "../log"
import { classifyRegime, computeFeatures, featuresForPrompt, type Features } from "../market/features"
import { correlatedWith, correlationMatrix } from "../risk/correlation"
import { evaluateCryptoEntry, evaluateExit, type RiskResult } from "../risk/engine"
import { cryptoEdge, cryptoSize, roundTripCostBps, slippageBps, walkBook } from "../risk/sizing"
import { screenCrypto } from "../strategies/registry"
import { boundedStop, candidateFeatures, clampScore, type CryptoCandidate } from "../strategies/types"
import { cleanLine } from "../util/text"
import { formatPrice, minimumViolation, roundPrice, roundQty } from "../venues/kraken/pairs"
import { buildDossier, type Dossier } from "../wire/dossier"
import { cycleStep, finishCycle, type EngineContext } from "./context"
import { runSeedCycle } from "./seed"
import { exitPosition } from "./trading"

/**
 * One decision cycle:
 *   1. market data → features (code)            5. structured AI decision per candidate/position
 *   2. quant screens → candidates (code)        6. EV, costs and size (code)
 *   3. positions due for review                 7. deterministic risk checks, then execution
 *   4. live research (Grok + web/X search)      8. everything recorded for later evaluation
 *
 * No candidates and no reviews means no AI call. Missing data, a blown budget or a failed AI call
 * means no new trades; positions stay protected by stops either way.
 */

const HOUR = 3_600_000
/** Long-term trend holds are reviewed at most daily, and on daily-ATR moves, not hourly ones. */
const DAILY_REVIEW_MINUTES = 1_440

export type SeedOutcome = { allocations: SeedAllocation[]; orders: SeedOrder[]; notes: string[]; rationale: string | null; executed: number }

export type CycleResult = {
  cycleId: string
  status: "completed" | "skipped" | "failed"
  summary: string
  features: Map<string, SymbolFeatures>
  /** Seed cycles only: what was allocated and what happened to each order. */
  seed?: SeedOutcome
  /** Symbols the AI was asked to evaluate as entries (the news engine's "focus"). */
  candidates?: string[]
}

/** What a cycle should do and why it started. */
export type CycleRequest = {
  kind: CycleKind
  trigger: string
  /** Held symbols to review even if not due. */
  forcedReviews?: ReadonlySet<string>
  /** Owner-requested pairs to evaluate. */
  requested?: readonly string[]
  /** Seed cycles only: the run being executed and its amount. */
  seed?: { id: string; amountUsd: number }
  /** Event cycles only: what the news engine saw (merged by symbol). */
  events?: EventFocus[]
}

export const summarize = (f: Features): SymbolFeatures => ({
  ret_24h_pct: f.ret_24h_pct,
  ret_7d_pct: f.ret_7d_pct,
  ret_30d_pct: f.ret_30d_pct,
  rsi14_1h: f.rsi14_1h,
  trend_4h: f.trend_4h,
  trend_1d: f.trend_1d,
  vol_30d_pct: f.vol_30d_pct,
  atr_pct_1h: f.atr_pct_1h,
  volume_ratio_24h: f.volume_ratio_24h,
  as_of: new Date(f.as_of),
})

export const loadFeatures = async (ctx: EngineContext, symbols: string[]) => {
  const features: Features[] = []
  const failures: string[] = []
  for (let i = 0; i < symbols.length; i += 3) {
    await Promise.all(
      symbols.slice(i, i + 3).map(async (symbol) => {
        const quote = ctx.hub.quote(symbol)
        if (!quote) return failures.push(`${symbol}: no quote`)
        try {
          const [h1, h4, d1] = await Promise.all([ctx.candles.get(symbol, 60), ctx.candles.get(symbol, 240), ctx.candles.get(symbol, 1440)])
          const f = computeFeatures(symbol, { h1, h4, d1 }, quote)
          if (f) features.push(f)
          else failures.push(`${symbol}: not enough history`)
        } catch (error) {
          failures.push(`${symbol}: ${errorMessage(error)}`)
        }
      }),
    )
  }
  return { features, failures }
}

/** "14:03Z": wire times in prompts. */
const utcTime = (d: Date) => `${d.toISOString().slice(11, 16)}Z`

/**
 * Event cycles' candidates: only bullish focus symbols that aren't held and have fresh data, as
 * event_driven candidates with the strategy's usual levels (stop 2 ATR(1h), target 2.5R).
 */
export const eventCandidates = (events: EventFocus[], fresh: Features[], held: ReadonlySet<string>, settings: Settings): CryptoCandidate[] => {
  if (!settings.strategies.event_driven.enabled) return []
  const seen = new Set<string>()
  return events.flatMap((e) => {
    if (!e.symbol || seen.has(e.symbol) || held.has(e.symbol) || e.polarity <= 0 || (e.action !== "evaluate" && e.action !== "gap_fill")) return []
    const f = fresh.find((x) => x.symbol === e.symbol)
    if (!f) return []
    seen.add(e.symbol)
    const stop = boundedStop(f.price, 2 * (f.atr_1h ?? f.price * 0.015), settings)
    return [
      {
        instrument: f.symbol,
        symbol: f.symbol,
        strategy: "event_driven" as const,
        score: clampScore(e.severity),
        signal: `News engine (${e.rule}, severity ${e.severity}): ${cleanLine(e.headline, 200)}. Verify before acting.`,
        features: candidateFeatures(f),
        stop_hint: stop,
        target_hint: f.price + 2.5 * (f.price - stop),
      },
    ]
  })
}

/** How fresh an X read must be for research_mode auto to skip Grok. */
const X_READ_FRESH_MINUTES = 120

export type ResearchPlan = { kind: "full" | "gap" | "none"; reason: string }

/**
 * Which Grok research a cycle runs (MASTER_PLAN §3.9). Full whenever the wire is off or
 * unhealthy. auto skips Grok only when our feeds leave no gap: no unexplained moves, no
 * unconfirmed high-severity items, and a recent X read of these same subjects.
 */
export const researchPlan = async (
  ctx: Pick<EngineContext, "settings" | "col">,
  { isEvent, wireHealthy, dossier, subjects, now = new Date() }: { isEvent: boolean; wireHealthy: boolean; dossier: Dossier | null; subjects: string[]; now?: Date },
): Promise<ResearchPlan> => {
  const w = ctx.settings.current.wire
  if (isEvent) return w.event_research === "none" ? { kind: "none", reason: "event cycle with event_research none: the dossier is the evidence" } : { kind: "gap", reason: "event check (x_verify)" }
  if (!dossier) return { kind: "full", reason: "news engine off" }
  if (!wireHealthy) return { kind: "full", reason: "news engine unhealthy" }
  if (w.research_mode === "full") return { kind: "full", reason: "research_mode full" }
  if (w.research_mode === "gap_fill") return { kind: "gap", reason: "research_mode gap_fill" }
  if (dossier.unexplained.length || dossier.unconfirmed.length) return { kind: "gap", reason: `${dossier.unexplained.length} unexplained moves, ${dossier.unconfirmed.length} unconfirmed items` }
  const lastX = await ctx.col.research.findOne(
    { started_at: { $gte: new Date(now.getTime() - X_READ_FRESH_MINUTES * 60_000) }, x_search: true, error: null, memo: { $ne: "" }, subjects: { $all: subjects } },
    { sort: { started_at: -1 }, projection: { started_at: 1 } },
  )
  if (!lastX) return { kind: "gap", reason: "no X read of these subjects in the last 2 h" }
  return { kind: "none", reason: `no unexplained moves or unconfirmed items, and X was read ${Math.round((now.getTime() - lastX.started_at.getTime()) / 60_000)} min ago` }
}

/** Positions whose thesis should be re-examined now. */
export const reviewsDue = (positions: PositionDoc[], features: Map<string, Features>, forced: ReadonlySet<string>, reviewMinutes: number, moveAtr: number, now: number) =>
  positions.flatMap((p) => {
    if (forced.has(p.symbol)) return [{ position: p, reason: "triggered" }]
    const daily = p.strategy_id === "daily_trend"
    const age = now - (p.last_reviewed_at ?? p.opened_at).getTime()
    if (age >= (daily ? Math.max(reviewMinutes, DAILY_REVIEW_MINUTES) : reviewMinutes) * 60_000) {
      return [{ position: p, reason: `scheduled review (${Math.round(age / 60_000)} min since last)` }]
    }
    const f = features.get(p.symbol)
    const ref = p.last_review_price ?? p.avg_price
    const atr = daily ? (f?.atr_pct_1d ? (f.atr_pct_1d / 100) * f.price : null) : f?.atr_1h
    if (f && atr && Math.abs(f.price - ref) >= moveAtr * atr) {
      return [{ position: p, reason: `moved ${((f.price / ref - 1) * 100).toFixed(2)}% (≥ ${moveAtr} ${daily ? "daily " : ""}ATR) since last review` }]
    }
    if (p.horizon_hours && now - p.opened_at.getTime() > p.horizon_hours * HOUR) return [{ position: p, reason: "expected holding period elapsed" }]
    return []
  })

export const runCryptoCycle = async (ctx: EngineContext, request: CycleRequest): Promise<CycleResult> => {
  if (request.kind === "seed") {
    if (!request.seed) throw new Error("seed cycle without a seed run")
    return runSeedCycle(ctx, { trigger: request.trigger, seed: request.seed })
  }
  const { kind, trigger, requested = [] } = request
  const events = kind === "event" ? (request.events ?? []) : []
  const isEvent = kind === "event"
  const settings = ctx.settings.current
  const cycleId = randomUUID()
  const started = Date.now()
  const eventItemIds = [...new Set(events.flatMap((e) => e.item_ids))]
  await ctx.col.cycles.insertOne({
    _id: cycleId,
    trigger,
    kind,
    ...(isEvent ? { wire_trigger_id: events[0]?.trigger_id ?? null, wire_item_ids: eventItemIds } : {}),
    status: "running",
    state: "screening",
    started_at: new Date(),
    finished_at: null,
    duration_ms: null,
    regime: null,
    candidates: [],
    reviews: [],
    research_id: null,
    decision_ids: [],
    steps: [],
    summary: null,
    error: null,
    ai_cost_usd: 0,
    settings_version: ctx.settings.version,
    prompt_version: CRYPTO_PROMPT_VERSION,
  })
  ctx.bus.emit("cycle.started", { cycle_id: cycleId, trigger }, { summary: `Cycle started (${trigger})`, cycle_id: cycleId })
  /** Every cycle ends with exactly one of cycle.completed / cycle.skipped / cycle.failed, so live views know it's over. */
  const finish = async (
    status: CycleResult["status"],
    summary: string,
    extra: Parameters<typeof finishCycle>[3] = {},
    done?: { decisions: number; approved: number; executed: number; notification: string },
  ) => {
    await finishCycle(ctx.col, cycleId, started, { status, summary, ...extra })
    ctx.setCycleState("idle")
    if (status === "skipped") ctx.bus.emit("cycle.skipped", { reason: summary }, { summary: `Cycle skipped: ${summary}`, cycle_id: cycleId })
    else if (status === "failed") ctx.bus.emit("cycle.failed", { cycle_id: cycleId, error: extra.error ?? summary }, { summary: `Cycle failed: ${summary}`, level: "warn", cycle_id: cycleId })
    else {
      ctx.bus.emit(
        "cycle.completed",
        { cycle_id: cycleId, duration_ms: Date.now() - started, decisions: done?.decisions ?? 0, approved: done?.approved ?? 0, executed: done?.executed ?? 0, ai_cost_usd: roundTo(extra.ai_cost_usd ?? 0, 4), summary: done?.notification ?? summary },
        // Idle cycles run every few minutes: they still close the cycle for live views, but stay out of the activity feed.
        { summary: done ? `Cycle done: ${done.decisions} decisions, ${done.executed} executed` : `Cycle done: ${summary}`, level: done ? "info" : "debug", cycle_id: cycleId },
      )
    }
    return { cycleId, status, summary, features: summaries, candidates: candidateSymbols }
  }
  let summaries = new Map<string, SymbolFeatures>()
  let candidateSymbols: string[] = []

  // 1. Market data and features.
  ctx.setCycleState("screening", "computing features")
  const { features, failures } = await loadFeatures(ctx, ctx.hub.universe)
  summaries = new Map(features.map((f) => [f.symbol, summarize(f)]))
  await cycleStep(ctx.col, cycleId, "features", features.length > 0, `${features.length} symbols${failures.length ? `; ${failures.slice(0, 5).join("; ")}` : ""}`)
  const fresh = features.filter((f) => f.quote_age_s <= settings.kraken.max_quote_age_seconds)
  if (fresh.length < Math.max(1, Math.ceil(ctx.hub.universe.length / 2))) {
    ctx.setCycleState("waiting_for_data")
    return finish("skipped", `insufficient fresh market data (${fresh.length}/${ctx.hub.universe.length} symbols)`)
  }
  const regime: RegimeSnapshot = classifyRegime(features)
  const byFeature = new Map(features.map((f) => [f.symbol, f]))

  // 2–3. Screens and reviews.
  const positions = await ctx.ledger.openPositions()
  const held = new Set(positions.map((p) => p.symbol))
  const gate = ctx.gate()
  const riskState = await ctx.ledger.riskState()
  const canEnter = gate.runStatus === "running" && !gate.killSwitch && gate.venueOnline && gate.reconciled && positions.length < settings.kraken.max_concurrent_positions
  // Daily-trend setups only change with a new daily candle: once the AI has ruled on one, don't pay to ask again for a day.
  const judged =
    canEnter && !isEvent
      ? new Set(await ctx.col.decisions.distinct("symbol", { strategy_id: "daily_trend", created_at: { $gte: new Date(Date.now() - DAILY_REVIEW_MINUTES * 60_000) } }))
      : new Set<string>()
  // Event cycles look only at what the news engine flagged: no screens, no daily-trend filter.
  const candidates = !canEnter
    ? []
    : isEvent
      ? eventCandidates(events, fresh, held, settings)
      : screenCrypto({ regime, features: fresh, held, settings })
          .filter((c) => !(c.strategy === "daily_trend" && judged.has(c.symbol)))
          .slice(0, settings.ai.max_candidates_per_cycle)
  // Owner-requested evaluations join as "discretionary" candidates (same research, decision and risk path).
  if (canEnter && !isEvent && settings.strategies.discretionary.enabled) {
    for (const symbol of requested) {
      const f = fresh.find((x) => x.symbol === symbol)
      if (!f || held.has(symbol) || candidates.some((c) => c.symbol === symbol)) continue
      const stop = boundedStop(f.price, 2 * (f.atr_1h ?? f.price * 0.015), settings)
      candidates.push({
        instrument: symbol,
        symbol,
        strategy: "discretionary",
        score: 50,
        signal: "Owner requested an evaluation (no screen signal).",
        features: candidateFeatures(f),
        stop_hint: stop,
        target_hint: f.price + 2.5 * (f.price - stop),
      })
    }
  }
  // Event cycles review only what the event touches: the named holdings, or every holding for a market-wide event.
  const forced = new Set(request.forcedReviews ?? [])
  for (const e of events) {
    if (e.action === "market_review") for (const p of positions) forced.add(p.symbol)
    else if (e.symbol && held.has(e.symbol)) forced.add(e.symbol)
  }
  const reviews = reviewsDue(positions, byFeature, forced, settings.schedule.position_review_minutes, settings.schedule.trigger_move_atr, Date.now()).filter(
    (r) => !isEvent || forced.has(r.position.symbol),
  )
  candidateSymbols = candidates.map((c) => c.symbol)
  const candidateRecords: CandidateRecord[] = candidates.map(({ symbol, stop_hint, target_hint, ...rest }) => ({ ...rest, features: { ...rest.features, stop_hint: roundTo(stop_hint, 6), target_hint: roundTo(target_hint, 6) } }))
  await ctx.col.cycles.updateOne({ _id: cycleId }, { $set: { regime, candidates: candidateRecords, reviews: reviews.map((r) => r.position.symbol) } })
  ctx.bus.emit(
    "screen.candidates",
    {
      cycle_id: cycleId,
      candidates: candidates.map((c) => ({ instrument: c.symbol, strategy: c.strategy, score: c.score, signal: c.signal })),
      reviews: reviews.map((r) => r.position.symbol),
      regime: regime.label,
      symbols: fresh.length,
    },
    {
      summary: candidates.length || reviews.length ? `${candidates.length} candidates, ${reviews.length} positions to review (regime: ${regime.label})` : `No candidates (regime: ${regime.label})`,
      cycle_id: cycleId,
    },
  )
  if (!candidates.length && !reviews.length) {
    const why = isEvent
      ? `idle: event (${events.map((e) => `${e.rule} ${e.symbol ?? "market"}`).join(", ")}) left nothing to decide`
      : canEnter
        ? `idle: no setups in a ${regime.label} market`
        : "idle: entries blocked and no positions due for review"
    return finish("completed", why, { regime })
  }

  // 4. The wire dossier, budget, then research: full, gap-fill, or skipped when our feeds cover it.
  if (!ctx.ai.available) return finish("skipped", "AI disabled (AI_GATEWAY_API_KEY not set): no new decisions")
  const subjects: CryptoSubject[] = [
    ...candidates.map((c) => ({ symbol: c.symbol, role: "candidate" as const, note: `${c.strategy}: ${c.signal}` })),
    ...reviews.map((r) => ({ symbol: r.position.symbol, role: "held" as const, note: `held since ${r.position.opened_at.toISOString().slice(0, 16)}Z; thesis: ${r.position.thesis ?? "n/a"}` })),
  ]
  const subjectSymbols = subjects.map((s) => s.symbol)
  const wire = ctx.wire && settings.wire.mode !== "off" ? ctx.wire : null
  const dossier = wire
    ? await buildDossier(ctx.col, {
        symbols: subjectSymbols,
        since: new Date(Date.now() - 72 * HOUR),
        now: new Date(),
        price: (s) => ctx.hub.quote(s)?.mid ?? null,
        timeLabel: utcTime,
        reviewThreshold: settings.wire.thresholds.review,
      }).catch((error) => {
        ctx.log.warn("wire dossier failed", { error: errorMessage(error) })
        return null
      })
    : null
  if (dossier) {
    ctx.bus.emit("wire.dossier", { cycle_id: cycleId, rows: dossier.rows, total: dossier.items.length }, { summary: `Our research: ${dossier.items.length} items for ${subjects.length} subjects`, cycle_id: cycleId })
  }
  const eventText = isEvent ? eventSection(events) : undefined
  const plan = await researchPlan(ctx, { isEvent, wireHealthy: !!wire && wire.healthy(), dossier, subjects: subjectSymbols })
  const estimate = (plan.kind === "full" ? await ctx.budget.estimate("research") : plan.kind === "gap" ? await ctx.budget.estimate("research_gap") : 0) + (await ctx.budget.estimate("decision"))
  // Scheduled cycles leave the event reserve alone; event cycles may use the whole budget.
  const reservePct = !isEvent && settings.wire.mode === "live" ? settings.wire.event_budget_reserve_pct : 0
  const afford = await ctx.budget.canAfford(estimate, { reservePct })
  if (!afford.ok) {
    ctx.bus.emit("budget.exhausted", { spent_usd: afford.status.spent_usd, budget_usd: afford.status.budget_usd }, { summary: `AI budget exhausted ($${afford.status.spent_usd.toFixed(2)} of $${afford.status.budget_usd}${reservePct ? `, ${reservePct}% kept for news events` : ""}); no new decisions until 00:00 UTC`, level: "warn" })
    return finish("skipped", reservePct ? "daily AI budget exhausted (the rest is reserved for news events)" : "daily AI budget exhausted")
  }

  const researchId = randomUUID()
  let research: ResearchResult
  if (plan.kind === "none") {
    research = { memo: "", sources: [], queries: [], model: settings.ai.models.research, x_search: false, duration_ms: 0, usage: { input: 0, output: 0, total: 0 }, cost_usd: 0, error: null }
  } else {
    ctx.setCycleState("researching", subjectSymbols.join(", "))
    ctx.bus.emit(
      "research.started",
      { cycle_id: cycleId, research_id: researchId, subjects: subjectSymbols, model: settings.ai.models.research },
      { summary: `${plan.kind === "gap" ? "Checking gaps for" : "Researching"} ${subjectSymbols.join(", ")}`, cycle_id: cycleId },
    )
    research = await ctx.ai.research({
      cycleId,
      model: settings.ai.models.research,
      fallback: settings.ai.models.fallback,
      prompt: plan.kind === "full" ? cryptoResearchPrompt({ now: new Date(), regime, subjects }) : cryptoGapFillPrompt({ now: new Date(), regime, subjects, wire: dossier?.text ?? "", event: eventText }),
      task: plan.kind === "gap" ? "research_gap" : "research",
      xSearch: settings.ai.x_search,
      fromDate: new Date(Date.now() - (plan.kind === "gap" ? 1 : 3) * 86_400_000).toISOString().slice(0, 10),
      timeoutMs: (isEvent ? settings.wire.event_research_timeout_seconds : settings.ai.research_timeout_seconds) * 1000,
      signal: ctx.signal,
      progress: {
        onQuery: (query, tool) => ctx.bus.emit("research.query", { research_id: researchId, query, tool }, { summary: `Searching: ${query}`, cycle_id: cycleId, level: "debug" }),
        onSource: (s) => ctx.bus.emit("research.source", { research_id: researchId, ...s }, { summary: `Source: ${s.title}`, cycle_id: cycleId, level: "debug" }),
        onText: (chars, excerpt) => ctx.bus.emit("research.progress", { research_id: researchId, chars, excerpt }, { summary: `Writing research memo (${chars} chars)`, cycle_id: cycleId, level: "debug" }),
      },
    })
  }
  await ctx.col.research.insertOne({
    _id: researchId,
    cycle_id: cycleId,
    subjects: subjectSymbols,
    memo: research.memo,
    sources: research.sources,
    queries: research.queries,
    model: research.model,
    prompt_version: CRYPTO_PROMPT_VERSION,
    x_search: research.x_search,
    started_at: new Date(started),
    duration_ms: research.duration_ms,
    usage: research.usage,
    cost_usd: research.cost_usd,
    error: research.error,
    mode: plan.kind === "full" ? "full" : plan.kind === "gap" ? "gap_fill" : "skipped",
    ...(dossier ? { dossier: dossier.rows } : {}),
  })
  if (plan.kind === "none") {
    await ctx.col.cycles.updateOne({ _id: cycleId }, { $set: { research_skip_reason: plan.reason } })
    await cycleStep(ctx.col, cycleId, "research", true, `skipped: ${plan.reason}`)
  } else {
    ctx.bus.emit(
      "research.completed",
      { research_id: researchId, sources: research.sources.length, queries: research.queries.length, duration_ms: research.duration_ms, cost_usd: research.cost_usd, error: research.error },
      { summary: research.error ? `Research failed: ${research.error}` : `Research done: ${research.sources.length} sources, ${research.queries.length} searches`, level: research.error ? "warn" : "info", cycle_id: cycleId },
    )
    await cycleStep(ctx.col, cycleId, "research", !research.error, research.error ?? `${plan.kind === "gap" ? "gap-fill, " : ""}${research.sources.length} sources`)
  }

  // 5. Structured decision.
  ctx.setCycleState("evaluating", "AI decision")
  ctx.bus.emit("ai.decision.started", { cycle_id: cycleId, model: settings.ai.models.decision, items: subjects.map((s) => s.symbol) }, { summary: `Deciding on ${subjects.length} items`, cycle_id: cycleId })
  const takerBps = ctx.feeBps()
  const equity = riskState?.equityUsd ?? 0
  const positionWeights = new Map(positions.map((p) => [p.symbol, equity > 0 ? ((p.qty * (p.mark_price ?? p.avg_price)) / equity) * 100 : 0]))
  const estRoundTrip = (f: Features) => Math.round(roundTripCostBps({ takerFeeBps: takerBps, spreadBps: f.spread_bps, entrySlippageBps: 3, exitSlippageBps: 3 }))
  const recent = await ctx.col.decisions
    .find({ symbol: { $in: subjects.map((s) => s.symbol) }, created_at: { $gte: new Date(Date.now() - 48 * HOUR) } }, { projection: { symbol: 1, created_at: 1, action: 1, "execution.status": 1, "ai.conviction": 1 } })
    .sort({ created_at: -1 })
    .limit(15)
    .toArray()
  const trackRecord = await strategyTrackRecord(ctx)
  let aiCost = research.cost_usd
  let normalized: ReturnType<typeof normalizeCryptoReport>
  let decisionMeta: { attempts: number; repaired: boolean; model: string }
  try {
    const result = await ctx.ai.structured({
      task: "decision",
      cycleId,
      model: settings.ai.models.decision,
      fallback: settings.ai.models.fallback,
      system: cryptoDecisionSystemPrompt(),
      prompt: cryptoDecisionPrompt({
        now: new Date(),
        regime,
        account: riskState
          ? {
              mode: "paper",
              exposure_pct: roundTo((riskState.positions.reduce((s, p) => s + p.valueUsd, 0) / Math.max(1, riskState.equityUsd)) * 100, 1),
              day_pnl_pct: roundTo((riskState.equityUsd / Math.max(1, riskState.dayStartEquityUsd) - 1) * 100, 2),
              drawdown_pct: roundTo((riskState.equityUsd / Math.max(1, riskState.peakEquityUsd) - 1) * 100, 2),
              open_positions: positions.length,
              new_entries_allowed: canEnter,
            }
          : { mode: "paper" },
        limits: {
          max_position_pct: settings.kraken.max_position_pct,
          risk_per_trade_pct: settings.kraken.risk_per_trade_pct,
          min_reward_risk: settings.kraken.min_reward_risk,
          min_edge_bps_after_costs: settings.kraken.min_edge_bps,
          min_conviction: settings.kraken.min_conviction,
          stop_range_pct: [settings.kraken.min_stop_pct, settings.kraken.max_stop_pct],
          fee_bps_per_side: takerBps,
        },
        candidates: candidates.map((c) => ({
          symbol: c.symbol,
          strategy: c.strategy,
          score: c.score,
          signal: c.signal,
          stop_hint: roundTo(c.stop_hint, 6),
          target_hint: roundTo(c.target_hint, 6),
          est_round_trip_cost_bps: estRoundTrip(byFeature.get(c.symbol)!),
          features: featuresForPrompt(byFeature.get(c.symbol)!),
        })),
        positions: reviews.map(({ position: p, reason }) => {
          const f = byFeature.get(p.symbol)
          const mark = f?.price ?? p.mark_price ?? p.avg_price
          return {
            symbol: p.symbol,
            review_reason: reason,
            entry_price: p.avg_price,
            price: mark,
            pnl_pct: roundTo((mark / p.avg_price - 1) * 100, 2),
            weight_pct: roundTo(positionWeights.get(p.symbol) ?? 0, 1),
            stop: p.stop_price,
            target: p.take_profit_price,
            age_hours: roundTo((Date.now() - p.opened_at.getTime()) / HOUR, 1),
            strategy: p.strategy_id,
            thesis: p.thesis,
            invalidation: p.invalidation,
            features: f ? featuresForPrompt(f) : null,
          }
        }),
        recent: recent.map((d) => ({ symbol: d.symbol, at: d.created_at.toISOString().slice(0, 16), action: d.action, conviction: d.ai.conviction, execution: d.execution.status })),
        trackRecord,
        memo: research.memo,
        researchError: research.error,
        wire: dossier?.text,
        event: eventText,
        researchSkipped: plan.kind === "none" ? plan.reason : null,
      }),
      schema: cryptoReportSchema,
      name: "crypto_decisions",
      description: "CryptoMarketBot decisions: one per candidate and held position, with evidence and levels.",
      repair: repairCryptoReport,
      timeoutMs: (isEvent ? settings.wire.event_decision_timeout_seconds : settings.ai.decision_timeout_seconds) * 1000,
      signal: ctx.signal,
    })
    aiCost += result.cost_usd
    decisionMeta = { attempts: result.attempts, repaired: result.repaired, model: result.model }
    normalized = normalizeCryptoReport(result.output, {
      candidates: new Set(candidates.map((c) => c.symbol)),
      held: new Set(reviews.map((r) => r.position.symbol)),
      // The AI may cite what research retrieved and what our feeds saw; anything else is dropped.
      sourceUrls: new Set([...research.sources.map((s) => s.url), ...(dossier?.urls ?? [])]),
    })
  } catch (error) {
    const message = errorMessage(error)
    ctx.bus.emit("ai.decision.failed", { cycle_id: cycleId, error: message }, { summary: `AI decision failed; no trades this cycle`, level: "warn", cycle_id: cycleId })
    await ctx.alerts.send("warning", "AI decision failed", message, { path: `/research/${cycleId}` })
    return finish("failed", "AI decision failed; no trades", { error: message.slice(0, 1000), research_id: researchId, ai_cost_usd: aiCost, regime })
  }
  ctx.bus.emit(
    "ai.decision.completed",
    { cycle_id: cycleId, decisions: normalized.decisions.length, attempts: decisionMeta.attempts, repaired: decisionMeta.repaired, cost_usd: roundTo(aiCost, 4) },
    { summary: normalized.notification || `${normalized.decisions.length} decisions`, cycle_id: cycleId },
  )
  // Wire items the AI cited as evidence now count as notable (they reach the Live page).
  if (wire && dossier) {
    const cited = normalized.decisions.flatMap((d) => [...d.bull_evidence, ...d.bear_evidence]).flatMap((e) => (e.source_url && dossier.idByUrl.has(e.source_url) ? [dossier.idByUrl.get(e.source_url)!] : []))
    if (cited.length) await wire.markNotable(cited, "cited").catch((e) => ctx.log.warn("marking cited items failed", { error: errorMessage(e) }))
  }

  // 6–7. Evaluate and execute: exits first (they free capital and reduce risk), then entries by conviction.
  ctx.setCycleState("risk_check")
  const order = (d: NormalizedCryptoDecision) => (d.action === "close" ? 0 : d.action === "reduce" ? 1 : d.action === "hold" ? 2 : d.action === "buy" ? 3 : 4)
  const sorted = [...normalized.decisions].sort((a, b) => order(a) - order(b) || b.conviction - a.conviction)
  const matrix = correlationMatrix(new Map(features.map((f) => [f.symbol, f.closes_1h])))
  const decisionIds: string[] = []
  let approved = 0
  let executed = 0
  for (const d of sorted) {
    const candidate = candidates.find((c) => c.symbol === d.symbol) ?? null
    const position = positions.find((p) => p.symbol === d.symbol) ?? null
    try {
      const wireItemIds = isEvent ? [...new Set(events.filter((e) => e.symbol === d.symbol || e.symbol === null).flatMap((e) => e.item_ids))] : undefined
      const doc = await processDecision(ctx, { cycleId, researchId, decision: d, candidate, position, features: byFeature.get(d.symbol) ?? null, takerBps, matrix, decisionModel: decisionMeta.model, triggerKind: kind, wireItemIds })
      decisionIds.push(doc._id)
      if (doc.risk?.approved) approved += 1
      if (doc.execution.status === "filled" || doc.execution.status === "partial") executed += 1
    } catch (error) {
      ctx.log.error("processing decision failed", { symbol: d.symbol, error: errorMessage(error) })
      ctx.bus.emit("error", { scope: "decision", message: `${d.symbol}: ${errorMessage(error)}` }, { summary: `Decision on ${d.symbol} failed`, level: "error", visibility: "owner", cycle_id: cycleId })
    }
  }

  const summary = `${normalized.market_read.summary.slice(0, 200)} — ${decisionIds.length} decisions, ${approved} approved, ${executed} executed`
  return finish("completed", summary, { decision_ids: decisionIds, research_id: researchId, ai_cost_usd: aiCost, regime }, { decisions: decisionIds.length, approved, executed, notification: normalized.notification })
}

/** Realized results by strategy (after costs), fed back to the AI as measured, not anecdotal, context. */
const strategyTrackRecord = async (ctx: EngineContext) => {
  const rows = await ctx.col.positions
    .aggregate<{ _id: StrategyId | null; trades: number; wins: number; pnl: number }>([
      { $match: { account_id: ACCOUNT_ID, status: "closed", exit_reason: { $nin: ["paper_reset", "reconciliation"] } } },
      { $group: { _id: "$strategy_id", trades: { $sum: 1 }, wins: { $sum: { $cond: [{ $gt: ["$realized_pnl_usd", 0] }, 1, 0] } }, pnl: { $sum: "$realized_pnl_usd" } } },
    ])
    .toArray()
  return rows.filter((r) => r._id).map((r) => ({ strategy: r._id, closed_trades: r.trades, win_rate_pct: Math.round((r.wins / r.trades) * 100), net_pnl_sign: Math.sign(r.pnl) }))
}

export type DecisionInput = {
  cycleId: string
  researchId: string
  decision: NormalizedCryptoDecision
  candidate: CryptoCandidate | null
  position: PositionDoc | null
  features: Features | null
  takerBps: number
  matrix: ReturnType<typeof correlationMatrix>
  decisionModel: string
  triggerKind: CycleKind
  /**
   * One-time seed buys: the owner set the dollar amount, so it replaces risk-based sizing, and the
   * risk engine skips only its conviction, edge and reward:risk gates. Every cap still applies.
   */
  seed?: { notionalUsd: number }
  promptVersion?: string
  /** Event decisions: the wire items behind them. */
  wireItemIds?: string[]
}

/** A stop the seed can use as given: below the price and inside the configured stop range. */
const withinStopRange = (price: number, stop: number | null, k: Settings["kraken"]) => {
  if (stop === null || stop >= price) return false
  const pct = ((price - stop) / price) * 100
  return pct >= k.min_stop_pct && pct <= k.max_stop_pct
}

export const processDecision = async (ctx: EngineContext, i: DecisionInput): Promise<DecisionDoc> => {
  const settings = ctx.settings.current
  const { decision: d, features: f } = i
  const now = new Date()
  const quote = ctx.hub.quote(d.symbol)
  const doc: DecisionDoc = {
    _id: randomUUID(),
    cycle_id: i.cycleId,
    research_id: i.researchId,
    account_id: ACCOUNT_ID,
    mode: MODE,
    instrument: d.symbol,
    symbol: d.symbol,
    strategy_id: i.candidate?.strategy ?? i.position?.strategy_id ?? null,
    created_at: now,
    data_as_of: f ? new Date(f.as_of) : null,
    data_age_s: quote ? roundTo(quote.ageS, 1) : null,
    action: d.action as DecisionAction,
    held: i.position !== null,
    trigger_kind: i.triggerKind,
    ...(i.wireItemIds?.length ? { wire_item_ids: i.wireItemIds } : {}),
    ai: {
      conviction: d.conviction,
      uncertainty: d.uncertainty,
      thesis: d.thesis,
      bull_evidence: d.bull_evidence,
      bear_evidence: d.bear_evidence,
      risks: d.risks,
      invalidation: d.invalidation,
      horizon_hours: d.horizon_hours,
      priced_in: d.priced_in,
      stop_loss: d.stop_loss,
      take_profit: d.take_profit,
      size_pct_of_max: d.size_pct_of_max,
      reduce_pct: d.reduce_pct,
      p_target_first: d.p_target_first,
      notes: d.notes,
    },
    quant: {
      price: quote?.mid ?? f?.price ?? null,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      spread_bps: quote ? roundTo(quote.spreadBps, 2) : null,
      atr_pct: f?.atr_pct_1h ?? null,
      signal: i.candidate?.signal ?? null,
      score: i.candidate?.score ?? null,
      features: i.candidate?.features ?? {},
      baseline_action: i.candidate ? "buy" : "hold",
    },
    costs: { fee_bps: i.takerBps, spread_bps: quote ? roundTo(quote.spreadBps, 2) : null, slippage_bps: null, round_trip_bps: null, fee_usd_est: null },
    ev: { p_prior: null, p_adjusted: null, gross_edge_bps: null, net_edge_bps: null },
    sizing: { qty: null, notional_usd: null, risk_usd: null, limit_price: null, stop_price: null, take_profit_price: null, notes: [] },
    risk: null,
    execution: { status: "not_applicable", order_ids: [], filled_qty: 0, avg_price: null, notes: [] },
    model: i.decisionModel,
    prompt_version: i.promptVersion ?? CRYPTO_PROMPT_VERSION,
    settings_version: ctx.settings.version,
    outcome_due_at: new Date(now.getTime() + Math.min(MAX_HORIZON_HOURS, Math.max(1, d.horizon_hours)) * HOUR),
    outcome: null,
  }

  let risk: RiskResult | null = null
  if (d.action === "buy" && i.candidate && quote?.book) {
    ctx.setCycleState("risk_check", d.symbol)
    const pair = ctx.hub.pairs.get(d.symbol)!
    const seed = i.seed
    // A seed stop outside the configured range would only fail the stop check; the bounded hint is used instead.
    const stop = seed ? (withinStopRange(quote.mid, d.stop_loss, settings.kraken) ? d.stop_loss! : i.candidate.stop_hint) : d.stop_loss && d.stop_loss < quote.mid ? d.stop_loss : i.candidate.stop_hint
    const target = d.take_profit && d.take_profit > quote.mid ? d.take_profit : i.candidate.target_hint
    const riskState = await ctx.ledger.riskState()
    const limit = roundPrice(pair, quote.ask * (1 + settings.kraken.max_slippage_bps / 10_000))
    const size = seed
      ? { qty: seed.notionalUsd / limit, notional: seed.notionalUsd, riskUsd: (seed.notionalUsd / limit) * Math.max(0, quote.ask - stop) }
      : cryptoSize({
          equity: riskState?.equityUsd ?? 0,
          price: quote.ask,
          stop,
          riskPct: settings.kraken.risk_per_trade_pct,
          maxPositionPct: settings.kraken.max_position_pct,
          sizePctOfMax: d.size_pct_of_max ?? 50,
        })
    const qty = roundQty(pair, size.qty)
    const walkIn = walkBook(quote.book.asks, qty, limit, "buy")
    const walkOut = walkBook(quote.book.bids, qty, null, "sell")
    const inSlip = walkIn.avgPrice ? slippageBps(walkIn.avgPrice, quote.mid, "buy") - quote.spreadBps / 2 : settings.kraken.max_slippage_bps
    const outSlip = walkOut.avgPrice ? slippageBps(walkOut.avgPrice, quote.mid, "sell") - quote.spreadBps / 2 : settings.kraken.max_slippage_bps
    const roundTrip = roundTripCostBps({ takerFeeBps: i.takerBps, spreadBps: quote.spreadBps, entrySlippageBps: inSlip, exitSlippageBps: outSlip })
    const edge = cryptoEdge({ price: quote.mid, stop, target, pAi: d.p_target_first, shrink: settings.ai.probability_shrink, roundTripBps: roundTrip })
    doc.costs = { ...doc.costs, slippage_bps: roundTo(inSlip + outSlip, 2), round_trip_bps: roundTo(roundTrip, 2), fee_usd_est: roundTo((2 * size.notional * i.takerBps) / 10_000, 4) }
    if (edge) {
      doc.ev = { p_prior: roundTo(edge.pPrior, 4), p_adjusted: roundTo(edge.pAdjusted, 4), gross_edge_bps: roundTo(edge.grossEdgeBps, 2), net_edge_bps: roundTo(edge.netEdgeBps, 2) }
    }
    doc.sizing = { qty, notional_usd: roundTo(qty * limit, 2), risk_usd: roundTo(size.riskUsd, 2), limit_price: limit, stop_price: roundPrice(pair, stop), take_profit_price: roundPrice(pair, target), notes: [] }
    risk = riskState
      ? evaluateCryptoEntry(
          {
            symbol: d.symbol,
            strategyId: i.candidate.strategy,
            mid: quote.mid,
            spreadBps: quote.spreadBps,
            quoteAgeS: quote.ageS,
            qty,
            limitPrice: limit,
            stopPrice: stop,
            takeProfitPrice: target,
            conviction: d.conviction,
            netEdgeBps: edge?.netEdgeBps ?? Number.NEGATIVE_INFINITY,
            rewardRisk: edge?.rewardRisk ?? 0,
            correlatedHeld: correlatedWith(d.symbol, riskState.positions.map((p) => p.symbol), i.matrix, settings.kraken.correlation_threshold),
            takerFeeBps: i.takerBps,
            roundQty: (q) => roundQty(pair, q),
            minViolation: (q, p) => minimumViolation(pair, q, p),
            ownerDirected: !!seed,
          },
          riskState,
          ctx.gate(),
          settings,
        )
      : { approved: false, resized: false, qty: 0, notionalUsd: 0, checks: [{ name: "account", ok: false, detail: "account missing" }], reasons: ["account missing"] }
    doc.risk = { approved: risk.approved, resized: risk.resized, checks: risk.checks, reasons: risk.reasons }
    if (risk.approved) {
      ctx.setCycleState("placing_order", d.symbol)
      doc.sizing.qty = risk.qty
      doc.sizing.notional_usd = roundTo(risk.notionalUsd, 2)
      const report = await ctx.executor.execute({
        instrument: d.symbol,
        side: "buy",
        qty: risk.qty,
        limitPrice: limit,
        referencePrice: quote.mid,
        purpose: "entry",
        decisionId: doc._id,
        positionId: null,
        meta: {
          strategy_id: i.candidate.strategy,
          thesis: d.thesis,
          invalidation: d.invalidation,
          stop_price: doc.sizing.stop_price,
          take_profit_price: doc.sizing.take_profit_price,
          horizon_hours: d.horizon_hours,
        },
      })
      doc.execution = {
        status: report.order.filled_qty <= 0 ? (report.order.status === "rejected" ? "rejected" : "failed") : report.order.filled_qty < risk.qty - 1e-12 ? "partial" : "filled",
        order_ids: [report.order._id],
        filled_qty: report.order.filled_qty,
        avg_price: report.order.avg_fill_price,
        notes: report.order.reason ? [report.order.reason] : [],
      }
      const { filled_qty: filled, avg_fill_price: avg, fees_usd: fees } = report.order
      if (filled > 0 && avg !== null) {
        const cost = filled * avg + fees
        await ctx.alerts.success(seed ? `Seed buy: ${d.symbol}` : `Bought ${d.symbol}`, `[paper] ${cleanLine(d.thesis, 400)}`, {
          path: `/decisions/${doc._id}`,
          key: `buy|${report.order._id}`,
          fields: {
            Quantity: filled,
            Price: `$${formatPrice(pair, avg)}`,
            Cost: `$${cost.toFixed(2)}${riskState?.equityUsd ? ` (${((cost / riskState.equityUsd) * 100).toFixed(1)}% of equity)` : ""}`,
            Stop: `$${formatPrice(pair, stop)}`,
            Target: `$${formatPrice(pair, target)}`,
            Strategy: i.candidate.strategy.replace("_", " "),
            Conviction: `${d.conviction}/100`,
          },
        })
      }
    } else {
      doc.execution.status = "rejected"
    }
  } else if (d.action === "buy") {
    doc.execution = { ...doc.execution, status: "skipped", notes: ["no live order book at execution time"] }
  } else if ((d.action === "reduce" || d.action === "close") && i.position) {
    const check = evaluateExit({ reason: "ai", openedAt: i.position.opened_at.getTime(), venueOnline: ctx.hub.tradingOnline, minHoldMinutes: settings.kraken.min_hold_minutes })
    doc.risk = { approved: check.approved, resized: false, checks: check.checks, reasons: check.reasons }
    risk = { approved: check.approved, resized: false, qty: 0, notionalUsd: 0, checks: check.checks, reasons: check.reasons }
    if (check.approved) {
      ctx.setCycleState("placing_order", d.symbol)
      const fraction = d.action === "close" ? 1 : (d.reduce_pct ?? 50) / 100
      const report = await exitPosition(ctx, i.position, { purpose: d.action === "close" ? "exit" : "reduce", fraction, decisionId: doc._id })
      doc.execution = report
        ? {
            status: report.order.filled_qty > 0 ? (report.order.filled_qty < report.order.qty - 1e-12 ? "partial" : "filled") : "failed",
            order_ids: [report.order._id],
            filled_qty: report.order.filled_qty,
            avg_price: report.order.avg_fill_price,
            notes: report.order.reason ? [report.order.reason] : [],
          }
        : { ...doc.execution, status: "failed", notes: ["exit could not be placed (no market data)"] }
    } else {
      doc.execution.status = "rejected"
    }
  } else if (d.action === "hold" && i.position) {
    // Stops only ever move up on a long: a lower stop would add risk the original plan didn't take.
    const p = i.position
    const newStop = d.stop_loss && (!p.stop_price || d.stop_loss > p.stop_price) && quote && d.stop_loss < quote.bid ? d.stop_loss : p.stop_price
    const newTarget = d.take_profit && quote && d.take_profit > quote.ask ? d.take_profit : p.take_profit_price
    await ctx.ledger.updatePosition(p._id, { stop_price: newStop, take_profit_price: newTarget, last_reviewed_at: now, last_review_price: quote?.mid ?? p.mark_price })
    if (newStop !== p.stop_price) doc.execution.notes.push(`stop raised ${p.stop_price} → ${newStop}`)
  }
  if (i.position && d.action !== "hold") await ctx.ledger.updatePosition(i.position._id, { last_reviewed_at: now, last_review_price: quote?.mid ?? i.position.mark_price })

  await ctx.col.decisions.insertOne(doc)
  ctx.bus.emit(
    "ai.decision.proposed",
    { decision_id: doc._id, instrument: d.symbol, action: d.action, conviction: d.conviction, thesis: d.thesis.slice(0, 280), edge_bps: doc.ev.net_edge_bps, execution: doc.execution.status },
    { summary: `${d.symbol}: ${d.action.replace("_", " ")} (conviction ${d.conviction})`, cycle_id: i.cycleId, instrument: d.symbol },
  )
  if (risk) {
    ctx.bus.emit(
      "risk.checked",
      { decision_id: doc._id, instrument: d.symbol, approved: risk.approved, resized: risk.resized, reasons: risk.reasons.slice(0, 6), qty: risk.approved ? risk.qty : null, notional_usd: risk.approved ? roundTo(risk.notionalUsd, 2) : null },
      {
        summary: risk.approved ? `Risk approved ${d.symbol}${risk.resized ? " (resized)" : ""}` : `Risk rejected ${d.symbol}: ${risk.reasons[0] ?? "rule failed"}`,
        level: risk.approved ? "info" : "warn",
        cycle_id: i.cycleId,
        instrument: d.symbol,
      },
    )
  }
  return doc
}
