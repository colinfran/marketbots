import { randomUUID } from "node:crypto"
import type { CandidateRecord, DecisionDoc, RegimeSnapshot, SeedAllocation, SeedOrder, SymbolFeatures } from "@mb/crypto-core/db"
import { roundTo } from "@mb/crypto-core/math"
import { normalizeSeedAllocation, seedAllocationSchema, type NormalizedCryptoDecision, type SeedAllocationItem } from "@mb/crypto-core/report"
import { CRYPTO_SEED_PROMPT_VERSION, cryptoSeedDecisionPrompt, cryptoSeedResearchPrompt, cryptoSeedSystemPrompt, type CryptoSubject } from "../ai/prompts"
import { repairSeedAllocation } from "../ai/repair"
import type { ResearchResult } from "../ai/runner"
import { errorMessage } from "../log"
import { classifyRegime, featuresForPrompt, type Features } from "../market/features"
import { correlationMatrix } from "../risk/correlation"
import { boundedStop, candidateFeatures, type CryptoCandidate } from "../strategies/types"
import { cycleStep, finishCycle, type EngineContext } from "./context"
import { loadFeatures, processDecision, summarize, type CycleResult, type SeedOutcome } from "./crypto-cycle"

/**
 * The one-time seed: the owner chose to put a dollar amount into long-term core holdings at a
 * set time, and research that morning decides what to buy.
 *
 *   features → candidates (every fresh, unheld universe pair with daily-trend levels)
 *   → full Grok research (long-term outlook, macro, flows) → structured allocation (1-4 pairs)
 *   → each allocation sized at amount × weight → the normal risk engine (owner-directed: no
 *     conviction, edge or reward:risk gate; every other gate and cap applies) → execution.
 *
 * The positions are ordinary daily_trend positions afterwards. Nothing here retries.
 */

const HOUR = 3_600_000

/** Daily-trend style levels for a seed candidate: stop 2.5 daily ATR (bounded), target 3R. */
export const seedCandidate = (f: Features, settings: EngineContext["settings"]["current"]): CryptoCandidate => {
  const atr = f.atr_pct_1d !== null ? (f.atr_pct_1d / 100) * f.price : 2 * (f.atr_1h ?? f.price * 0.015)
  const stop = boundedStop(f.price, 2.5 * atr, settings)
  const trend = f.sma50_1d !== null && f.sma200_1d !== null ? `50-day ${f.sma50_1d > f.sma200_1d ? "above" : "below"} the 200-day, price ${f.price > f.sma200_1d ? "above" : "below"} the 200-day` : "daily trend n/a"
  return {
    instrument: f.symbol,
    symbol: f.symbol,
    strategy: "daily_trend",
    score: 50,
    signal: `One-time seed candidate (${trend}; 30d ${f.ret_30d_pct ?? "n/a"}%).`,
    features: candidateFeatures(f),
    stop_hint: stop,
    target_hint: f.price + 3 * (f.price - stop),
  }
}

/** The allocation as decisions the normal pipeline understands. */
const toDecision = (a: SeedAllocationItem, amountUsd: number): NormalizedCryptoDecision => ({
  symbol: a.symbol,
  action: "buy",
  conviction: a.conviction,
  uncertainty: "medium",
  p_target_first: null,
  stop_loss: a.stop_loss,
  take_profit: a.take_profit,
  horizon_hours: a.horizon_hours,
  size_pct_of_max: null,
  reduce_pct: null,
  priced_in: "unknown",
  thesis: a.thesis,
  bull_evidence: [],
  bear_evidence: [],
  risks: [],
  invalidation: a.invalidation,
  notes: [`one-time seed: ${a.weight_pct}% of $${amountUsd.toLocaleString("en-US")}`],
  defaulted: false,
})

const orderOf = (doc: DecisionDoc): SeedOrder => ({
  symbol: doc.symbol,
  decision_id: doc._id,
  status: doc.execution.status,
  qty: doc.execution.filled_qty || doc.sizing.qty,
  notional_usd: doc.execution.avg_price && doc.execution.filled_qty ? roundTo(doc.execution.avg_price * doc.execution.filled_qty, 2) : doc.sizing.notional_usd,
  reason: doc.risk && !doc.risk.approved ? (doc.risk.reasons[0] ?? "rejected by risk") : (doc.execution.notes[0] ?? null),
})

