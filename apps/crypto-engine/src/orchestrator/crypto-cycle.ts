import { randomUUID } from "node:crypto"
import type { CandidateRecord, CycleKind, PositionDoc, RegimeSnapshot, ResearchPlan, SeedAllocation, SeedOrder, SymbolFeatures } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { cryptoReportSchema, normalizeCryptoReport, type NormalizedCryptoDecision } from "@mb/crypto-core/report"
import type { Settings } from "@mb/crypto-core/settings"
import type { StrategyId } from "@mb/crypto-core/strategies"
import type { EventFocus } from "@mb/crypto-core/wire"
import { ACCOUNT_ID } from "@mb/crypto-core/venues"
import { errorMessage } from "@mb/engine-kit/log"
import { cleanLine } from "@mb/engine-kit/util/text"
import { CRYPTO_PROMPT_VERSION, cryptoDecisionPrompt, cryptoDecisionSystemPrompt, cryptoGapFillPrompt, cryptoResearchPrompt, eventSection, type CryptoSubject } from "../ai/prompts"
import { repairCryptoReport } from "../ai/repair"
import type { ResearchResult } from "../ai/runner"
import { classifyRegime, featuresForPrompt, type Features } from "../market/features"
import { correlationMatrix } from "../risk/correlation"
import { roundTripCostBps } from "../risk/sizing"
import { CRYPTO_STRATEGIES, screenCrypto } from "../strategies/registry"
import { boundedStop, candidateFeatures, clampScore, type CryptoCandidate } from "../strategies/types"
import { buildDossier, type Dossier } from "../wire/dossier"
import { cycleStep, decisionProgressEvent, finishCycle, reasoningEvent, type EngineContext } from "./context"
import { loadFeatures, processDecision, viableSetup } from "./decide"
import { runSeedCycle } from "./seed"

/**
 * One decision cycle:
 *   1. market data → features (code)            5. structured AI decision per candidate/position
 *   2. quant screens → candidates (code)        6. EV, costs and size (code)
 *   3. positions due for review                 7. deterministic risk checks, then execution
 *   4. live research (local model + web)        8. everything recorded for later evaluation
 *
 * No candidates and no reviews means no AI call. Missing data or a failed AI call
 * means no new trades; positions stay protected by stops either way.
 */

const HOUR = 3_600_000
/** Long-term trend holds are reviewed at most daily, and on daily-ATR moves, not hourly ones. */
const DAILY_REVIEW_MINUTES = 1_440
/** A setup on hourly or 4h candles that the AI has ruled on isn't asked about again for this long. */
const SETUP_REASK_MINUTES = 120

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


/**
 * The screen setups ("SYMBOL strategy") the AI ruled on too recently to ask about again: daily-trend
 * setups only change with a new daily candle (a day), the others within a few hourly ones (2 h).
 */
export const recentlyJudged = async (col: Pick<EngineContext["col"], "decisions">, now: number) => {
  const docs = await col.decisions
    .find(
      { strategy_id: { $in: CRYPTO_STRATEGIES.map((s) => s.id) }, created_at: { $gte: new Date(now - DAILY_REVIEW_MINUTES * 60_000) } },
      { projection: { symbol: 1, strategy_id: 1, created_at: 1 } },
    )
    .toArray()
  const window = (s: StrategyId | null) => (s === "daily_trend" ? DAILY_REVIEW_MINUTES : SETUP_REASK_MINUTES) * 60_000
  return new Set(docs.filter((d) => now - d.created_at.getTime() <= window(d.strategy_id)).map((d) => `${d.symbol} ${d.strategy_id}`))
}

export type { ResearchPlan }

/**
 * Which web research a cycle runs. Full whenever the wire is off or
 * unhealthy. auto runs the gap-fill whenever the dossier has a gap on the cycle's subjects (its
 * candidates and the holdings it reviews) or on the market: an unexplained move, an unconfirmed
 * high-severity item. It skips web research otherwise.
 */
