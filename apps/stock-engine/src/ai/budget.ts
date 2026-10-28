import { AiBudget as AiBudgetOf } from "@mb/engine-kit/ai/budget"
import { marketDay } from "@mb/stock-core/time"
import type { Collections } from "../db/mongo"

/**
 * The daily AI spend cap (@mb/engine-kit/ai/budget) on stock's budget day, the New York trading
 * day (it ends at midnight New York time), with stock's expected call costs until there is enough
 * history.
 */
export class AiBudget extends AiBudgetOf {
  constructor(col: Pick<Collections, "aiCalls">, budgetUsd: () => number, { now, models }: { now?: () => Date; models?: () => { research: string; decision: string } } = {}) {
    super(col, budgetUsd, { day: marketDay, defaultEstimates: { research: 0.25, decision: 0.1, research_gap: 0.08 } }, now, models)
  }
}
