import { randomUUID } from "node:crypto"
import { errorMessage } from "@mb/engine-kit/log"
import type { AlpacaAsset, AlpacaPosition } from "@mb/stock-core/alpaca"
import { CORE_TOP_CANDIDATES, coreReviewSchema, normalizeCoreReview, type CoreCandidateContext, type CoreRanking, type CoreReviewContext, type CoreReviewOutput } from "@mb/stock-core/core-book"
import { bookOf, type CoreBookState, type CoreDecisionRecord, type CoreReviewDoc, type CoreReviewKind, type CoreReviewStatus, type CycleDoc, type PositionPlanDoc, type ResearchResult } from "@mb/stock-core/db"
import type { CycleState } from "@mb/stock-core/events"
import { roundTo } from "@mb/stock-core/math"
import { CORE_INDEX_ETFS, parseTheme, type CoreTheme, type Settings } from "@mb/stock-core/settings"
import { addDays, marketClock, marketDay } from "@mb/stock-core/time"
import type { EngineContext } from "../bot/context"
import { cancelSymbolOrders } from "../bot/execute"
import { computeRiskState } from "../bot/risk"
import type { Session } from "../bot/session"
import { snapshotPrice } from "../market/indicators"
import type { CoreRankingStore } from "./data"
import { executeCorePlan, placeCoreStop, pushNote } from "./execute"
import { CORE_PROMPT_VERSION, coreDecisionPrompt, coreResearchPrompt, coreSystemPrompt } from "./prompts"
import { repairCoreReview } from "./repair"
import { CORE_MIN_STOP_PCT, CORE_MIN_WEIGHT_PCT, type CoreHolding, initialCoreStop, planCoreReview } from "./rules"

/**
 * One core review (docs/plans/CORE-BOOK.md §6), run in the engine's cycle slot so it never
 * overlaps a trading cycle:
 *
 *   book (code)       account, positions, the core plans; on the first real review, the one-time
 *                     seed's holdings are adopted into the core book
 *   ranking (code)    rebuilt now, so it covers today's holdings and themes
 *   research (Grok)   the holdings' theses, the themes, the top candidates (web + X search)
 *   decision (Grok)   keep / buy / trim / sell, each with a target weight, thesis and invalidation
 *   rules (code)      ./rules: caps, cash, trade limit, stops; then ./execute in order
 *   record            the review (context, research, output, what code did), the cycle and its trail
 *
 * A dry run does all of it but place orders or change plans: its trades are "planned".
 */

const CORE_RESEARCH_TIMEOUT_MS = 300_000
const MAX_SUMMARY = 600

export type CoreReviewOptions = {
  kind: CoreReviewKind
  /** "schedule", "manual"… */
  trigger: string
  dryRun: boolean
  session: Session
  /** Why new entries are blocked right now (kill switch, pause), or null. */
  entriesBlocked: () => string | null
  ranking: Pick<CoreRankingStore, "build" | "latest">
}

export type CoreReviewOutcome = { reviewId: string; cycleId: string; status: CoreReviewStatus; summary: string | null }

const isStock = (p: AlpacaPosition) => (p.asset_class ?? "us_equity") === "us_equity" && p.side === "long"

/**
 * What the one-time seed bought and still holds, adopted into the core book by its first real
 * review: only while the book has never had a holding or a finished review.
 */
export const seedHoldingsToAdopt = async (ctx: Pick<EngineContext, "col">, stocks: AlpacaPosition[], plans: PositionPlanDoc[]): Promise<{ symbol: string; thesis: string }[]> => {
  if (plans.some((p) => bookOf(p) === "core")) return []
  if (await ctx.col.coreReviews.findOne({ dry_run: false, status: "done" }, { projection: { _id: 1 } })) return []
  const seed = await ctx.col.seedRuns.findOne({ status: "done" }, { sort: { done_at: -1 } })
  const held = new Set(stocks.map((s) => s.symbol))
  const bought = [...new Set((seed?.result?.orders ?? []).filter((o) => o.status === "executed").map((o) => o.symbol))].filter((s) => held.has(s))
  const planBy = new Map(plans.map((p) => [p._id, p]))
  return bought.map((symbol) => ({ symbol, thesis: seed?.result?.allocations.find((a) => a.symbol === symbol)?.thesis || planBy.get(symbol)?.thesis || "Bought by the owner's one-time seed." }))
}