export const researchPlan = (
  ctx: Pick<EngineContext, "settings">,
  { isEvent, wireHealthy, dossier }: { isEvent: boolean; wireHealthy: boolean; dossier: Dossier | null },
): ResearchPlan => {
  const w = ctx.settings.current.wire
  if (isEvent) return w.event_research === "none" ? { kind: "none", reason: "event cycle with event_research none: the dossier is the evidence" } : { kind: "gap", reason: "event check (x_verify)" }
  if (!dossier) return { kind: "full", reason: "news engine off" }
  if (!wireHealthy) return { kind: "full", reason: "news engine unhealthy" }
  if (w.research_mode === "full") return { kind: "full", reason: "research_mode full" }
  if (w.research_mode === "gap_fill") return { kind: "gap", reason: "research_mode gap_fill" }
  if (dossier.unexplained.length || dossier.unconfirmed.length) return { kind: "gap", reason: `${dossier.unexplained.length} unexplained moves, ${dossier.unconfirmed.length} unconfirmed items` }
  return { kind: "none", reason: "no unexplained moves or unconfirmed items in our feeds" }
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
  // Once the AI has ruled on a setup, don't pay to ask again until it can have changed.
  const judged = canEnter && !isEvent ? await recentlyJudged(ctx.col, Date.now()) : new Set<string>()
  const takerBps = ctx.feeBps()
  const estRoundTrip = (f: Features) => Math.round(roundTripCostBps({ takerFeeBps: takerBps, spreadBps: f.spread_bps, entrySlippageBps: 3, exitSlippageBps: 3 }))
  const passedOver: string[] = []
  // Event cycles look only at what the news engine flagged: no screens, no re-ask filter.
  const candidates = !canEnter
    ? []
    : isEvent
      ? eventCandidates(events, fresh, held, settings)
      : screenCrypto({ regime, features: fresh, held, settings })
          .filter((c) => {
            const f = byFeature.get(c.symbol)!
            const why = judged.has(`${c.symbol} ${c.strategy}`) ? "ruled on recently" : viableSetup(c, f.price, estRoundTrip(f), settings.kraken) ? null : "levels can't pass reward:risk or costs"
            if (why) passedOver.push(`${c.symbol} ${c.strategy} (${why})`)
            return !why
          })
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
        ? `idle: no setups in a ${regime.label} market${passedOver.length ? `; passed over ${passedOver.slice(0, 5).join(", ")}${passedOver.length > 5 ? ` and ${passedOver.length - 5} more` : ""}` : ""}`
        : "idle: entries blocked and no positions due for review"
    return finish("completed", why, { regime })
  }

  // 4. The wire dossier, then research: full, gap-fill, or skipped when our feeds cover it.
  if (!ctx.ai.available) return finish("skipped", "AI disabled (LLM_URL not set): no new decisions")
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
  const wireHealthy = !!wire && wire.healthy()
  const plan = researchPlan(ctx, { isEvent, wireHealthy, dossier })

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
      prompt: plan.kind === "full" ? cryptoResearchPrompt({ now: new Date(), regime, subjects }) : cryptoGapFillPrompt({ now: new Date(), regime, subjects, wire: dossier?.text ?? "", event: eventText }),
      task: plan.kind === "gap" ? "research_gap" : "research",
      fromDate: new Date(Date.now() - (plan.kind === "gap" ? 1 : 3) * 86_400_000).toISOString().slice(0, 10),
      timeoutMs: (isEvent ? settings.wire.event_research_timeout_seconds : settings.ai.research_timeout_seconds) * 1000,
      signal: ctx.signal,
      progress: {
        onQuery: (query, tool) => ctx.bus.emit("research.query", { research_id: researchId, query, tool }, { summary: `Searching: ${query}`, cycle_id: cycleId, level: "debug" }),
        onSource: (s) => ctx.bus.emit("research.source", { research_id: researchId, ...s }, { summary: `Source: ${s.title}`, cycle_id: cycleId, level: "debug" }),
        onText: (chars, excerpt) => ctx.bus.emit("research.progress", { research_id: researchId, chars, excerpt }, { summary: `Writing research memo (${chars} chars)`, cycle_id: cycleId, level: "debug" }),
        onReasoning: reasoningEvent(ctx, cycleId, "research"),
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
  await ctx.col.cycles.updateOne({ _id: cycleId }, { $set: { research_plan: plan, ...(plan.kind === "none" ? { research_skip_reason: plan.reason } : {}) } })
  if (plan.kind === "none") {
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
  const equity = riskState?.equityUsd ?? 0
  const positionWeights = new Map(positions.map((p) => [p.symbol, equity > 0 ? ((p.qty * (p.mark_price ?? p.avg_price)) / equity) * 100 : 0]))
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
      progress: { onPartial: decisionProgressEvent(ctx, cycleId), onReasoning: reasoningEvent(ctx, cycleId, "decision") },
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

