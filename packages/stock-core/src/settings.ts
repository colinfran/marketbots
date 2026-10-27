import {
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

export { diffSettings, mergeSettings, MODEL_ID_PATTERN } from "@mb/core/settings"

/**
 * Runtime settings: every risk limit, options rule, AI budget and schedule knob. They live in
 * MongoDB, are edited only from the dashboard's Admin page (through audited commands), and are
 * validated with this schema by both the web app and the engine. The AI never sees a way to
 * change them: no prompt, tool or output field can touch settings.
 *
 * Bounds are deliberately wide but finite, so a typo can't set a 5000% position limit.
 *
 * The `ai` and `wire` sections take the fields both bots share from @mb/core/settings, in this
 * bot's key order (the order is part of the settings contract), and add stock's own.
 */

const aiBase = aiSettingsBase.shape
const wireBase = wireSettingsBase.shape

/** US-listed ticker, e.g. NVDA or BRK.B. */
export const TICKER_PATTERN = /^[A-Z][A-Z.]{0,9}$/
const ticker = z.string().regex(TICKER_PATTERN, "Expected an uppercase ticker like NVDA")

export const PHASES = ["premarket", "intraday", "close", "postmarket"] as const
export type Phase = (typeof PHASES)[number]

export const riskSettingsSchema = z.object({
  /** Max % of equity in any single stock position. */
  max_position_pct: pct(1, 100),
  max_open_positions: int(1, 30),
  /** Max new stock buys in one cycle. */
  max_new_buys_per_cycle: int(0, 10),
  /** % of equity always kept in cash. The bot never uses margin. */
  cash_reserve_pct: pct(0, 90),
  /** Day P&L at or below -X% blocks new buys (stocks and options) for the rest of the day. */
  max_daily_loss_pct: pct(0.1, 50),
  /** Day P&L at or below -X% liquidates everything. */
  flatten_loss_pct: pct(0.1, 50),
  /** Day P&L at or above +X% halves new position sizes to protect the green day. */
  profit_lock_pct: pct(0.1, 50),
  /** Max orders (entries + exits) per day. Stops runaway churn. */
  max_trades_per_day: int(0, 500),
  /** Minimum share price for a stock buy (and for an option's underlying). */
  min_price: z.number().min(0.5).max(1_000),
  /** 1-10 AI conviction required for a new stock buy. */
  min_conviction: int(1, 10),
  /** Stop-loss distance bounds for a new buy, in % from the entry price. */
  min_stop_pct: pct(0.05, 20),
  max_stop_pct: pct(0.5, 50),
  /** Stop used when the AI's stop is missing or unusable. */
  default_stop_pct: pct(0.1, 20),
  min_reward_risk: z.number().min(0.5).max(10),
  /** No re-buying a stock within X minutes of selling it (including broker-triggered exits). */
  rebuy_cooldown_minutes: z.number().min(0).max(1_440),
  /** Max % of equity in stocks carried overnight. */
  max_overnight_pct: pct(0, 100),
})

/**
 * Options rules. Only defined-risk structures are possible (long calls, long puts and debit
 * spreads), so the most any trade can lose is what was paid for it.
 */
export const optionsSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Allow call and put debit spreads (two-leg orders) in addition to single long calls/puts. */
  allow_spreads: z.boolean(),
  /** Max premium paid for one new options position, as % of equity. */
  max_premium_per_trade_pct: pct(0.1, 20),
  /** Max premium tied up in all open options positions, as % of equity. */
  max_total_premium_pct: pct(0.5, 50),
  max_open_positions: int(0, 20),
  max_contracts_per_trade: int(1, 100),
  /** 1-10 AI conviction required for a new options position. */
  min_conviction: int(1, 10),
  /** Days to expiration allowed for a new position. */
  min_dte: int(1, 365),
  max_dte: int(2, 730),
  /** Positions are closed once this many days or fewer remain, so nothing is held into expiration. */
  close_at_dte: int(0, 30),
  /** |delta| band for the contract that is bought. */
  min_delta: z.number().min(0.05).max(0.95),
  max_delta: z.number().min(0.1).max(0.99),
  min_open_interest: int(0, 1_000_000),
  /** Widest bid-ask spread allowed on any leg, as % of its midpoint. */
  max_spread_pct: pct(1, 100),
  /** Spreads only: required max profit / max loss. */
  min_spread_reward_risk: z.number().min(0.1).max(10),
  /** Exit when the position's value is this % below what was paid, unless the AI set its own. */
  default_stop_loss_pct: pct(10, 95),
  /** Take profit when the position's value is this % above what was paid, unless the AI set its own. */
  default_take_profit_pct: pct(10, 1_000),
  /** Entry limit price: 0 = the midpoint, 1 = the ask (the debit at the ask, for spreads). */
  entry_aggression: z.number().min(0).max(1),
  /** An entry that hasn't filled after this long is canceled. */
  fill_timeout_seconds: int(5, 300),
  /** How often open options positions are checked against their exits. */
  monitor_seconds: int(5, 300),
  /** Underlyings whose option chains are loaded for the AI each cycle. */
  max_underlyings_per_cycle: int(1, 12),
  /** Contracts shown to the AI per underlying (calls + puts). */
  contracts_per_underlying: int(2, 30),
})

