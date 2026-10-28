import { utcDay } from "@mb/crypto-core/db"
import { AiBudget as AiBudgetOf } from "@mb/engine-kit/ai/budget"
import type { Collections } from "../db/mongo"

/**
 * The daily AI spend cap (@mb/engine-kit/ai/budget) on crypto's budget day, which ends at 00:00
 * UTC, with crypto's expected call costs until there is enough history.
 */
export class AiBudget extends AiBudgetOf {
  constructor(col: Pick<Collections, "aiCalls">, budgetUsd: () => number, { now, models }: { now?: () => Date; models?: () => { research: string; decision: string } } = {}) {
    super(col, budgetUsd, { day: utcDay, defaultEstimates: { research: 0.2, decision: 0.06, research_gap: 0.08 } }, now, models)
  }
}
