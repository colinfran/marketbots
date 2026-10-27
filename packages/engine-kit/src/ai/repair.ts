import { z } from "zod"

/**
 * Building blocks for salvaging model output that almost matched a schema: JSON wrapped in prose
 * or code fences, numbers sent as strings ("8", "$412.50", "12%"), enum values with different
 * casing or spacing ("Very Bullish"), a single item instead of a list, or missing optional lists.
 * Each bot builds its lenient report schemas from these, then validates the result with its
 * strict schema.
 *
 * They never invent trades: an item whose required fields can't be read cleanly fails, and a
 * `lenientList` drops it instead of guessing.
 */

export const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,%\s]/g, ""))
    return v.trim() !== "" && Number.isFinite(n) ? n : null
  }
  return null
}

export const str = z.preprocess((v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)), z.string())
export const nullableStr = z.preprocess((v) => (v == null || v === "" ? null : String(v)), z.string().nullable())
export const num = (fallback: number) => z.preprocess((v) => toNumber(v) ?? fallback, z.number())
export const nullableNum = z.preprocess((v) => toNumber(v), z.number().nullable())
export const strList = z.preprocess((v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]), z.array(str))

/** Matches an enum value ignoring case, spaces, hyphens and underscores ("Pull-Back" → "pullback"). */
export const matchEnum = (values: readonly string[], v: unknown): string | undefined => {
  const key = String(v ?? "").toLowerCase().replace(/[\s_-]+/g, "")
  return values.find((value) => value.replace(/_/g, "") === key)
}

/** Enum that falls back to a neutral default when the value is unrecognizable. */
export const looseEnum = <T extends readonly [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess((v) => matchEnum(values, v) ?? fallback, z.enum(values))

/** Enum with no fallback: an unrecognizable value makes the item invalid. */
export const strictEnum = <T extends readonly [string, ...string[]]>(values: T) => z.preprocess((v) => matchEnum(values, v) ?? v, z.enum(values))

/** A list where malformed items are dropped instead of failing the whole report. */
export const lenientList = <S extends z.ZodTypeAny>(item: S) =>
  z.preprocess(
    (v) => (Array.isArray(v) ? v : v == null ? [] : [v]),
    z.array(z.unknown()).transform((items) =>
      items.flatMap((i) => {
        const parsed = item.safeParse(i)
        return parsed.success ? [parsed.data as z.output<S>] : []
      }),
    ),
  )

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
