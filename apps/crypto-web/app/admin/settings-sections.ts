import type { SettingsSection } from "@mb/ui/settings-form"

/**
 * Every tunable setting on the Admin page, grouped. The shared form (@mb/ui/settings-form) sends
 * only the changed fields, as a patch the engine validates against the full schema.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: "Position sizing & exposure",
    fields: [
      { path: "kraken.risk_per_trade_pct", label: "Risk per trade (% of equity lost at the stop)", kind: "number", step: 0.05 },
      { path: "kraken.max_position_pct", label: "Max position (% of equity)", kind: "number" },
      { path: "kraken.max_asset_exposure_pct", label: "Max per asset (%)", kind: "number" },
      { path: "kraken.max_total_exposure_pct", label: "Max total exposure (%)", kind: "number" },
      { path: "kraken.max_correlated_exposure_pct", label: "Max correlated exposure (%)", kind: "number" },
      { path: "kraken.correlation_threshold", label: "Correlation threshold", kind: "number", step: 0.05 },
      { path: "kraken.max_concurrent_positions", label: "Max concurrent positions", kind: "number" },
    ],
  },
  {
    title: "Entry quality",
    fields: [
      { path: "kraken.min_edge_bps", label: "Min expected edge after costs (bps)", kind: "number" },
      { path: "kraken.min_reward_risk", label: "Min reward:risk", kind: "number", step: 0.1 },
      { path: "kraken.min_conviction", label: "Min AI conviction (0-100)", kind: "number" },
      { path: "kraken.min_stop_pct", label: "Min stop distance (%)", kind: "number", step: 0.1 },
      { path: "kraken.max_stop_pct", label: "Max stop distance (%)", kind: "number", step: 0.5 },
      { path: "kraken.max_spread_bps", label: "Max spread (bps)", kind: "number" },
      { path: "kraken.max_slippage_bps", label: "Max slippage / limit offset (bps)", kind: "number" },
      { path: "kraken.max_quote_age_seconds", label: "Max quote age (s)", kind: "number" },
    ],
  },
  {
    title: "Churn control",
    fields: [
      { path: "kraken.max_trades_per_day", label: "Max trades per day", kind: "number" },
      { path: "kraken.reentry_cooldown_minutes", label: "Re-entry cooldown (min)", kind: "number" },
      { path: "kraken.min_hold_minutes", label: "Min hold before AI exits (min)", kind: "number" },
    ],
  },
  {
    title: "Portfolio limits",
    fields: [
      { path: "portfolio.max_daily_loss_pct", label: "Daily loss limit (%): blocks entries", kind: "number", step: 0.5 },
      { path: "portfolio.max_drawdown_pct", label: "Max drawdown (%): engages the kill switch", kind: "number" },
      { path: "portfolio.drawdown_action", label: "At max drawdown", kind: "select", options: ["halt", "halt_and_liquidate"] },
    ],
  },
  {
    title: "AI",
    fields: [
      { path: "ai.daily_budget_usd", label: "Daily AI budget ($)", kind: "number" },
      { path: "ai.models.research", label: "Research model (needs live search: xai/… or spacexai/…)", kind: "text" },
      { path: "ai.models.decision", label: "Decision model", kind: "text" },
      { path: "ai.models.fallback", label: "Fallback model (blank = none)", kind: "text" },
      { path: "ai.x_search", label: "Use X (Twitter) search", kind: "boolean" },
      { path: "ai.max_candidates_per_cycle", label: "Max candidates per cycle", kind: "number" },
      { path: "ai.probability_shrink", label: "Weight on AI probability vs random-walk prior (0-1)", kind: "number", step: 0.05 },
      { path: "ai.research_timeout_seconds", label: "Research timeout (s)", kind: "number" },
      { path: "ai.decision_timeout_seconds", label: "Decision timeout (s)", kind: "number" },
    ],
  },
  {
    title: "Schedule",
    fields: [
      { path: "schedule.crypto_scan_minutes", label: "Scan every (min)", kind: "number" },
      { path: "schedule.position_review_minutes", label: "Review each position every (min)", kind: "number" },
      { path: "schedule.min_ai_interval_minutes", label: "Min gap between AI cycles (min)", kind: "number" },
      { path: "schedule.trigger_cooldown_minutes", label: "Price-move trigger cooldown (min)", kind: "number" },
    ],
  },
  {
    title: "News engine",
    fields: [
      { path: "wire.mode", label: "Mode (off = scheduled cycles only; shadow = log triggers, act on none)", kind: "select", options: ["live", "shadow", "off"] },
      { path: "wire.research_mode", label: "Grok research (auto: only when our feeds leave a gap on a candidate, a holding or the market)", kind: "select", options: ["auto", "gap_fill", "full"] },
      { path: "wire.thresholds.annotate", label: "Severity: annotate", kind: "number" },
      { path: "wire.thresholds.review", label: "Severity: review a holding", kind: "number" },
      { path: "wire.thresholds.evaluate", label: "Severity: evaluate an entry", kind: "number" },
      { path: "wire.thresholds.critical", label: "Severity: critical", kind: "number" },
      { path: "wire.entry_confirmation", label: "Entries need confirmation", kind: "boolean" },
      { path: "wire.unexplained_move_entries", label: "An unexplained move in a pair we don't hold starts an entry check", kind: "boolean" },
      { path: "wire.max_event_cycles_per_hour", label: "Max event cycles per hour", kind: "number" },
      { path: "wire.max_event_cycles_per_day", label: "Max event cycles per day", kind: "number" },
      { path: "wire.event_budget_reserve_pct", label: "AI budget reserved for events (%)", kind: "number" },
      { path: "wire.symbol_cooldown_minutes", label: "Per-symbol trigger cooldown (min)", kind: "number" },
      { path: "wire.event_min_gap_seconds", label: "Min gap between event cycles (s)", kind: "number" },
      { path: "wire.event_research", label: "Event research", kind: "select", options: ["x_verify", "none"] },
      { path: "wire.emergency_action", label: "Critical bad news on a holding", kind: "select", options: ["review", "tighten_stop", "exit"] },
      { path: "wire.anomaly.price_z", label: "Price shock z-score", kind: "number", step: 0.5 },
      { path: "wire.anomaly.volume_multiple", label: "Volume shock (× median)", kind: "number", step: 0.5 },
      { path: "wire.anomaly.market_z", label: "Market shock z-score (BTC, 5 min)", kind: "number", step: 0.5 },
      { path: "wire.depeg_pct", label: "Stablecoin depeg (% off $1)", kind: "number", step: 0.1 },
      { path: "wire.tvl_drop_pct", label: "Chain TVL drop within 1 h (%)", kind: "number" },
      { path: "wire.funding_extreme_annual_pct", label: "Extreme perp funding (± % a year)", kind: "number" },
      { path: "wire.odds_swing_pts", label: "Prediction-market swing within 1 h (points)", kind: "number" },
      { path: "wire.coinbase_premium_pct", label: "Coinbase premium vs Kraken for 5 min (%)", kind: "number", step: 0.05 },
      { path: "wire.retention_days", label: "Keep news items (days)", kind: "number" },
      { path: "wire.disabled_sources", label: "Disabled sources (ids, comma-separated)", kind: "idlist" },
    ],
  },
  {
    title: "Article summaries (local model, News page only)",
    fields: [
      { path: "wire.summaries.enabled", label: "Summarize important articles", kind: "boolean" },
      { path: "wire.summaries.model", label: "Model (Ollama tag)", kind: "text" },
      { path: "wire.summaries.min_severity", label: "Min severity (notable items always)", kind: "number" },
      { path: "wire.summaries.max_per_hour", label: "Max articles per hour", kind: "number" },
      { path: "wire.summaries.skip_domains", label: "Never fetch (domains, comma-separated)", kind: "idlist" },
      { path: "wire.summaries.pause_hours", label: "Pause hours (UTC ranges, e.g. 22-6)", kind: "idlist" },
    ],
  },
  {
    title: "Universe & paper wallet",
    fields: [
      { path: "universe.kraken_symbols", label: "Pairs (comma-separated, e.g. BTC/USD)", kind: "list" },
      { path: "paper.starting_usd", label: "Paper starting capital ($): applies at next reset", kind: "number" },
      { path: "kraken.taker_fee_bps", label: "Paper fee per fill (bps): applies at next reset", kind: "number" },
      { path: "kraken.paper_slippage_bps", label: "Paper slippage (bps): applies at next reset", kind: "number" },
    ],
  },
]