const bookState = (settings: Settings, equity: number, cash: number, holdings: CoreHolding[]): CoreBookState => {
  const value = holdings.reduce((s, h) => s + h.market_value, 0)
  return { equity: roundTo(equity, 2), cash: roundTo(cash, 2), target_pct: settings.core.target_pct, core_value: roundTo(value, 2), core_pct: equity > 0 ? roundTo((value / equity) * 100, 2) : 0, holdings: holdings.map((h) => h.symbol) }
}

const toCandidate = (r: CoreRanking["rows"][number]): CoreCandidateContext => ({
  symbol: r.symbol,
  name: r.name,
  rank: r.rank,
  score: r.score,
  trend_ok: r.trend_ok,
  price: r.price,
  pct_from_sma200: r.pct_from_sma200,
  return_3m_pct: r.return_3m_pct,
  return_6m_pct: r.return_6m_pct,
  return_12_1_pct: r.return_12_1_pct,
  rel_spy_6m_pct: r.rel_spy_6m_pct,
  rel_spy_12m_pct: r.rel_spy_12m_pct,
  from_52w_high_pct: r.from_52w_high_pct,
  volatility_60d_pct: r.volatility_60d_pct,
  max_drawdown_1y_pct: r.max_drawdown_1y_pct,
  themes: r.themes,
})

