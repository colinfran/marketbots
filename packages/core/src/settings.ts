import { z } from "zod"

/**
 * Runtime settings: the pieces both bots share. Settings live in MongoDB, are edited only from the
 * dashboard's Admin page (through audited commands), and are validated with the bot's schema by
 * both the web app and the engine. The AI never sees a way to change them: no prompt, tool or
 * output field can touch settings.
 *
 * Bounds are deliberately wide but finite, so a typo can't set a 5000% position limit.
 *
 * The base sections are plain objects, never refined. A bot builds each of its sections from the
 * base fields plus its own, in its own key order (the order shows in the JSON Schema and in parsed
 * settings, so it is part of the bot's settings contract), and refines its whole settings object
 * last, starting with `refineWireThresholds`.
 */

export const pct = (min: number, max: number) => z.number().min(min).max(max)
export const int = (min: number, max: number) => z.number().int().min(min).max(max)

/** Gateway model ids are plain "provider/model" strings, e.g. "spacexai/grok-4.7". */
export const MODEL_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9][a-z0-9.\-]*$/
export const modelId = z.string().regex(MODEL_ID_PATTERN, "Expected a gateway model id like spacexai/grok-4.7")

/** The AI settings both bots have. */
export const aiSettingsBase = z.object({
  /** Hard cap on AI spend per budget day (each bot's own day). When reached, no AI calls run and no new trades open. */
  daily_budget_usd: z.number().min(0).max(1_000),
  models: z.object({
    research: modelId,
    decision: modelId,
    /** Tried once when the primary model errors out. null = no fallback. */
    fallback: modelId.nullable(),
  }),
  x_search: z.boolean(),
  research_timeout_seconds: z.number().min(30).max(600),
  decision_timeout_seconds: z.number().min(20).max(300),
})
export type AiSettingsBase = z.infer<typeof aiSettingsBase>

/** An Ollama model tag, e.g. "llama3.2:3b" or "qwen3:4b-instruct". */
export const OLLAMA_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/
/** A bare lowercase domain, e.g. "wsj.com". */
export const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
/** A range of UTC hours, start-end with the end excluded: "22-6" is 22:00 to 06:00 UTC, "0-24" all day. */
export const HOUR_RANGE_PATTERN = /^([01]?\d|2[0-3])-([01]?\d|2[0-4])$/

const hourRange = z
  .string()
  .regex(HOUR_RANGE_PATTERN, "Expected a UTC hour range like 22-6")
  .refine((r) => r.split("-")[0] !== r.split("-")[1], "an hour range can't start and end at the same hour")

/**
 * Local article summaries (MARKETBOTS_PLAN §3.9, @mb/wire/enrich): the article behind an important
 * item, summarized by a small model on the server's GPU, for the Research page. Never on the trigger
 * path, and (until the owner approves 10.5) never in a prompt.
 */
export const wireSummariesSettings = z.object({
  enabled: z.boolean(),
  /** The Ollama model tag. */
  model: z.string().regex(OLLAMA_MODEL_PATTERN, "Expected an Ollama model tag like llama3.2:3b"),
  /** Cluster roots at or above this severity get a summary; notable items always qualify. */
  min_severity: int(0, 100),
  /** Articles each engine may summarize per hour. */
  max_per_hour: int(1, 600),
  /** Domains (and their subdomains) never fetched for a summary. The scraper refuses its own paywall list as well. */
  skip_domains: z.array(z.string().regex(DOMAIN_PATTERN, "Expected a lowercase domain like wsj.com")).max(200),
  /** UTC hour ranges with no summaries, e.g. "22-6". */
  pause_hours: z.array(hourRange).max(24),
})
export type WireSummariesSettings = z.infer<typeof wireSummariesSettings>

/**
 * The news engine ("wire") settings both bots have. It ships live: `SettingsStore.load` fills this
 * section (and any field added to it later, like `summaries`) from the defaults on the first boot
 * after deploy. Setting `mode` to "off" (or "shadow": log triggers, act on none) returns trading to
 * scheduled cycles with full Grok research at once.
 */
