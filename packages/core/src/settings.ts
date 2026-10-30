import { z } from "zod"
import { AGENT_LEVELS } from "./agent"

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

/** Models on the local model server: "local/<its alias>", e.g. "local/qwen3.6-35b-a3b-q2" (docs/SERVER.md §9). */
export const MODEL_ID_PATTERN = /^local\/[a-z0-9][a-z0-9.\-]*$/
export const modelId = z.string().regex(MODEL_ID_PATTERN, "Expected a local model id like local/qwen3.6-35b-a3b-q2")

/** A bare lowercase domain, e.g. "wsj.com". */
export const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
/** A range of UTC hours, start-end with the end excluded: "22-6" is 22:00 to 06:00 UTC, "0-24" all day. */
export const HOUR_RANGE_PATTERN = /^([01]?\d|2[0-3])-([01]?\d|2[0-4])$/

const hourRange = z
  .string()
  .regex(HOUR_RANGE_PATTERN, "Expected a UTC hour range like 22-6")
  .refine((r) => r.split("-")[0] !== r.split("-")[1], "an hour range can't start and end at the same hour")

/**
 * Local article summaries (@mb/wire/enrich): the article behind an important item, summarized by
 * the local model server's model (whichever it serves, see SERVER.md), for the News page and the
 * AI's wire dossier (its 8 best-ranked items, labelled as machine summaries). Never on the
 * trigger path.
 */
export const wireSummariesSettings = z.object({
  enabled: z.boolean(),
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
 * after deploy. `mode` "off" stops the news engine (no sources, no triggers); "shadow" logs its
 * triggers but sends no alerts and takes no emergency action. The agent hears about news in both
 * live and shadow.
 */
export const wireSettingsBase = z.object({
  mode: z.enum(["off", "shadow", "live"]),
  /** Severity (0-100) for: annotating the dossier, a held-position review, a new-entry evaluation, critical. Ascending. */
  thresholds: z.object({ annotate: int(0, 100), review: int(0, 100), evaluate: int(0, 100), critical: int(0, 100) }),
  /** Event-driven entries need a tier-1 source, two tier-2 domains, or tier 2 plus a matching market move. */
  entry_confirmation: z.boolean(),
  /** An unexplained move in something we don't hold wakes the agent to look for the cause, as an entry idea. Off: it's only context. */
  unexplained_move_entries: z.boolean(),
  /** Only items first seen this recently can trigger (nothing fires from a backlog after a restart). */
  trigger_max_age_minutes: z.number().min(1).max(240),
  symbol_cooldown_minutes: z.number().min(1).max(720),
  max_event_cycles_per_hour: int(0, 30),
  max_event_cycles_per_day: int(0, 200),
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

/** What one priority's episodes may spend (docs/plans/LOCAL-AI.md §8.2). */
export const agentPriorityLimits = z.object({
  /** Steps per episode, the answer included: the last one may only answer. */
  steps: int(1, 30),
  /** The hard stop. Tool calls end at 60% of it, so the answer has the rest. */
  seconds: z.number().min(10).max(1_800),
  /** The model's thinking per step, in tokens; 0 = no thinking. */
  thinking_tokens: int(0, 8_000),
})

/**
 * The agent (docs/plans/LOCAL-AI.md §8–§10), the same in both bots. At `level` on it wakes on what
 * code observes, looks things up, and trades the paper account through the bot's own risk checks;
 * it is the only thing that decides. The envelope limits what the agent does, tighter than the
 * bot's own risk caps; risk-reducing actions are never rate-limited.
 */
export const agentSettingsBase = z.object({
  level: z.enum(AGENT_LEVELS),
  model: modelId,
  limits: z.object({ p0: agentPriorityLimits, p1: agentPriorityLimits, p2: agentPriorityLimits, p3: agentPriorityLimits }),
  /** A subject that woke the agent doesn't wake it again for this long, unless its salience rises 15 points, a P0, a watch or the owner. */
  wake_cooldown_minutes: z.number().min(0).max(240),
  /** A review of the whole book and market after this long without one: the safety net for what nothing triggered. */
  sweep_minutes: z.number().min(15).max(1_440),
  envelope: z.object({
    entries_per_day: int(0, 50),
    entries_per_hour: int(0, 20),
    /** Money committed to new entries in any hour, % of equity. */
    commit_per_hour_pct: pct(0, 100),
    /** An agent entry's size, % of what the risk checks allow. */
    size_pct: pct(1, 100),
    max_open_positions: int(0, 30),
    /** One action per symbol this often (tightening a stop is exempt). */
    symbol_action_minutes: z.number().min(0).max(1_440),
    /** No re-entry in a symbol this long after a stop-out. */
    reentry_after_stop_hours: z.number().min(0).max(168),
    /** Re-entering a symbol this soon after exiting it is refused. */
    flip_hours: z.number().min(0).max(72),
  }),
  /** Stream the model's thinking to logged-out viewers too (it quotes untrusted news text). */
  public_thinking: z.boolean(),
})
export type AgentSettings = z.infer<typeof agentSettingsBase>

/**
 * Stored settings from before the agent-only bots: the agent's levels were off, shadow and auto.
 * auto is on; shadow becomes off, so the agent never turns itself on (a breaker's drop to shadow is
 * the engine's to turn into a pause on entries, from its state). Anything else passes unchanged.
 */
export const upgradeStoredSettings = (stored: unknown): unknown => {
  if (!isPlainObject(stored) || !isPlainObject(stored.agent)) return stored
  const level = stored.agent.level
  if (level !== "auto" && level !== "shadow") return stored
  return { ...stored, agent: { ...stored.agent, level: level === "auto" ? "on" : "off" } }
}

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