/** The AI budget day is the New York trading day: it resets at midnight ET. */
export const aiSettingsSchema = z.object({
  daily_budget_usd: aiBase.daily_budget_usd,
  models: aiBase.models,
  x_search: aiBase.x_search,
  /** Stream the model's reasoning summaries to the live feed when the provider returns them. */
  stream_reasoning: z.boolean(),
  research_timeout_seconds: aiBase.research_timeout_seconds,
  decision_timeout_seconds: aiBase.decision_timeout_seconds,
})

export const scheduleSettingsSchema = z.object({
  /** How early before the open the premarket briefing may run. */
  premarket_lead_minutes: z.number().min(10).max(240),
  /** Skip the opening auction before the first intraday cycle. */
  open_buffer_minutes: z.number().min(0).max(60),
  /** Minutes between intraday cycles. */
  trade_interval_minutes: z.number().min(5).max(240),
  /** The closing cycle runs this many minutes before the bell. */
  close_window_minutes: z.number().min(5).max(60),
  /** The postmarket review runs this long after the bell. */
  postmarket_delay_minutes: z.number().min(0).max(120),
  /** Max attempts for the once-a-day phases (premarket / close / postmarket). */
  max_phase_attempts: int(1, 5),
  /** A held stock (or option underlying) moving this % since the last cycle triggers an early intraday cycle. */
  trigger_move_pct: z.number().min(0.5).max(20),
  trigger_cooldown_minutes: z.number().min(5).max(240),
  /** Minimum gap between AI cycles, including triggered ones. Prevents churn and runaway cost. */
  min_cycle_gap_minutes: z.number().min(1).max(60),
})

/** The news engine ("wire"). An entry's matching move is a price move. */
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
  event_budget_reserve_pct: wireBase.event_budget_reserve_pct,
  event_research: wireBase.event_research,
  event_research_timeout_seconds: wireBase.event_research_timeout_seconds,
  event_decision_timeout_seconds: wireBase.event_decision_timeout_seconds,
  /** What happens at once when a held stock meets a critical, confirmed, negative event. review = Grok decides. */
  emergency_action: z.enum(["review", "exit"]),
  /** Price shocks are measured after removing SPY's move, the market-wide shock is SPY's 5-minute z-score, and IEX volume is a small slice. */
  anomaly: wireBase.anomaly,
  disabled_sources: wireBase.disabled_sources,
  retention_days: wireBase.retention_days,
  odds_swing_pts: wireBase.odds_swing_pts,
  /** Symbols the breadth scan covers. */
  scan_max_symbols: int(100, 5_000),
  /** 20-day average dollar volume a stock needs to enter the scan universe. */
  scan_min_dollar_volume: z.number().min(0).max(10_000_000_000),
  summaries: wireBase.summaries,
})

export const settingsSchema = z
  .object({
    account: z.object({
      /** The paper account's starting balance; total return is measured against it. */
      starting_capital: z.number().min(100).max(10_000_000),
    }),
    risk: riskSettingsSchema,
    options: optionsSettingsSchema,
    ai: aiSettingsSchema,
    schedule: scheduleSettingsSchema,
    universe: z.object({
      /** ETFs always included in the market snapshot so the model can read the tape. */
      benchmarks: z.array(ticker).min(1).max(40),
      /** Live price subscriptions on Alpaca's market data stream (the free plan allows 30). */
      stream_max_symbols: int(1, 1_000),
    }),
    wire: wireSettingsSchema,
  })
  .superRefine((s, ctx) => {
    const issue = (path: string[], message: string) => ctx.addIssue({ code: "custom", path, message })
    refineWireThresholds(s, ctx)
    if (s.risk.min_stop_pct >= s.risk.max_stop_pct) issue(["risk", "min_stop_pct"], "min_stop_pct must be below max_stop_pct")
    if (s.risk.default_stop_pct < s.risk.min_stop_pct || s.risk.default_stop_pct > s.risk.max_stop_pct) {
      issue(["risk", "default_stop_pct"], "default_stop_pct must be between min_stop_pct and max_stop_pct")
    }
    if (s.risk.max_daily_loss_pct >= s.risk.flatten_loss_pct) issue(["risk", "max_daily_loss_pct"], "max_daily_loss_pct must be below flatten_loss_pct")
    if (s.options.min_dte >= s.options.max_dte) issue(["options", "min_dte"], "min_dte must be below max_dte")
    if (s.options.close_at_dte >= s.options.min_dte) issue(["options", "close_at_dte"], "close_at_dte must be below min_dte")
    if (s.options.min_delta >= s.options.max_delta) issue(["options", "min_delta"], "min_delta must be below max_delta")
    if (s.options.max_premium_per_trade_pct > s.options.max_total_premium_pct) {
      issue(["options", "max_premium_per_trade_pct"], "max_premium_per_trade_pct can't exceed max_total_premium_pct")
    }
    if (new Set(s.universe.benchmarks).size !== s.universe.benchmarks.length) issue(["universe", "benchmarks"], "duplicate symbols")
  })

