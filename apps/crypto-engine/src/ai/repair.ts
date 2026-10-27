import {
  CRYPTO_ACTIONS,
  cryptoReportSchema,
  EVIDENCE_KINDS,
  MAX_HORIZON_HOURS,
  PRICED_IN,
  REGIMES,
  seedAllocationSchema,
  UNCERTAINTY,
  type CryptoReport,
  type SeedAllocationReport,
} from "@mb/crypto-core/report"
import { z } from "zod"

/**
 * Salvages model output that almost matched a schema (same approach as stockmarketbot): JSON
 * wrapped in prose or code fences, numbers sent as strings ("62", "0.55", "$64,100"), enum values
 * with different casing or spacing, single items instead of lists, missing optional lists.
 *
 * It never invents trades: a decision whose symbol or action can't be read cleanly is dropped,
 * and the caller learns how many were dropped.
 */

const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string") {
    const trimmed = v.trim()
    const n = Number(trimmed.replace(/[$,%\s]/g, ""))
    return trimmed !== "" && Number.isFinite(n) ? n : null
  }
  return null
}

const str = z.preprocess((v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)), z.string())
const nullableStr = z.preprocess((v) => (v == null || v === "" ? null : String(v)), z.string().nullable())
const num = (fallback: number) => z.preprocess((v) => toNumber(v) ?? fallback, z.number())
const nullableNum = z.preprocess((v) => toNumber(v), z.number().nullable())
const strList = z.preprocess((v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]), z.array(str))

const matchEnum = (values: readonly string[], v: unknown): string | undefined => {
  const key = String(v ?? "").toLowerCase().replace(/[\s_-]+/g, "")
  return values.find((value) => value.replace(/_/g, "") === key)
}
const looseEnum = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess((v) => matchEnum(values, v) ?? fallback, z.enum(values))
const strictEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess((v) => matchEnum(values, v) ?? v, z.enum(values))

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

const evidence = z.object({
  claim: z.string().min(1),
  kind: looseEnum(EVIDENCE_KINDS, "speculation"),
  source_url: nullableStr,
  as_of: nullableStr,
})

const lenientCrypto = z.object({
  market_read: z.preprocess(
    (v) => v ?? {},
    z.object({ regime: looseEnum(REGIMES, "unknown"), summary: str, confidence: num(50) }),
  ),
  decisions: lenientList(
    z.object({
      symbol: z.preprocess((v) => String(v ?? "").trim().toUpperCase(), z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z]{3,4}$/)),
      action: strictEnum(CRYPTO_ACTIONS),
      conviction: num(0),
      uncertainty: looseEnum(UNCERTAINTY, "high"),
      p_target_first: nullableNum,
      stop_loss: nullableNum,
      take_profit: nullableNum,
      horizon_hours: num(24),
      size_pct_of_max: nullableNum,
      reduce_pct: nullableNum,
      priced_in: looseEnum(PRICED_IN, "unknown"),
      thesis: str,
      bull_evidence: lenientList(evidence),
      bear_evidence: lenientList(evidence),
      risks: strList,
      invalidation: str,
    }),
  ),
  data_gaps: strList,
  notification: str,
})

/** Pulls the outermost JSON object out of text that may include prose or ``` fences. */
export const extractJson = (text: string): unknown => {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

const countRaw = (raw: unknown, key: string) => {
  const list = (raw as Record<string, unknown> | null)?.[key]
  return Array.isArray(list) ? list.length : 0
}

export const repairCryptoReport = (text: string | undefined): { report: CryptoReport; dropped: number } | null => {
  if (!text) return null
  const raw = extractJson(text)
  if (!raw || typeof raw !== "object") return null
  const lenient = lenientCrypto.safeParse(raw)
  if (!lenient.success) return null
  const strict = cryptoReportSchema.safeParse(lenient.data)
  if (!strict.success) return null
  return { report: strict.data, dropped: Math.max(0, countRaw(raw, "decisions") - strict.data.decisions.length) }
}

const lenientSeed = z.object({
  allocations: lenientList(
    z.object({
      symbol: z.preprocess((v) => String(v ?? "").trim().toUpperCase(), z.string().regex(/^[A-Z0-9]{2,12}\/[A-Z]{3,4}$/)),
      weight_pct: z.preprocess((v) => toNumber(v), z.number()),
      conviction: num(0),
      thesis: str,
      invalidation: str,
      stop_loss: nullableNum,
      take_profit: nullableNum,
      horizon_hours: num(MAX_HORIZON_HOURS),
    }),
  ),
  rationale: str,
})

export const repairSeedAllocation = (text: string | undefined): { report: SeedAllocationReport; dropped: number } | null => {
  if (!text) return null
  const raw = extractJson(text)
  if (!raw || typeof raw !== "object") return null
  const lenient = lenientSeed.safeParse(raw)
  if (!lenient.success) return null
  const strict = seedAllocationSchema.safeParse(lenient.data)
  if (!strict.success) return null
  return { report: strict.data, dropped: Math.max(0, countRaw(raw, "allocations") - strict.data.allocations.length) }
}