export const wireSettingsBase = z.object({
  mode: z.enum(["off", "shadow", "live"]),
  /** full = Grok researches as before; gap_fill = Grok only fills what the wire lacks; auto = gap_fill, skipped when there's no gap. */
  research_mode: z.enum(["full", "gap_fill", "auto"]),
  /** Severity (0-100) for: annotating the dossier, a held-position review, a new-entry evaluation, critical. Ascending. */
  thresholds: z.object({ annotate: int(0, 100), review: int(0, 100), evaluate: int(0, 100), critical: int(0, 100) }),
  /** Event-driven entries need a tier-1 source, two tier-2 domains, or tier 2 plus a matching market move. */
  entry_confirmation: z.boolean(),
  /** Only items first seen this recently can trigger (nothing fires from a backlog after a restart). */
  trigger_max_age_minutes: z.number().min(1).max(240),
  symbol_cooldown_minutes: z.number().min(1).max(720),
  event_min_gap_seconds: z.number().min(15).max(3_600),
  max_event_cycles_per_hour: int(0, 30),
  max_event_cycles_per_day: int(0, 200),
  /** Share of the daily AI budget scheduled cycles can't touch: it's kept for event cycles. */
  event_budget_reserve_pct: pct(0, 90),
  event_research: z.enum(["none", "x_verify"]),
  event_research_timeout_seconds: z.number().min(15).max(300),
  event_decision_timeout_seconds: z.number().min(20).max(300),
  anomaly: z.object({
    /** 1-minute return z-score that counts as an idiosyncratic price shock. */
    price_z: z.number().min(2).max(20),
    /** Bar volume over the trailing median that counts as a volume shock. */
    volume_multiple: z.number().min(1.5).max(50),
    /** The market benchmark's 5-minute z-score that counts as a market-wide shock. */
    market_z: z.number().min(2).max(20),
  }),
  /** Catalog source ids to keep off. */
  disabled_sources: z.array(z.string().min(1).max(80)).max(200),
  /** Days wire items and triggers are kept (TTL). */
  retention_days: int(7, 730),
  /** Prediction-market move (percentage points within an hour) that counts as an odds swing. */
  odds_swing_pts: z.number().min(1).max(100),
  summaries: wireSummariesSettings,
})
export type WireSettingsBase = z.infer<typeof wireSettingsBase>

/** The first refinement of every bot's settings: the wire thresholds must ascend. */
export const refineWireThresholds = (settings: { wire: Pick<WireSettingsBase, "thresholds"> }, ctx: z.RefinementCtx) => {
  const t = settings.wire.thresholds
  if (!(t.annotate < t.review && t.review < t.evaluate && t.evaluate < t.critical)) {
    ctx.addIssue({ code: "custom", path: ["wire", "thresholds"], message: "thresholds must ascend: annotate < review < evaluate < critical" })
  }
}

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Deep-merges a patch (arrays replace, objects merge). Unknown keys are dropped by validation. */
export const mergeSettings = <S>(base: S, patch: DeepPartial<NoInfer<S>>): unknown => {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a
    if (!isPlainObject(a) || !isPlainObject(b)) return b
    const out: Record<string, unknown> = { ...a }
    for (const [key, value] of Object.entries(b)) out[key] = merge(a[key], value)
    return out
  }
  return merge(base, patch)
}

export type SettingsValidation<S> = { ok: true; settings: S } | { ok: false; errors: string[] }

/** Applies a patch and validates the result against the bot's settings schema. The only way settings change. */
export const applySettingsPatch = <S>(schema: z.ZodType<S>, base: S, patch: DeepPartial<NoInfer<S>>): SettingsValidation<S> => {
  const parsed = schema.safeParse(mergeSettings(base, patch))
  if (parsed.success) return { ok: true, settings: parsed.data }
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "settings"}: ${i.message}`) }
}

/** Lists the leaf paths whose values differ, for the audit log. */
export const diffSettings = (before: unknown, after: unknown, prefix = ""): { path: string; before: unknown; after: unknown }[] => {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    return [...keys].flatMap((k) => diffSettings(before[k], after[k], prefix ? `${prefix}.${k}` : k))
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path: prefix, before, after }]
}
