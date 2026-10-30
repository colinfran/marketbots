import {
  agentSettingsBase,
  aiSettingsBase,
  applySettingsPatch as sharedApplySettingsPatch,
  type DeepPartial,
  int,
  pct,
  refineWireThresholds,
  type SettingsValidation as SettingsValidationOf,
  wireSettingsBase,
} from "@mb/core/settings"
import { z } from "zod"
import { STRATEGY_IDS, type StrategyId } from "./strategies"
import { SYMBOL_PATTERN } from "./venues"

export { diffSettings, mergeSettings, MODEL_ID_PATTERN } from "@mb/core/settings"

/**
 * Runtime settings: every risk limit, AI setting and schedule knob. They live in MongoDB, are
 * edited only from the dashboard (through audited commands), and are validated with this schema by
 * both the web app and the engine. The AI never sees a way to change them: no prompt, tool or
 * output field can touch settings.
 *
 * Bounds are deliberately wide but finite, so a typo can't set a 5000% position limit.
 *
 * The `ai` and `wire` sections take the fields both bots share from @mb/core/settings, in this
 * bot's key order (the order is part of the settings contract), and add crypto's own.
 */

const aiBase = aiSettingsBase.shape
const wireBase = wireSettingsBase.shape

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
  models: aiBase.models,
  max_candidates_per_cycle: int(1, 12),
  /**
   * Weight on the AI's probability that the target hits before the stop, vs the zero-drift prior
   * stop / (stop + target). 0.5 halves every claimed edge until calibration data says otherwise.
   */
  probability_shrink: z.number().min(0).max(1),
  research_timeout_seconds: aiBase.research_timeout_seconds,
  decision_timeout_seconds: aiBase.decision_timeout_seconds,
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

/** The news engine ("wire"). An entry's matching move can be in price or volume. */
export const wireSettingsSchema = z.object({
  mode: wireBase.mode,
  research_mode: wireBase.research_mode,
  thresholds: wireBase.thresholds,
  entry_confirmation: wireBase.entry_confirmation,
  unexplained_move_entries: wireBase.unexplained_move_entries,
  trigger_max_age_minutes: wireBase.trigger_max_age_minutes,
  symbol_cooldown_minutes: wireBase.symbol_cooldown_minutes,
  event_min_gap_seconds: wireBase.event_min_gap_seconds,
  max_event_cycles_per_hour: wireBase.max_event_cycles_per_hour,
  max_event_cycles_per_day: wireBase.max_event_cycles_per_day,
  event_research: wireBase.event_research,
  event_research_timeout_seconds: wireBase.event_research_timeout_seconds,
  event_decision_timeout_seconds: wireBase.event_decision_timeout_seconds,
  /** What happens at once when a held position meets a critical, confirmed, negative event. review = the AI decides. */
  emergency_action: z.enum(["review", "tighten_stop", "exit"]),
  /** The market-wide shock is BTC's 5-minute z-score. */
  anomaly: wireBase.anomaly,
  disabled_sources: wireBase.disabled_sources,
  retention_days: wireBase.retention_days,
  /** USDT/USD or USDC/USD off $1 by this % counts as a depeg. */
  depeg_pct: z.number().min(0.1).max(20),
  /** A chain or protocol losing this % of TVL within an hour counts as an exploit signal. */
  tvl_drop_pct: pct(1, 90),
  odds_swing_pts: wireBase.odds_swing_pts,
  /** Annualized perpetual funding at or beyond ±X% counts as extreme. */
  funding_extreme_annual_pct: z.number().min(5).max(2_000),
  /** Coinbase BTC/ETH price off Kraken's by at least this % for 5 minutes counts as a Coinbase premium (or discount). */
  coinbase_premium_pct: z.number().min(0.05).max(5),
  summaries: wireBase.summaries,
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
    /** The agent (docs/plans/LOCAL-AI.md §8), the same in both bots. */
    agent: agentSettingsBase,
  })
  .superRefine((s, ctx) => {
    refineWireThresholds(s, ctx)
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
    models: {
      research: "local/qwen3.6-35b-a3b-q2",
      decision: "local/qwen3.6-35b-a3b-q2",
    },
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
    unexplained_move_entries: false,
    trigger_max_age_minutes: 15,
    symbol_cooldown_minutes: 30,
    event_min_gap_seconds: 60,
    max_event_cycles_per_hour: 4,
    max_event_cycles_per_day: 24,
    event_research: "x_verify",
    event_research_timeout_seconds: 45,
    event_decision_timeout_seconds: 90,
    emergency_action: "review",
    anomaly: { price_z: 4, volume_multiple: 5, market_z: 4 },
    disabled_sources: [],
    // Short because the Atlas tier may be the free 512 MB one. Raise it from Admin.
    retention_days: 30,
    depeg_pct: 1,
    tvl_drop_pct: 15,
    odds_swing_pts: 15,
    funding_extreme_annual_pct: 100,
    coinbase_premium_pct: 0.3,
    summaries: {
      enabled: true,
      min_severity: 55,
      max_per_hour: 60,
      skip_domains: ["wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "economist.com", "barrons.com", "seekingalpha.com"],
      pause_hours: [],
    },
  },
  agent: {
    level: "on",
    model: "local/qwen3.6-35b-a3b-q2",
    limits: {
      p0: { steps: 4, seconds: 60, thinking_tokens: 0 },
      p1: { steps: 6, seconds: 120, thinking_tokens: 0 },
      p2: { steps: 8, seconds: 240, thinking_tokens: 1_024 },
      p3: { steps: 12, seconds: 600, thinking_tokens: 2_048 },
    },
    wake_cooldown_minutes: 5,
    sweep_minutes: 120,
    envelope: {
      entries_per_day: 4,
      entries_per_hour: 2,
      commit_per_hour_pct: 10,
      size_pct: 50,
      max_open_positions: 4,
      symbol_action_minutes: 30,
      reentry_after_stop_hours: 24,
      flip_hours: 6,
    },
    public_thinking: false,
  },
}

export type SettingsPatch = DeepPartial<Settings>

export type SettingsValidation = SettingsValidationOf<Settings>

/** Applies a patch and validates the result. The only way settings change. */
export const applySettingsPatch = (base: Settings, patch: SettingsPatch): SettingsValidation => sharedApplySettingsPatch(settingsSchema, base, patch)