export const runSeedCycle = async (ctx: EngineContext, { trigger, seed }: { trigger: string; seed: { id: string; amountUsd: number } }): Promise<CycleResult & { seed: SeedOutcome }> => {
  const settings = ctx.settings.current
  const cycleId = randomUUID()
  const started = Date.now()
  const outcome: SeedOutcome = { allocations: [], orders: [], notes: [], rationale: null, executed: 0 }
  let summaries = new Map<string, SymbolFeatures>()
  await ctx.col.cycles.insertOne({
    _id: cycleId,
    trigger,
    kind: "seed",
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
    prompt_version: CRYPTO_SEED_PROMPT_VERSION,
  })
  ctx.bus.emit("cycle.started", { cycle_id: cycleId, trigger }, { summary: `One-time seed started ($${seed.amountUsd.toLocaleString("en-US")})`, cycle_id: cycleId })
  ctx.bus.emit("seed.started", { seed_id: seed.id, cycle_id: cycleId, amount_usd: seed.amountUsd }, { summary: `One-time seed of $${seed.amountUsd.toLocaleString("en-US")} started`, cycle_id: cycleId })

  const finish = async (status: CycleResult["status"], summary: string, extra: Parameters<typeof finishCycle>[3] = {}) => {
    await finishCycle(ctx.col, cycleId, started, { status, summary, ...extra })
    ctx.setCycleState("idle")
    if (status === "skipped") ctx.bus.emit("cycle.skipped", { reason: summary }, { summary: `Seed skipped: ${summary}`, level: "warn", cycle_id: cycleId })
    else if (status === "failed") ctx.bus.emit("cycle.failed", { cycle_id: cycleId, error: extra.error ?? summary }, { summary: `Seed failed: ${summary}`, level: "warn", cycle_id: cycleId })
    else {
      ctx.bus.emit(
        "cycle.completed",
        { cycle_id: cycleId, duration_ms: Date.now() - started, decisions: outcome.orders.length, approved: outcome.orders.filter((o) => o.status !== "rejected").length, executed: outcome.executed, ai_cost_usd: roundTo(extra.ai_cost_usd ?? 0, 4), summary },
        { summary: `Seed done: ${outcome.executed} of ${outcome.orders.length} buys executed`, cycle_id: cycleId },
      )
    }
    return { cycleId, status, summary, features: summaries, seed: outcome }
  }

  // 1. Features.
  ctx.setCycleState("screening", "seed: computing features")
  const { features, failures } = await loadFeatures(ctx, ctx.hub.universe)
  summaries = new Map(features.map((f) => [f.symbol, summarize(f)]))
  await cycleStep(ctx.col, cycleId, "features", features.length > 0, `${features.length} symbols${failures.length ? `; ${failures.slice(0, 5).join("; ")}` : ""}`)
  const fresh = features.filter((f) => f.quote_age_s <= settings.kraken.max_quote_age_seconds)
  if (!fresh.length) return finish("skipped", "no fresh market data")
  const regime: RegimeSnapshot = classifyRegime(features)
  const byFeature = new Map(features.map((f) => [f.symbol, f]))

  // 2. Candidates: every fresh universe pair not already held (adding to a position is disabled).
  const positions = await ctx.ledger.openPositions()
  const held = new Set(positions.map((p) => p.symbol))
  const gate = ctx.gate()
  const blocked =
    gate.runStatus !== "running" ? `engine is ${gate.runStatus}` : gate.killSwitch ? "kill switch engaged" : !gate.venueOnline ? "Kraken or the paper wallet is offline" : !gate.reconciled ? "books don't match the paper wallet" : null
  if (blocked) return finish("skipped", `entries blocked: ${blocked}`, { regime })
  const candidates = fresh.filter((f) => !held.has(f.symbol)).map((f) => seedCandidate(f, settings))
  if (!candidates.length) return finish("skipped", "every universe pair is already held", { regime })
  const candidateRecords: CandidateRecord[] = candidates.map(({ symbol: _s, stop_hint, target_hint, ...rest }) => ({ ...rest, features: { ...rest.features, stop_hint: roundTo(stop_hint, 6), target_hint: roundTo(target_hint, 6) } }))
  await ctx.col.cycles.updateOne({ _id: cycleId }, { $set: { regime, candidates: candidateRecords } })
  ctx.bus.emit(
    "screen.candidates",
    { cycle_id: cycleId, candidates: candidates.map((c) => ({ instrument: c.symbol, strategy: c.strategy, score: c.score, signal: c.signal })), reviews: [], regime: regime.label, symbols: fresh.length },
    { summary: `Seed: ${candidates.length} candidates (regime: ${regime.label})`, cycle_id: cycleId },
  )

  // 3. Budget, then full research.
  if (!ctx.ai.available) return finish("skipped", "AI disabled (AI_GATEWAY_API_KEY not set)", { regime })
  const estimate = (await ctx.budget.estimate("research")) + (await ctx.budget.estimate("decision"))
  const afford = await ctx.budget.canAfford(estimate)
  if (!afford.ok) return finish("skipped", `daily AI budget exhausted ($${afford.status.spent_usd.toFixed(2)} of $${afford.status.budget_usd})`, { regime })

  const subjects: CryptoSubject[] = candidates.map((c) => ({ symbol: c.symbol, role: "candidate", note: c.signal }))
  const researchId = randomUUID()
  ctx.setCycleState("researching", `seed: ${subjects.map((s) => s.symbol).join(", ")}`)
  ctx.bus.emit("research.started", { cycle_id: cycleId, research_id: researchId, subjects: subjects.map((s) => s.symbol), model: settings.ai.models.research }, { summary: `Seed research: ${subjects.map((s) => s.symbol).join(", ")}`, cycle_id: cycleId })
  const research: ResearchResult = await ctx.ai.research({
    cycleId,
    model: settings.ai.models.research,
    fallback: settings.ai.models.fallback,
    prompt: cryptoSeedResearchPrompt({ now: new Date(), regime, subjects, amountUsd: seed.amountUsd }),
    xSearch: settings.ai.x_search,
    fromDate: new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10),
    timeoutMs: settings.ai.research_timeout_seconds * 1000,
    signal: ctx.signal,
    progress: {
      onQuery: (query, tool) => ctx.bus.emit("research.query", { research_id: researchId, query, tool }, { summary: `Searching: ${query}`, cycle_id: cycleId, level: "debug" }),
      onSource: (s) => ctx.bus.emit("research.source", { research_id: researchId, ...s }, { summary: `Source: ${s.title}`, cycle_id: cycleId, level: "debug" }),
      onText: (chars, excerpt) => ctx.bus.emit("research.progress", { research_id: researchId, chars, excerpt }, { summary: `Writing research memo (${chars} chars)`, cycle_id: cycleId, level: "debug" }),
    },
  })
  await ctx.col.research.insertOne({
    _id: researchId,
    cycle_id: cycleId,
    subjects: subjects.map((s) => s.symbol),
    memo: research.memo,
    sources: research.sources,
    queries: research.queries,
    model: research.model,
    prompt_version: CRYPTO_SEED_PROMPT_VERSION,
    x_search: research.x_search,
    started_at: new Date(started),
    duration_ms: research.duration_ms,
    usage: research.usage,
    cost_usd: research.cost_usd,
    error: research.error,
  })
  ctx.bus.emit(
    "research.completed",
    { research_id: researchId, sources: research.sources.length, queries: research.queries.length, duration_ms: research.duration_ms, cost_usd: research.cost_usd, error: research.error },
    { summary: research.error ? `Seed research failed: ${research.error}` : `Seed research done: ${research.sources.length} sources`, level: research.error ? "warn" : "info", cycle_id: cycleId },
  )
  await cycleStep(ctx.col, cycleId, "research", !research.error, research.error ?? `${research.sources.length} sources`)

  // 4. Structured allocation.
  ctx.setCycleState("evaluating", "seed allocation")
  ctx.bus.emit("ai.decision.started", { cycle_id: cycleId, model: settings.ai.models.decision, items: subjects.map((s) => s.symbol) }, { summary: "Deciding the seed allocation", cycle_id: cycleId })
  const riskState = await ctx.ledger.riskState()
  const takerBps = ctx.feeBps()
  let aiCost = research.cost_usd
  let model: string
  let chosen: SeedAllocationItem[] = []
  try {
    const result = await ctx.ai.structured({
      task: "decision",
      cycleId,
      model: settings.ai.models.decision,
      fallback: settings.ai.models.fallback,
      system: cryptoSeedSystemPrompt(),
      prompt: cryptoSeedDecisionPrompt({
        now: new Date(),
        regime,
        amountUsd: seed.amountUsd,
        account: riskState ? { mode: "paper", equity_usd: roundTo(riskState.equityUsd, 2), cash_usd: roundTo(riskState.cashUsd, 2), open_positions: positions.length } : { mode: "paper" },
        limits: {
          max_position_pct: settings.kraken.max_position_pct,
          max_total_exposure_pct: settings.kraken.max_total_exposure_pct,
          max_correlated_exposure_pct: settings.kraken.max_correlated_exposure_pct,
          stop_range_pct: [settings.kraken.min_stop_pct, settings.kraken.max_stop_pct],
          fee_bps_per_side: takerBps,
        },
        candidates: candidates.map((c) => ({ symbol: c.symbol, signal: c.signal, stop_hint: roundTo(c.stop_hint, 6), target_hint: roundTo(c.target_hint, 6), features: featuresForPrompt(byFeature.get(c.symbol)!) })),
        held: [...held],
        memo: research.memo,
        researchError: research.error,
      }),
      schema: seedAllocationSchema,
      name: "seed_allocation",
      description: "CryptoMarketBot one-time seed: 1-4 long-term core holdings with weights.",
      repair: repairSeedAllocation,
      timeoutMs: settings.ai.decision_timeout_seconds * 1000,
      signal: ctx.signal,
    })
    aiCost += result.cost_usd
    model = result.model
    const normalized = normalizeSeedAllocation(result.output, { candidates: new Set(candidates.map((c) => c.symbol)) })
    chosen = normalized.allocations
    outcome.rationale = normalized.rationale
    outcome.notes.push(...normalized.notes)
    outcome.allocations = normalized.allocations.map((a) => ({ symbol: a.symbol, weight_pct: a.weight_pct, notional_usd: roundTo((seed.amountUsd * a.weight_pct) / 100, 2), thesis: a.thesis }))
    ctx.bus.emit(
      "ai.decision.completed",
      { cycle_id: cycleId, decisions: normalized.allocations.length, attempts: result.attempts, repaired: result.repaired, cost_usd: roundTo(aiCost, 4) },
      { summary: `Seed allocation: ${outcome.allocations.map((a) => `${a.symbol} ${a.weight_pct}%`).join(", ") || "nothing"}`, cycle_id: cycleId },
    )
  } catch (error) {
    const message = errorMessage(error)
    ctx.bus.emit("ai.decision.failed", { cycle_id: cycleId, error: message }, { summary: "Seed allocation failed; nothing bought", level: "warn", cycle_id: cycleId })
    return finish("failed", "AI allocation failed; nothing bought", { error: message.slice(0, 1000), research_id: researchId, ai_cost_usd: aiCost, regime })
  }
  if (!outcome.allocations.length) return finish("failed", "the AI allocated nothing", { research_id: researchId, ai_cost_usd: aiCost, regime })

  // 5. Risk and execution, largest weight first.
  ctx.setCycleState("risk_check")
  const matrix = correlationMatrix(new Map(features.map((f) => [f.symbol, f.closes_1h])))
  const decisionIds: string[] = []
  for (const a of [...chosen].sort((x, y) => y.weight_pct - x.weight_pct)) {
    const notional = roundTo((seed.amountUsd * a.weight_pct) / 100, 2)
    try {
      const doc = await processDecision(ctx, {
        cycleId,
        researchId,
        decision: toDecision(a, seed.amountUsd),
        candidate: candidates.find((c) => c.symbol === a.symbol) ?? null,
        position: null,
        features: byFeature.get(a.symbol) ?? null,
        takerBps,
        matrix,
        decisionModel: model,
        triggerKind: "seed",
        seed: { notionalUsd: notional },
        promptVersion: CRYPTO_SEED_PROMPT_VERSION,
      })
      decisionIds.push(doc._id)
      outcome.orders.push(orderOf(doc))
      if (doc.execution.status === "filled" || doc.execution.status === "partial") outcome.executed += 1
    } catch (error) {
      ctx.log.error("seed buy failed", { symbol: a.symbol, error: errorMessage(error) })
      outcome.orders.push({ symbol: a.symbol, decision_id: null, status: "failed", qty: null, notional_usd: null, reason: errorMessage(error).slice(0, 300) })
    }
  }

  const summary = `seed: ${outcome.executed} of ${outcome.orders.length} buys executed (${outcome.allocations.map((a) => `${a.symbol} ${a.weight_pct}%`).join(", ")})`
  return finish("completed", summary, { decision_ids: decisionIds, research_id: researchId, ai_cost_usd: aiCost, regime })
}
