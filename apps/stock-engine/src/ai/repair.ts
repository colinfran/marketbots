import { extractJson, lenientList, looseEnum, nullableNum, nullableStr, num, str, strictEnum, strList } from "@mb/engine-kit/ai/repair"
import { OPTION_STRATEGIES } from "@mb/stock-core/options"
import {
  ACTIONS,
  botReportSchema,
  cleanContract,
  cleanTicker,
  HORIZONS,
  IMPACTS,
  REGIMES,
  SENTIMENTS,
  SETUPS,
  SEVERITIES,
  STANCES,
  type BotReport,
} from "@mb/stock-core/report"
import { z } from "zod"

/**
 * Salvages a model response that almost matched `botReportSchema`: JSON wrapped in prose or code
 * fences, numbers sent as strings ("8", "$412.50", "12%"), enum values with different casing or
 * spacing ("Very Bullish"), a single item instead of a list, or missing optional lists. The
 * lenient building blocks are shared (@mb/engine-kit/ai/repair); the report shape is stock's.
 *
 * It never invents trades: a decision whose action or symbol can't be read cleanly is dropped,
 * and a report without a headline and summary is not repaired at all.
 */

const ticker = z.preprocess((v) => cleanTicker(String(v ?? "")), z.string().regex(/^[A-Z][A-Z.]{0,9}$/))

const contract = z.preprocess((v) => cleanContract(String(v ?? "")), z.string().min(10))

const lenientOption = z.preprocess(
  (v) => (v == null || v === "" ? null : v),
  z
    .object({
      strategy: strictEnum(OPTION_STRATEGIES),
      long_leg: contract,
      short_leg: z.preprocess((v) => (v == null || v === "" ? null : v), contract.nullable()),
      premium_pct: nullableNum,
      stop_loss_pct: nullableNum,
      take_profit_pct: nullableNum,
    })
    .nullable(),
)

const lenientDecision = z.object({
  symbol: ticker,
  action: strictEnum(ACTIONS),
  allocation_pct: nullableNum,
  sell_pct: nullableNum,
  stop_loss: nullableNum,
  take_profit: nullableNum,
  horizon: looseEnum(HORIZONS, "intraday"),
  setup: looseEnum(SETUPS, "other"),
  conviction: num(5),
  rationale: str,
  evidence: strList,
  invalidation: str,
  structure_id: nullableStr,
  option: lenientOption.optional().transform((v) => v ?? null),
})

const lenientReport = z.object({
  headline: z.string().min(1),
  summary: z.string().min(1),
  market: z.preprocess(
    (v) => v ?? {},
    z.object({
      sentiment: looseEnum(SENTIMENTS, "neutral"),
      regime: looseEnum(REGIMES, "range_bound"),
      stance: looseEnum(STANCES, "defensive"),
      confidence: num(50),
      key_drivers: strList,
    }),
  ),
  catalysts: lenientList(
    z.object({
      title: z.string().min(1),
      detail: str,
      impact: looseEnum(IMPACTS, "unknown"),
      symbols: lenientList(ticker),
      time_et: nullableStr,
      source_url: nullableStr,
    }),
  ),
  watchlist: lenientList(
    z.object({
      symbol: ticker,
      setup: looseEnum(SETUPS, "other"),
      thesis: str,
      trigger: str,
      entry_low: nullableNum,
      entry_high: nullableNum,
      stop_loss: nullableNum,
      take_profit: nullableNum,
      conviction: num(5),
    }),
  ),
  decisions: lenientList(lenientDecision),
  risks: lenientList(z.object({ risk: z.string().min(1), severity: looseEnum(SEVERITIES, "medium"), mitigation: str })),
  lessons: strList,
  next_focus: str,
  notification: str,
  sources: lenientList(z.object({ title: str, url: z.string().min(1) })),
})

/** Returns a schema-valid report if the raw model text can be safely salvaged, otherwise null. */
export const repairReport = (text: string | undefined): { report: BotReport; dropped: number } | null => {
  if (!text) return null
  const raw = extractJson(text)
  if (!raw || typeof raw !== "object") return null
  const lenient = lenientReport.safeParse(raw)
  if (!lenient.success) return null
  const strict = botReportSchema.safeParse(lenient.data)
  if (!strict.success) return null
  const rawDecisions = (raw as { decisions?: unknown }).decisions
  const requested = Array.isArray(rawDecisions) ? rawDecisions.length : 0
  return { report: strict.data, dropped: Math.max(0, requested - strict.data.decisions.length) }
}
