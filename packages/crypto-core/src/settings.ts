import { z } from "zod"
import { STRATEGY_IDS, type StrategyId } from "./strategies"
import { SYMBOL_PATTERN } from "./venues"

/**
 * Runtime settings: every risk limit, AI budget and schedule knob. They live in MongoDB, are
 * edited only from the dashboard (through audited commands), and are validated with this schema by
 * both the web app and the engine. The AI never sees a way to change them: no prompt, tool or
 * output field can touch settings.
 *
 * Bounds are deliberately wide but finite, so a typo can't set a 5000% position limit.
 */

const pct = (min: number, max: number) => z.number().min(min).max(max)
const int = (min: number, max: number) => z.number().int().min(min).max(max)

/** Gateway model ids are plain "provider/model" strings, e.g. "spacexai/grok-4.7". */
export const MODEL_ID_PATTERN = /^[a-z0-9-]+\/[a-z0-9][a-z0-9.\-]*$/
const modelId = z.string().regex(MODEL_ID_PATTERN, "Expected a gateway model id like spacexai/grok-4.7")

export const krakenRiskSchema = z.object({
  /** Max % of Kraken account equity in a single new position. */
  max_position_pct: pct(0.5, 50),
  /** Max % of equity in one asset, counting adds. */
  max_asset_exposure_pct: pct(1, 100),
  /** Max % of equity deployed across all crypto positions (the rest stays in USD). */
  max_total_exposure_pct: pct(1, 100),
  /** Max % of equity across assets whose returns correlate above `correlation_threshold`. */
  max_correlated_exposure_pct: pct(1, 100),
  correlation_threshold: z.number().min(0.3).max(0.99),
  max_concurrent_positions: int(1, 30),
  /** Equity lost if the stop is hit, as % of equity. Sets position size together with the stop distance. */
  risk_per_trade_pct: pct(0.05, 5),
  min_reward_risk: z.number().min(0.5).max(10),
  min_stop_pct: pct(0.2, 20),
  max_stop_pct: pct(0.5, 40),
  /** Required expected return after fees, spread and slippage, in basis points of notional. */
  min_edge_bps: z.number().min(0).max(2000),
  max_spread_bps: z.number().min(1).max(500),
  /** Worst acceptable fill vs the mid, in bps. Also the limit-price offset for marketable orders. */
  max_slippage_bps: z.number().min(1).max(500),
  /** Quotes older than this block new entries on that symbol. */
  max_quote_age_seconds: z.number().min(2).max(600),
  reentry_cooldown_minutes: z.number().min(0).max(10_080),
  /** The AI can't close a position younger than this unless its stop or invalidation hits. */
  min_hold_minutes: z.number().min(0).max(10_080),
  /** 0-100 AI conviction required for a new entry. Not a calibrated probability. */
  min_conviction: z.number().min(0).max(100),
  max_trades_per_day: int(0, 500),
  /**
   * Fee and slippage of the Kraken CLI paper wallet, in bps. Fixed on the workspace when it's
   * created or reset, so a change here takes effect at the next paper reset.
   */
  taker_fee_bps: z.number().min(0).max(200),
  paper_slippage_bps: z.number().min(0).max(200),
})

export const portfolioRiskSchema = z.object({
  /** Day P&L at or below -X% (per account) blocks new entries until the next UTC day. */
  max_daily_loss_pct: pct(0.1, 50),
  /** Drawdown from peak equity at or above X% engages the kill switch. */
  max_drawdown_pct: pct(1, 90),
  drawdown_action: z.enum(["halt", "halt_and_liquidate"]),
})

export const aiSettingsSchema = z.object({
  /** Hard cap on AI spend per UTC day. When reached, no AI calls run and no new trades open. */
  daily_budget_usd: z.number().min(0).max(1000),
  models: z.object({
    research: modelId,
    decision: modelId,
    /** Tried once when the primary model errors out. null = no fallback. */
    fallback: modelId.nullable(),
  }),
  x_search: z.boolean(),
  max_candidates_per_cycle: int(1, 12),
  /**
   * Weight on the AI's probability that the target hits before the stop, vs the zero-drift prior
   * stop / (stop + target). 0.5 halves every claimed edge until calibration data says otherwise.
   */
  probability_shrink: z.number().min(0).max(1),
  research_timeout_seconds: z.number().min(30).max(600),
  decision_timeout_seconds: z.number().min(20).max(300),
})

