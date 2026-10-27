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
 * spacing ("Very Bullish"), a single item instead of a list, or missing optional lists.
 *
 * It never invents trades: a decision whose action or symbol can't be read cleanly is dropped,
 * and a report without a headline and summary is not repaired at all.
 */

const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,%\s]/g, ""))
    return v.trim() !== "" && Number.isFinite(n) ? n : null
  }
  return null
}

const str = z.preprocess((v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)), z.string())
const nullableStr = z.preprocess((v) => (v == null || v === "" ? null : String(v)), z.string().nullable())
const num = (fallback: number) => z.preprocess((v) => toNumber(v) ?? fallback, z.number())
const nullableNum = z.preprocess((v) => toNumber(v), z.number().nullable())
const strList = z.preprocess((v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]), z.array(str))

/** Matches an enum value ignoring case, spaces, hyphens and underscores ("Pull-Back" → "pullback"). */
const matchEnum = (values: readonly string[], v: unknown): string | undefined => {
  const key = String(v ?? "").toLowerCase().replace(/[\s_-]+/g, "")
  return values.find((value) => value.replace(/_/g, "") === key)
}

/** Enum that falls back to a neutral default when the value is unrecognizable. */
const looseEnum = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess((v) => matchEnum(values, v) ?? fallback, z.enum(values))

/** Enum with no fallback: an unrecognizable value makes the item invalid. */
const strictEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess((v) => matchEnum(values, v) ?? v, z.enum(values))

/** A list where malformed items are dropped instead of failing the whole report. */
const lenientList = <S extends z.ZodTypeAny>(item: S) =>
  z.preprocess(
    (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
    z.array(z.unknown()).transform((items) =>
      items.flatMap((i) => {
        const parsed = item.safeParse(i)
        return parsed.success ? [parsed.data as z.output<S>] : []
      }),
    ),
  )

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

/** Pulls the outermost JSON object out of text that may include prose or ``` fences. */
const extractJson = (text: string): unknown => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

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