export type Settings = z.infer<typeof settingsSchema>
export type RiskSettings = Settings["risk"]
export type OptionsSettings = Settings["options"]

export const DEFAULT_SETTINGS: Settings = {
  account: { starting_capital: 10_000 },
  risk: {
    max_position_pct: 20,
    max_open_positions: 6,
    max_new_buys_per_cycle: 3,
    cash_reserve_pct: 5,
    max_daily_loss_pct: 2.5,
    flatten_loss_pct: 4,
    profit_lock_pct: 1.5,
    max_trades_per_day: 30,
    min_price: 5,
    min_conviction: 6,
    min_stop_pct: 0.4,
    max_stop_pct: 8,
    default_stop_pct: 2,
    min_reward_risk: 1.2,
    rebuy_cooldown_minutes: 30,
    max_overnight_pct: 50,
  },
  options: {
    enabled: true,
    allow_spreads: true,
    max_premium_per_trade_pct: 2,
    max_total_premium_pct: 15,
    max_open_positions: 4,
    max_contracts_per_trade: 10,
    min_conviction: 7,
    min_dte: 14,
    max_dte: 45,
    close_at_dte: 1,
    min_delta: 0.3,
    max_delta: 0.7,
    min_open_interest: 500,
    max_spread_pct: 10,
    min_spread_reward_risk: 0.5,
    default_stop_loss_pct: 50,
    default_take_profit_pct: 100,
    entry_aggression: 0.5,
    fill_timeout_seconds: 30,
    monitor_seconds: 15,
    max_underlyings_per_cycle: 6,
    contracts_per_underlying: 10,
  },
  ai: {
    daily_budget_usd: 10,
    models: { research: "spacexai/grok-4.5", decision: "spacexai/grok-4.7", fallback: null },
    x_search: true,
    stream_reasoning: true,
    research_timeout_seconds: 180,
    decision_timeout_seconds: 240,
  },
  schedule: {
    premarket_lead_minutes: 90,
    open_buffer_minutes: 10,
    trade_interval_minutes: 30,
    close_window_minutes: 25,
    postmarket_delay_minutes: 10,
    max_phase_attempts: 3,
    trigger_move_pct: 3,
    trigger_cooldown_minutes: 30,
    min_cycle_gap_minutes: 8,
  },
  universe: {
    benchmarks: ["SPY", "QQQ", "IWM", "DIA", "VIXY", "TLT", "GLD", "USO", "UUP", "XLK", "SMH", "XLF", "XLE", "XLV", "XLY", "XLP", "XLI", "XLU", "XLC", "XLRE"],
    stream_max_symbols: 30,
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
    event_budget_reserve_pct: 30,
    event_research: "x_verify",
    event_research_timeout_seconds: 45,
    event_decision_timeout_seconds: 90,
    emergency_action: "review",
    anomaly: { price_z: 4, volume_multiple: 5, market_z: 4 },
    disabled_sources: [],
    // Short because the Atlas tier may be the free 512 MB one. Raise it from Admin.
    retention_days: 30,
    odds_swing_pts: 15,
    scan_max_symbols: 1_500,
    scan_min_dollar_volume: 20_000_000,
    summaries: {
      enabled: true,
      // Picked over qwen3:4b, phi4-mini and gemma3:4b on 20 real articles.
      model: "llama3.2:3b",
      min_severity: 55,
      max_per_hour: 60,
      skip_domains: ["wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "economist.com", "barrons.com", "seekingalpha.com"],
      pause_hours: [],
    },
  },
}

export type SettingsPatch = DeepPartial<Settings>

export type SettingsValidation = SettingsValidationOf<Settings>

/** Applies a patch and validates the result. The only way settings change. */
export const applySettingsPatch = (base: Settings, patch: SettingsPatch): SettingsValidation => sharedApplySettingsPatch(settingsSchema, base, patch)
