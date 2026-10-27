import { extractJson, lenientList, nullableNum, nullableStr, num, str, strictEnum, strList } from "@mb/engine-kit/ai/repair"
import { CORE_ACTIONS, coreReviewSchema, type CoreReviewOutput } from "@mb/stock-core/core-book"
import { cleanTicker } from "@mb/stock-core/report"
import { z } from "zod"

/**
 * Salvages a review answer that almost matched `coreReviewSchema` (JSON in prose or fences,
 * numbers as strings, enum casing, a single item instead of a list), like ../ai/repair does for the
 * cycle report. It never invents a trade: an entry whose symbol or action can't be read cleanly is
 * dropped, and an answer without a summary is not repaired at all.
 */

const ticker = z.preprocess((v) => cleanTicker(String(v ?? "")), z.string().regex(/^[A-Z][A-Z.]{0,9}$/))

const lenientReview = z.object({
  summary: z.string().min(1),
  holdings: lenientList(
    z.object({
      symbol: ticker,
      action: strictEnum(CORE_ACTIONS),
      target_weight_pct: nullableNum,
      conviction: num(5),
      thesis: str,
      invalidation: str,
      verdict: str,
      theme: nullableStr,
      stop: nullableNum,
      evidence: strList,
    }),
  ),
  watch: lenientList(z.object({ symbol: ticker, reason: str, trigger: str })),
  sources: lenientList(z.object({ title: str, url: z.string().min(1) })),
})

export const repairCoreReview = (text: string | undefined): { report: CoreReviewOutput; dropped: number } | null => {
  if (!text) return null
  const raw = extractJson(text)
  if (!raw || typeof raw !== "object") return null
  const lenient = lenientReview.safeParse(raw)
  if (!lenient.success) return null
  const strict = coreReviewSchema.safeParse(lenient.data)
  if (!strict.success) return null
  const rawHoldings = (raw as { holdings?: unknown }).holdings
  const requested = Array.isArray(rawHoldings) ? rawHoldings.length : 0
  return { report: strict.data, dropped: Math.max(0, requested - strict.data.holdings.length) }
}