export const scheduleSettingsSchema = z.object({
  crypto_scan_minutes: z.number().min(5).max(240),
  position_review_minutes: z.number().min(15).max(1440),
  /** A held asset moving this many 1h ATRs since its last review triggers a reassessment. */
  trigger_move_atr: z.number().min(0.5).max(10),
  trigger_cooldown_minutes: z.number().min(5).max(720),
  /** Minimum gap between crypto AI cycles, even when triggers fire. Prevents churn and runaway cost. */
  min_ai_interval_minutes: z.number().min(1).max(240),
})

export const strategySettingsSchema = z.object({
  enabled: z.boolean(),
  /** Max % of account equity allocated to this strategy's open positions. */
  max_exposure_pct: pct(0, 100),
})

/**
 * The news engine ("wire"). It ships live: `SettingsStore.load` fills this section from the
 * defaults on the first boot after deploy. Setting `mode` to "off" (or "shadow": log triggers,
 * act on none) returns trading to scheduled cycles with full Grok research at once.
 */
export const wireSettingsSchema = z.object({
  mode: z.enum(["off", "shadow", "live"]),
  /** full = Grok researches as before; gap_fill = Grok only fills what the wire lacks; auto = gap_fill, skipped when there's no gap. */
  research_mode: z.enum(["full", "gap_fill", "auto"]),
  /** Severity (0-100) for: annotating the dossier, a held-position review, a new-entry evaluation, critical. Ascending. */
  thresholds: z.object({ annotate: int(0, 100), review: int(0, 100), evaluate: int(0, 100), critical: int(0, 100) }),
  /** Event-driven entries need a tier-1 source, two tier-2 domains, or tier 2 plus a matching price/volume move. */
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
  /** What happens at once when a held position meets a critical, confirmed, negative event. review = Grok decides. */
  emergency_action: z.enum(["review", "tighten_stop", "exit"]),
  anomaly: z.object({
    /** 1-minute return z-score that counts as an idiosyncratic price shock. */
    price_z: z.number().min(2).max(20),
    /** Bar volume over the trailing median that counts as a volume shock. */
    volume_multiple: z.number().min(1.5).max(50),
    /** BTC 5-minute z-score that counts as a market-wide shock. */
    market_z: z.number().min(2).max(20),
  }),
  /** Catalog source ids to keep off. */
  disabled_sources: z.array(z.string().min(1).max(80)).max(200),
  /** Days wire items and triggers are kept (TTL). */
  retention_days: int(7, 730),
  /** USDT/USD or USDC/USD off $1 by this % counts as a depeg. */
  depeg_pct: z.number().min(0.1).max(20),
  /** A chain or protocol losing this % of TVL within an hour counts as an exploit signal. */
  tvl_drop_pct: pct(1, 90),
  /** Prediction-market move (percentage points within an hour) that counts as an odds swing. */
  odds_swing_pts: z.number().min(1).max(100),
  /** Annualized perpetual funding at or beyond ±X% counts as extreme. */
  funding_extreme_annual_pct: z.number().min(5).max(2_000),
  /** Coinbase BTC/ETH price off Kraken's by at least this % for 5 minutes counts as a Coinbase premium (or discount). */
  coinbase_premium_pct: z.number().min(0.05).max(5),
})

const strategiesShape = Object.fromEntries(STRATEGY_IDS.map((id) => [id, strategySettingsSchema])) as Record<
  StrategyId,
  typeof strategySettingsSchema
>

export const settingsSchema = z
  .object({
    kraken: krakenRiskSchema,
    portfolio: portfolioRiskSchema,
    ai: aiSettingsSchema,
    schedule: scheduleSettingsSchema,
    strategies: z.object(strategiesShape),
    universe: z.object({
      kraken_symbols: z.array(z.string().regex(SYMBOL_PATTERN)).min(1).max(30),
    }),
    paper: z.object({
      /** Starting capital of the paper wallet. Applied when the wallet is created or reset. */
      starting_usd: z.number().min(100).max(10_000_000),
    }),
    wire: wireSettingsSchema,
  })
  .superRefine((s, ctx) => {
    const t = s.wire.thresholds
    if (!(t.annotate < t.review && t.review < t.evaluate && t.evaluate < t.critical)) {
      ctx.addIssue({ code: "custom", path: ["wire", "thresholds"], message: "thresholds must ascend: annotate < review < evaluate < critical" })
    }
    if (s.kraken.min_stop_pct >= s.kraken.max_stop_pct) {
      ctx.addIssue({ code: "custom", path: ["kraken", "min_stop_pct"], message: "min_stop_pct must be below max_stop_pct" })
    }
    if (s.kraken.max_position_pct > s.kraken.max_asset_exposure_pct) {
      ctx.addIssue({ code: "custom", path: ["kraken", "max_position_pct"], message: "max_position_pct can't exceed max_asset_exposure_pct" })
    }
    if (new Set(s.universe.kraken_symbols).size !== s.universe.kraken_symbols.length) {
      ctx.addIssue({ code: "custom", path: ["universe", "kraken_symbols"], message: "duplicate symbols" })
    }
  })