export const runCoreReview = async (ctx: EngineContext, o: CoreReviewOptions): Promise<CoreReviewOutcome> => {
  const { col, bus, log, alpaca, alerts } = ctx
  const settings = ctx.settings.current
  const c = settings.core
  const day = o.session.day
  const reviewId = randomUUID()
  const cycleId = randomUUID()
  const started = Date.now()
  const label = `Core review${o.dryRun ? " (dry run)" : ""}`
  const meta = { cycle_id: cycleId }

  await col.cycles.insertOne({
    _id: cycleId,
    phase: "intraday",
    trading_day: day,
    trigger: `core review: ${o.trigger}${o.dryRun ? " (dry run)" : ""}`,
    kind: "core",
    status: "running",
    started_at: new Date(),
    finished_at: null,
    duration_ms: null,
    error: null,
    report_id: reviewId,
    steps: [],
    ai_cost_usd: 0,
    settings_version: ctx.settings.version,
  } satisfies CycleDoc)
  const doc: CoreReviewDoc = {
    _id: reviewId,
    cycle_id: cycleId,
    kind: o.kind,
    trigger: o.trigger,
    symbol: null,
    dry_run: o.dryRun,
    status: "running",
    trading_day: day,
    created_at: new Date(),
    finished_at: null,
    book_before: null,
    book_after: null,
    adopted: [],
    ranking: null,
    context: null,
    research: null,
    output: null,
    decisions: [],
    summary: null,
    watch: [],
    model: null,
    cost_usd: 0,
    error: null,
    settings_version: ctx.settings.version,
  }
  await col.coreReviews.insertOne(doc)
  bus.emit("cycle.started", { cycle_id: cycleId, phase: "intraday", trigger: `core review: ${o.trigger}` }, { summary: `${label} started (${o.trigger})`, ...meta })
  bus.emit("core.review.started", { review_id: reviewId, cycle_id: cycleId, kind: o.kind, trigger: o.trigger, symbol: null, dry_run: o.dryRun }, { summary: `${label} started`, ...meta })

  const state = (s: CycleState, detail?: string) => {
    ctx.setCycleState(s, detail)
    bus.emit("cycle.state", { cycle_id: cycleId, state: s, ...(detail ? { detail } : {}) }, { summary: detail ? `${label}: ${detail}` : label, level: "debug", ...meta })
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

  let cost = 0
  const finish = async (status: CoreReviewStatus, fields: Partial<CoreReviewDoc>, error: string | null = null): Promise<CoreReviewOutcome> => {
    const summary = fields.summary ?? null
    await col.coreReviews.updateOne({ _id: reviewId }, { $set: { ...fields, status, error, cost_usd: roundTo(cost, 4), finished_at: new Date() } })
    const cycleStatus = status === "done" ? "succeeded" : status === "skipped" ? "skipped" : "failed"
    await col.cycles.updateOne({ _id: cycleId }, { $set: { status: cycleStatus, finished_at: new Date(), duration_ms: Date.now() - started, ai_cost_usd: roundTo(cost, 4), error } })
    const decisions = fields.decisions ?? []
    bus.emit(
      "core.review.completed",
      {
        review_id: reviewId,
        cycle_id: cycleId,
        status: status === "running" ? "failed" : status,
        dry_run: o.dryRun,
        summary: summary ? summary.slice(0, MAX_SUMMARY) : null,
        decisions: decisions.map((d) => ({ symbol: d.symbol, action: d.action, status: d.status, reason: d.reason })),
        executed: decisions.filter((d) => d.status === "executed").length,
        rejected: decisions.filter((d) => d.status === "rejected").length,
        cost_usd: roundTo(cost, 4),
        error,
      },
      { summary: status === "done" ? `${label} done: ${describe(decisions)}` : `${label} ${status}${error ? `: ${error.slice(0, 200)}` : ""}`, level: status === "done" ? "info" : "warn", ...meta },
    )
    ctx.setCycleState("idle")
    return { reviewId, cycleId, status, summary }
  }

  try {
    // ─── The book ───────────────────────────────────────────────────────
    state("gathering_data", "account, positions, core holdings")
    const { account, holdings, tradingStocks, adopted, firstReview } = await step(
      "book",
      async () => {
        const [account, positions, plans] = await Promise.all([alpaca.getAccount(), alpaca.getPositions(), col.plans.find().toArray()])
        const stocks = positions.filter(isStock)
        const firstReview = !(await col.coreReviews.findOne({ kind: "weekly", dry_run: false, status: "done" }, { projection: { _id: 1 } }))
        const adopt = o.kind === "weekly" ? await seedHoldingsToAdopt(ctx, stocks, plans) : []
        const planBy = new Map(plans.map((p) => [p._id, p]))
        for (const a of adopt) {
          const position = stocks.find((s) => s.symbol === a.symbol)!
          const qty = Math.floor(Number(position.qty))
          const stop = initialCoreStop(Number(position.avg_entry_price), Number(position.current_price), c.stop_pct)
          const fields = { book: "core" as const, thesis: a.thesis, theme: null, stop_loss: stop, take_profit: null, horizon: "multi_day" as const, last_reviewed_at: null, updated_at: new Date() }
          const note = { at: new Date(), review_id: reviewId, action: "adopted" as const, text: "Adopted from the one-time seed into the core book." }
          planBy.set(a.symbol, { ...(planBy.get(a.symbol) ?? { _id: a.symbol, decision_id: null, setup: "core", invalidation: "Stop-loss hit.", opened_at: new Date() }), ...fields, notes: [note] } as PositionPlanDoc)
          if (o.dryRun) continue
          // The seed's OCO (a trading stop and a far target) gives way to the core stop.
          await col.plans.updateOne({ _id: a.symbol }, { $set: fields, $setOnInsert: { decision_id: null, setup: "core", invalidation: "Stop-loss hit.", opened_at: new Date() }, $push: pushNote(note) }, { upsert: true })
          await cancelSymbolOrders(alpaca, a.symbol)
          if (qty >= 1) await placeCoreStop(ctx, a.symbol, qty, stop, null)
        }
        const holdings: CoreHolding[] = stocks.flatMap((p) => {
          const plan = planBy.get(p.symbol)
          const qty = Math.floor(Number(p.qty))
          return plan && bookOf(plan) === "core" && qty >= 1 ? [{ symbol: p.symbol, qty, avg_entry: Number(p.avg_entry_price), price: Number(p.current_price), market_value: Number(p.market_value), plan }] : []
        })
        const core = new Set(holdings.map((h) => h.symbol))
        return { account, holdings, tradingStocks: stocks.filter((s) => !core.has(s.symbol)), adopted: adopt.map((a) => a.symbol), firstReview }
      },
      (b) => `${b.holdings.length} core holdings${b.adopted.length ? ` (adopted ${b.adopted.join(", ")} from the seed${o.dryRun ? ", dry run" : ""})` : ""}, ${b.tradingStocks.length} trading stocks`,
    )
    const equity = Number(account.equity)
    const cash = Number(account.cash)
    const bookBefore = bookState(settings, equity, cash, holdings)
    await col.coreReviews.updateOne({ _id: reviewId }, { $set: { book_before: bookBefore, adopted } })

    // ─── Ranking ────────────────────────────────────────────────────────
    const ranking = await step(
      "ranking",
      async () => {
        const fresh = await o.ranking.build(day)
        const r = fresh ?? (await o.ranking.latest())
        if (!r) throw new Error("no ranking: the long-term data is unavailable")
        return r
      },
      (r) => `${r.rows.filter((x) => x.rank !== null).length} of ${r.rows.length} candidates ranked (bars through ${r.as_of ?? "?"})`,
    )

    // ─── Context ────────────────────────────────────────────────────────
    const themes: CoreTheme[] = c.themes.map(parseTheme).filter((t): t is CoreTheme => t !== null)
    const rowBy = new Map(ranking.rows.map((r) => [r.symbol, r]))
    const held = new Set(holdings.map((h) => h.symbol))
    const shown = ranking.rows.filter((r) => (r.rank !== null && r.rank <= CORE_TOP_CANDIDATES) || r.themes.length > 0 || held.has(r.symbol))
    const risk = computeRiskState(account, 0, 0, settings)
    const lastDone = await col.coreReviews.findOne({ kind: "weekly", dry_run: false, status: "done" }, { sort: { created_at: -1 } })
    const tradingValue = tradingStocks.reduce((s, p) => s + Number(p.market_value), 0)
    const reserveUsd = (equity * settings.risk.cash_reserve_pct) / 100
    const notes: string[] = []
    const blocked = o.entriesBlocked()
    if (blocked) notes.push(`NO BUYS: ${blocked}`)
    if (risk.circuit_breaker) notes.push(`CIRCUIT BREAKER: day P&L ${risk.day_pnl_pct}%: no buys today; sells and trims are allowed`)
    if (bookBefore.core_pct >= c.target_pct - c.band_pct) notes.push(`The book is ${bookBefore.core_pct}% of equity, within ${c.band_pct} points of its ${c.target_pct}% target: no buys unless sells or trims make room`)
    if (holdings.length >= c.max_holdings) notes.push(`${holdings.length} holdings: the maximum. Sell one before buying another`)
    if (holdings.length < c.min_holdings) notes.push(`${holdings.length} holdings, under the minimum of ${c.min_holdings}: build toward it with buys that make the case`)
    const context: CoreReviewContext = {
      now_et: marketClock(new Date()),
      trading_day: day,
      kind: o.kind,
      first_review: firstReview,
      book: {
        equity: roundTo(equity, 2),
        cash: roundTo(cash, 2),
        cash_reserve_pct: settings.risk.cash_reserve_pct,
        deployable_cash: roundTo(Math.max(0, cash - reserveUsd), 2),
        target_pct: c.target_pct,
        band_pct: c.band_pct,
        core_value: bookBefore.core_value,
        core_pct: bookBefore.core_pct,
        trading_value: roundTo(tradingValue, 2),
        trading_pct: equity > 0 ? roundTo((tradingValue / equity) * 100, 2) : 0,
        holdings: holdings.length,
        min_holdings: c.min_holdings,
        max_holdings: c.max_holdings,
        max_holding_pct: c.max_holding_pct,
        max_index_etf_pct: c.max_index_etf_pct,
        index_etfs: [...CORE_INDEX_ETFS],
        max_theme_pct: c.max_theme_pct,
        stop_pct: c.stop_pct,
        min_stop_pct: CORE_MIN_STOP_PCT,
        min_weight_pct: CORE_MIN_WEIGHT_PCT,
        min_conviction: c.min_conviction,
        max_trades: c.max_trades_per_review,
        // Hard blocks only: the band and the holdings limit can be cleared by this review's own sells and trims.
        buys_allowed: !blocked && !risk.circuit_breaker,
        notes,
      },
      holdings: holdings.map((h) => {
        const r = rowBy.get(h.symbol)
        const stop = h.plan.stop_loss
        return {
          symbol: h.symbol,
          name: r?.name ?? null,
          theme: h.plan.theme ?? null,
          qty: h.qty,
          avg_entry: roundTo(h.avg_entry, 2),
          price: roundTo(h.price, 2),
          weight_pct: equity > 0 ? roundTo((h.market_value / equity) * 100, 2) : 0,
          pnl_pct: h.avg_entry > 0 ? roundTo((h.price / h.avg_entry - 1) * 100, 2) : 0,
          stop,
          stop_below_pct: stop !== null && h.price > 0 ? roundTo((1 - stop / h.price) * 100, 2) : null,
          opened_on: marketDay(h.plan.opened_at),
          thesis: h.plan.thesis,
          invalidation: h.plan.invalidation,
          notes: (h.plan.notes ?? []).slice(-4).map((n) => ({ on: marketDay(n.at), action: n.action, text: n.text })),
          metrics: r ? (({ symbol: _s, name: _n, sources: _so, themes: _t, sessions: _se, dollar_volume_20d: _d, ...m }) => m)(r) : null,
        }
      }),
      trading_book: tradingStocks.map((s) => s.symbol),
      candidates: shown.map(toCandidate),
      ranking_as_of: ranking.as_of,
      themes: themes.map((t) => ({ name: t.name, tickers: t.tickers })),
      last_review: lastDone ? { on: lastDone.trading_day, summary: lastDone.summary ?? "", watch: lastDone.watch } : null,
    }
    await col.coreReviews.updateOne({ _id: reviewId }, { $set: { ranking: { day: ranking.day, as_of: ranking.as_of }, context } })

    if (!ctx.ai.available) return await finish("skipped", { book_after: bookBefore }, "AI is disabled (AI_GATEWAY_API_KEY not set)")
    const estimate = (await ctx.budget.estimate("research")) + (await ctx.budget.estimate("decision"))
    const afford = await ctx.budget.canAfford(estimate, { reservePct: settings.wire.mode === "live" ? settings.wire.event_budget_reserve_pct : 0 })
    if (!afford.ok) {
      bus.emit("budget.exhausted", { spent_usd: afford.status.spent_usd, budget_usd: afford.status.budget_usd }, { summary: `AI budget exhausted ($${afford.status.spent_usd.toFixed(2)} of $${afford.status.budget_usd}); the core review waits`, level: "warn", ...meta })
      return await finish("skipped", { book_after: bookBefore }, `daily AI budget exhausted ($${afford.status.spent_usd.toFixed(2)} of $${afford.status.budget_usd}); the next trading day tries again`)
    }

    // ─── Research ───────────────────────────────────────────────────────
    const researchId = randomUUID()
    state("researching", "core holdings, themes, candidates")
    bus.emit("research.started", { cycle_id: cycleId, research_id: researchId, phase: "intraday", model: settings.ai.models.research, focus: [...holdings.map((h) => h.symbol), ...shown.slice(0, 12).map((r) => r.symbol)] }, { summary: "Researching the core book with web + X search", ...meta })
    const research = await step(
      "research",
      () =>
        ctx.ai.research({
          cycleId,
          model: settings.ai.models.research,
          fallback: settings.ai.models.fallback,
          prompt: coreResearchPrompt(context),
          xSearch: settings.ai.x_search,
          fromDate: addDays(day, -30),
          timeoutMs: CORE_RESEARCH_TIMEOUT_MS,
          signal: ctx.signal,
          progress: {
            onQuery: (query, tool) => bus.emit("research.query", { research_id: researchId, query, tool }, { summary: `${tool === "x_search" ? "Searching X" : "Searching the web"}: ${query}`, level: "debug", ...meta }),
            onSource: (s) => bus.emit("research.source", { research_id: researchId, title: s.title ?? s.url, url: s.url, domain: s.domain ?? "" }, { summary: `Reading: ${s.title ?? s.url}`, level: "debug", ...meta }),
            onText: (chars, excerpt) => bus.emit("research.progress", { research_id: researchId, chars, excerpt }, { summary: `Writing the research memo (${chars.toLocaleString("en-US")} chars)`, level: "debug", ...meta }),
          },
        }),
      (r) => (r.error ? `failed: ${r.error}` : `${r.sources.length} sources, ${r.queries.length} searches, ${Math.round(r.duration_ms / 1000)}s`),
    )
    cost += research.cost_usd ?? 0
    bus.emit(
      "research.completed",
      { research_id: researchId, sources: research.sources.length, queries: research.queries.length, duration_ms: research.duration_ms, cost_usd: roundTo(research.cost_usd ?? 0, 4), error: research.error },
      { summary: research.error ? `Research failed: ${research.error}` : `Research done: ${research.sources.length} sources, ${research.queries.length} searches`, level: research.error ? "warn" : "info", ...meta },
    )
    const researchDoc: ResearchResult = { ...research, cost_usd: roundTo(research.cost_usd ?? 0, 4), mode: "full" }
    await col.coreReviews.updateOne({ _id: reviewId }, { $set: { research: researchDoc } })

    // ─── Decision ───────────────────────────────────────────────────────
    state("deciding", settings.ai.models.decision)
    bus.emit("ai.decision.started", { cycle_id: cycleId, model: settings.ai.models.decision }, { summary: `Deciding the core book with ${settings.ai.models.decision}`, ...meta })
    const decision = await step(
      "decision",
      async () => {
        const result = await ctx.ai.structured({
          task: "decision",
          cycleId,
          model: settings.ai.models.decision,
          fallback: settings.ai.models.fallback,
          system: coreSystemPrompt(context, settings.account.starting_capital),
          prompt: coreDecisionPrompt(context, research),
          schema: coreReviewSchema,
          name: "core_review",
          description: "StockMarketBot core book review: one decision per holding, new buys, a watch list.",
          repair: repairCoreReview,
          timeoutMs: settings.ai.decision_timeout_seconds * 1000,
          signal: ctx.signal,
          progress: {
            onPartial: (chars, partial) => {
              const n = Array.isArray((partial as { holdings?: unknown[] } | undefined)?.holdings) ? (partial as { holdings: unknown[] }).holdings.length : 0
              bus.emit("ai.decision.progress", { cycle_id: cycleId, chars, headline: null, decisions: n }, { summary: `Writing the core review (${chars.toLocaleString("en-US")} chars${n ? `, ${n} holdings so far` : ""})`, level: "debug", ...meta })
            },
          },
        })
        return { ...result, output: normalizeCoreReview(result.output as CoreReviewOutput) }
      },
      (d) => `${d.output.holdings.length} decisions (attempt ${d.attempts}${d.repaired ? ", repaired in code" : ""})`,
    ).catch((error) => {
      bus.emit("ai.decision.failed", { cycle_id: cycleId, error: errorMessage(error).slice(0, 500) }, { summary: "Core review decision failed; nothing changes", level: "warn", ...meta })
      throw error
    })
    cost += decision.cost_usd
    const output = decision.output
    bus.emit("ai.decision.completed", { cycle_id: cycleId, decisions: output.holdings.length, attempts: decision.attempts, repaired: decision.repaired, cost_usd: roundTo(decision.cost_usd, 4) }, { summary: `${output.holdings.length} core decisions`, ...meta })
    await col.coreReviews.updateOne({ _id: reviewId }, { $set: { output, model: decision.model } })

    // ─── Rules and execution ────────────────────────────────────────────
    state("executing", o.dryRun ? "planning (dry run)" : `${output.holdings.length} decisions`)
    const buys = output.holdings.filter((h) => h.action === "buy" && !held.has(h.symbol)).map((h) => h.symbol)
    const [snapshots, assets] = await Promise.all([
      buys.length ? alpaca.getSnapshots(buys).catch(() => ({}) as Awaited<ReturnType<typeof alpaca.getSnapshots>>) : Promise.resolve({} as Awaited<ReturnType<typeof alpaca.getSnapshots>>),
      Promise.all(buys.map(async (s) => [s, await alpaca.getAsset(s).catch(() => null)] as [string, AlpacaAsset | null])),
    ])
    const prices = new Map(buys.flatMap((s) => (snapshotPrice(snapshots[s]) !== null ? [[s, snapshotPrice(snapshots[s])!] as [string, number]] : [])))
    const plan = planCoreReview({
      settings,
      equity,
      cash,
      holdings,
      tradingSymbols: new Set(tradingStocks.map((s) => s.symbol)),
      prices,
      assets: new Map(assets),
      themes,
      circuitBreaker: risk.circuit_breaker,
      // Without research there's no evidence to buy on.
      entriesBlocked: blocked ?? (research.error ? `research unavailable (${research.error.slice(0, 120)}): no buys` : null),
      decisions: output.holdings,
    })
    const decisions: CoreDecisionRecord[] = await step(
      o.dryRun ? "plan (dry run)" : "execution",
      () => executeCorePlan(ctx, { reviewId, cycleId, day, plan, holdings: new Map(holdings.map((h) => [h.symbol, h])), dryRun: o.dryRun, reserveUsd }),
      (records) => describe(records),
    )

    // ─── Record ─────────────────────────────────────────────────────────
    let bookAfter = bookBefore
    if (!o.dryRun) {
      const [acct, positions, plans] = await Promise.all([alpaca.getAccount(), alpaca.getPositions(), col.plans.find({ book: "core" }).toArray()])
      const core = new Map(plans.map((p) => [p._id, p]))
      const after = positions.filter((p) => isStock(p) && core.has(p.symbol)).map((p) => ({ symbol: p.symbol, qty: Math.floor(Number(p.qty)), avg_entry: Number(p.avg_entry_price), price: Number(p.current_price), market_value: Number(p.market_value), plan: core.get(p.symbol)! }))
      bookAfter = bookState(settings, Number(acct.equity), Number(acct.cash), after)
    }
    const failed = decisions.filter((d) => d.status === "failed")
    if (failed.length) await alerts.send("error", `Core review: ${failed.length} order${failed.length > 1 ? "s" : ""} failed`, failed.map((d) => `${d.symbol} ${d.action}: ${d.reason}`).join("\n"), { path: "/core" })
    const fields = Object.fromEntries(decisions.filter((d) => d.action !== "keep" || d.request).map((d) => [d.symbol, `${d.action} · ${d.status}${d.qty ? ` · ${d.qty} shares` : ""}${d.status === "rejected" && d.reason ? ` (${d.reason})` : ""}`]))
    if (o.dryRun) await alerts.send("info", `${label} done: nothing was traded`, output.summary.slice(0, 1_500), { path: "/core", fields })
    else await alerts.success(`${label} done`, output.summary.slice(0, 1_500), { path: "/core", key: `core|${reviewId}`, fields })
    log.info("core review completed", { review_id: reviewId, dry_run: o.dryRun, prompt_version: CORE_PROMPT_VERSION, executed: decisions.filter((d) => d.status === "executed").length })
    return await finish("done", { decisions, summary: output.summary, watch: output.watch, book_after: bookAfter })
  } catch (error) {
    const message = errorMessage(error)
    log.error("core review failed", { review_id: reviewId, error: message })
    await alerts.send("error", `${label} failed`, message.slice(0, 1_000), { path: "/core", fields: { Review: reviewId } })
    return finish("failed", {}, message.slice(0, 1_000))
  }
}

/** "SPY keep, DIA trim executed, NVDA buy planned…" for the live feed. */
const describe = (records: CoreDecisionRecord[]) =>
  records.length ? records.map((d) => `${d.symbol} ${d.action}${d.action === "keep" && d.status === "noop" ? "" : ` ${d.status}`}`).join(", ") : "no decisions"
