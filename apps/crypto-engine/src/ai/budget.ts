import { randomUUID } from "node:crypto"
import type { AiCallDoc, AiTask } from "@mb/crypto-core/db"
import { utcDay } from "@mb/crypto-core/db"
import type { Collections } from "../db/mongo"

/**
 * Daily AI spend cap. Every model call is recorded with its cost (the gateway's reported cost
 * when available, else a conservative token-based estimate). Before a call, the expected cost
 * (the recent average for that task) must fit in what's left of today's budget. When it doesn't,
 * the engine makes no AI calls, so it opens no new trades, until 00:00 UTC; deterministic stops
 * and risk controls keep running.
 */

/** Conservative fallback pricing when the gateway reports no cost (USD per 1M tokens). */
const FALLBACK_PRICE = { input: 3, output: 15 }
/** Per search/tool call, used only for estimates. */
const FALLBACK_TOOL_COST = 0.01
const DEFAULT_ESTIMATE: Record<AiTask, number> = { research: 0.2, decision: 0.06, research_gap: 0.08 }

export const estimateCost = (inputTokens: number, outputTokens: number, toolCalls = 0) =>
  (inputTokens * FALLBACK_PRICE.input + outputTokens * FALLBACK_PRICE.output) / 1_000_000 + toolCalls * FALLBACK_TOOL_COST

/**
 * Reads the cost the Vercel AI Gateway attaches to provider metadata, if any. With your own
 * provider key (BYOK) the gateway reports `cost: "0"` and puts what the provider bills in
 * `marketCost`, so the largest reported figure is what the call actually cost.
 */
export const gatewayCost = (providerMetadata: unknown): number | null => {
  const g = (providerMetadata as { gateway?: Record<string, unknown> } | undefined)?.gateway
  const costs = [g?.cost, g?.totalCost, g?.marketCost]
    .map((raw) => (typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN))
    .filter((n) => Number.isFinite(n) && n >= 0)
  return costs.length ? Math.max(...costs) : null
}

export type BudgetStatus = { day: string; spent_usd: number; budget_usd: number; remaining_usd: number; calls: number }

export class AiBudget {
  private cache: { day: string; spent: number; calls: number; at: number } | null = null

  constructor(
    private readonly col: Pick<Collections, "aiCalls">,
    private readonly budgetUsd: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(): Promise<BudgetStatus> {
    const day = utcDay(this.now())
    if (!this.cache || this.cache.day !== day || Date.now() - this.cache.at > 60_000) {
      const [agg] = await this.col.aiCalls
        .aggregate<{ spent: number; calls: number }>([{ $match: { day } }, { $group: { _id: null, spent: { $sum: "$cost_usd" }, calls: { $sum: 1 } } }])
        .toArray()
      this.cache = { day, spent: agg?.spent ?? 0, calls: agg?.calls ?? 0, at: Date.now() }
    }
    const budget = this.budgetUsd()
    return { day, spent_usd: this.cache.spent, budget_usd: budget, remaining_usd: Math.max(0, budget - this.cache.spent), calls: this.cache.calls }
  }

  /** Expected cost of the next call for a task: the average of its last 10 successful calls. */
  async estimate(task: AiTask): Promise<number> {
    const recent = await this.col.aiCalls.find({ task, ok: true }, { projection: { cost_usd: 1 } }).sort({ at: -1 }).limit(10).toArray()
    if (recent.length < 3) return DEFAULT_ESTIMATE[task]
    return recent.reduce((s, c) => s + c.cost_usd, 0) / recent.length
  }

  /**
   * What a call that ended without reporting usage (a timeout or abort) probably cost: how long it
   * ran × the cost per second of that model's recent successful calls for the task.
   */
  async estimateByDuration(task: AiTask, model: string, durationMs: number): Promise<number> {
    const recent = await this.col.aiCalls
      .find({ task, model, ok: true, cost_usd: { $gt: 0 } }, { projection: { cost_usd: 1, duration_ms: 1 } })
      .sort({ at: -1 })
      .limit(10)
      .toArray()
    const ms = recent.reduce((s, c) => s + c.duration_ms, 0)
    if (recent.length < 3 || ms <= 0) return DEFAULT_ESTIMATE[task]
    return (recent.reduce((s, c) => s + c.cost_usd, 0) / ms) * durationMs
  }

  /**
   * Whether a call fits today's budget. `reservePct` keeps that share of the budget off-limits:
   * scheduled cycles pass the news engine's event reserve, so event cycles always have room.
   */
  async canAfford(estimateUsd: number, { reservePct = 0 }: { reservePct?: number } = {}): Promise<{ ok: boolean; status: BudgetStatus }> {
    const status = await this.status()
    const usable = Math.max(0, status.budget_usd * (1 - reservePct / 100) - status.spent_usd)
    return { ok: usable >= estimateUsd, status }
  }

  async record(call: Omit<AiCallDoc, "_id" | "day" | "at">) {
    const at = this.now()
    const doc: AiCallDoc = { _id: randomUUID(), at, day: utcDay(at), ...call }
    await this.col.aiCalls.insertOne(doc)
    if (this.cache?.day === doc.day) {
      this.cache.spent += doc.cost_usd
      this.cache.calls += 1
    }
  }
}