export type Settings = z.infer<typeof settingsSchema>
export type KrakenRisk = Settings["kraken"]
export type AiSettings = Settings["ai"]

export const DEFAULT_SETTINGS: Settings = {
  kraken: {
    max_position_pct: 20,
    max_asset_exposure_pct: 30,
    max_total_exposure_pct: 90,
    max_correlated_exposure_pct: 70,
    correlation_threshold: 0.75,
    max_concurrent_positions: 7,
    risk_per_trade_pct: 1.5,
    min_reward_risk: 1.3,
    min_stop_pct: 1,
    max_stop_pct: 12,
    min_edge_bps: 25,
    max_spread_bps: 20,
    max_slippage_bps: 25,
    max_quote_age_seconds: 20,
    reentry_cooldown_minutes: 90,
    min_hold_minutes: 60,
    min_conviction: 55,
    max_trades_per_day: 20,
    taker_fee_bps: 40,
    paper_slippage_bps: 5,
  },
  portfolio: {
    max_daily_loss_pct: 5,
    max_drawdown_pct: 25,
    drawdown_action: "halt",
  },
  ai: {
    daily_budget_usd: 5,
    models: {
      research: "spacexai/grok-4.5",
      decision: "spacexai/grok-4.7",
      fallback: null,
    },
    x_search: true,
    max_candidates_per_cycle: 4,
    probability_shrink: 0.6,
    research_timeout_seconds: 180,
    decision_timeout_seconds: 240,
  },
  schedule: {
    crypto_scan_minutes: 15,
    position_review_minutes: 240,
    trigger_move_atr: 1.5,
    trigger_cooldown_minutes: 30,
    min_ai_interval_minutes: 10,
  },
  strategies: {
    trend: { enabled: true, max_exposure_pct: 65 },
    daily_trend: { enabled: true, max_exposure_pct: 50 },
    mean_reversion: { enabled: true, max_exposure_pct: 40 },
    momentum: { enabled: true, max_exposure_pct: 55 },
    event_driven: { enabled: true, max_exposure_pct: 40 },
    discretionary: { enabled: true, max_exposure_pct: 30 },
  },
  universe: {
    kraken_symbols: ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD", "ADA/USD", "LINK/USD", "AVAX/USD", "LTC/USD", "DOT/USD"],
  },
  paper: {
    starting_usd: 10_000,
  },
  wire: {
    mode: "live",
    research_mode: "auto",
    thresholds: { annotate: 30, review: 55, evaluate: 70, critical: 85 },
    entry_confirmation: true,
    trigger_max_age_minutes: 15,
    symbol_cooldown_minutes: 30,
    event_min_gap_seconds: 60,
    max_event_cycles_per_hour: 4,
    max_event_cycles_per_day: 24,
    event_budget_reserve_pct: 30,
    event_research: "x_verify",
    event_research_timeout_seconds: 45,
    event_decision_timeout_seconds: 90,
    emergency_action: "review",
    anomaly: { price_z: 4, volume_multiple: 5, market_z: 4 },
    disabled_sources: [],
    // 30, not the plan's 90: the Atlas tier may be the free 512 MB one (Phase 0.7). Raise it from Admin.
    retention_days: 30,
    depeg_pct: 1,
    tvl_drop_pct: 15,
    odds_swing_pts: 15,
    funding_extreme_annual_pct: 100,
    coinbase_premium_pct: 0.3,
  },
}

type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T
export type SettingsPatch = DeepPartial<Settings>

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Deep-merges a patch (arrays replace, objects merge). Unknown keys are dropped by validation. */
export const mergeSettings = (base: Settings, patch: SettingsPatch): unknown => {
  const merge = (a: unknown, b: unknown): unknown => {
    if (b === undefined) return a
    if (!isPlainObject(a) || !isPlainObject(b)) return b
    const out: Record<string, unknown> = { ...a }
    for (const [key, value] of Object.entries(b)) out[key] = merge(a[key], value)
    return out
  }
  return merge(base, patch)
}

export type SettingsValidation = { ok: true; settings: Settings } | { ok: false; errors: string[] }

/** Applies a patch and validates the result. The only way settings change. */
export const applySettingsPatch = (base: Settings, patch: SettingsPatch): SettingsValidation => {
  const parsed = settingsSchema.safeParse(mergeSettings(base, patch))
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
