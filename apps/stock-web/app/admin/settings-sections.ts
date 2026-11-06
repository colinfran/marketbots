import { AGENT_SETTINGS_SECTIONS, type SettingsSection } from "@mb/ui/lib/settings-fields"

/**
 * Every tunable setting on the Admin page, grouped. The shared form (@mb/ui/settings-form) sends
 * only the changed fields, as a patch the engine validates against the full schema.
 */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: "Trend core (rules that hold the strongest stocks in an uptrend)",
    fields: [
      { path: "core.enabled", label: "On", kind: "boolean" },
      { path: "core.max_positions", label: "Max core positions", kind: "number" },
      { path: "core.risk_per_trade_pct", label: "Risk per core position (% of equity lost at the first stop)", kind: "number", step: 0.05 },
      { path: "core.stop_atr", label: "Stop distance (daily ATRs; the stop then trails at it)", kind: "number", step: 0.25 },
      { path: "core.universe_size", label: "Stocks it ranks (most traded of the scan universe)", kind: "number" },
      { path: "core.reentry_hours", label: "No re-entry after a sale for (h)", kind: "number" },
      { path: "core.news_veto_hours", label: "Negative news vetoes an entry for (h, 0 = off)", kind: "number" },
    ],
  },
  {
    title: "Long-term book (index ETFs and leaders held for months)",
    fields: [
      { path: "long_term.enabled", label: "On", kind: "boolean" },
      { path: "long_term.spy_pct", label: "SPY (% of equity)", kind: "number" },
      { path: "long_term.qqq_pct", label: "QQQ (% of equity)", kind: "number" },
      { path: "long_term.leaders", label: "Leaders held", kind: "number" },
      { path: "long_term.leader_pct", label: "Each leader (% of equity)", kind: "number" },
      { path: "long_term.leader_trail_pct", label: "A leader's stop trails its price by (%)", kind: "number" },
    ],
  },
  {
    title: "Stock sizing",
    fields: [
      { path: "risk.max_position_pct", label: "Max per position (% of equity)", kind: "number" },
      { path: "risk.risk_per_trade_pct", label: "Risk per buy (% of equity lost at the stop)", kind: "number", step: 0.05 },
      { path: "risk.max_open_positions", label: "Max open stock positions", kind: "number" },
      { path: "risk.max_new_buys_per_cycle", label: "Max new buys in one answer", kind: "number" },
      { path: "risk.cash_reserve_pct", label: "Cash always kept (% of equity)", kind: "number" },
    ],
  },
  {
    title: "Stock entries & exits",
    fields: [
      { path: "risk.min_conviction", label: "Min agent conviction to buy (1-10)", kind: "number" },
      { path: "risk.min_reward_risk", label: "Min reward:risk", kind: "number", step: 0.1 },
      { path: "risk.min_stop_pct", label: "Min stop distance (%)", kind: "number", step: 0.1 },
      { path: "risk.max_stop_pct", label: "Max stop distance (%)", kind: "number", step: 0.5 },
      { path: "risk.default_stop_pct", label: "Default stop (%)", kind: "number", step: 0.1 },
      { path: "risk.min_price", label: "Min share price ($)", kind: "number" },
      { path: "risk.rebuy_cooldown_minutes", label: "Re-buy cooldown (min)", kind: "number" },
      { path: "risk.max_trades_per_day", label: "Max orders per day", kind: "number" },
    ],
  },
  {
    title: "Daily limits",
    fields: [
      { path: "risk.max_daily_loss_pct", label: "Day loss that blocks new buys (%)", kind: "number", step: 0.5 },
      { path: "risk.flatten_loss_pct", label: "Day loss that liquidates everything (%)", kind: "number", step: 0.5 },
    ],
  },
  {
    title: "Options",
    fields: [
      { path: "options.enabled", label: "Options trading enabled", kind: "boolean" },
      { path: "options.allow_spreads", label: "Allow debit spreads (needs options level 3)", kind: "boolean" },
      { path: "options.max_premium_per_trade_pct", label: "Max premium per position (% of equity)", kind: "number", step: 0.5 },
      { path: "options.max_total_premium_pct", label: "Max premium in total (% of equity)", kind: "number" },
      { path: "options.max_open_positions", label: "Max open options positions", kind: "number" },
      { path: "options.max_contracts_per_trade", label: "Max contracts per position", kind: "number" },
      { path: "options.min_conviction", label: "Min AI conviction (1-10)", kind: "number" },
      { path: "options.min_dte", label: "Min days to expiration", kind: "number" },
      { path: "options.max_dte", label: "Max days to expiration", kind: "number" },
      { path: "options.close_at_dte", label: "Close when this many days are left", kind: "number" },
      { path: "options.min_delta", label: "Min |delta| bought", kind: "number", step: 0.05 },
      { path: "options.max_delta", label: "Max |delta| bought", kind: "number", step: 0.05 },
      { path: "options.min_open_interest", label: "Min open interest", kind: "number" },
      { path: "options.max_spread_pct", label: "Max bid-ask spread per leg (%)", kind: "number" },
      { path: "options.min_spread_reward_risk", label: "Min spread max-profit / max-loss", kind: "number", step: 0.1 },
      { path: "options.default_stop_loss_pct", label: "Default stop (% of value lost)", kind: "number" },
      { path: "options.default_take_profit_pct", label: "Default take profit (% of value gained)", kind: "number" },
      { path: "options.entry_aggression", label: "Entry price: 0 = mid, 1 = ask", kind: "number", step: 0.1 },
      { path: "options.fill_timeout_seconds", label: "Cancel unfilled entries after (s)", kind: "number" },
      { path: "options.monitor_seconds", label: "Check exits every (s)", kind: "number" },
      { path: "options.contracts_per_underlying", label: "Contracts on the agent's option menu per stock", kind: "number" },
    ],
  },
  {
    title: "Session",
    fields: [
      { path: "schedule.premarket_lead_minutes", label: "Premarket wake-up before the open (min)", kind: "number" },
      { path: "schedule.open_buffer_minutes", label: "No buys for this long after the open (min)", kind: "number" },
      { path: "schedule.close_window_minutes", label: "Closing window before the bell (min)", kind: "number" },
      { path: "schedule.postmarket_delay_minutes", label: "After-close review after the bell (min)", kind: "number" },
      { path: "schedule.trigger_move_pct", label: "A holding moving this much since the agent's last look wakes it (%)", kind: "number", step: 0.5 },
    ],
  },
  {
    title: "News engine",
    fields: [
      { path: "wire.mode", label: "Mode (off: the news engine stops, and no news reaches the agent)", kind: "select", options: ["live", "off"] },
      { path: "wire.thresholds.annotate", label: "Severity: annotate", kind: "number" },
      { path: "wire.thresholds.review", label: "Severity: review a holding", kind: "number" },
      { path: "wire.thresholds.evaluate", label: "Severity: evaluate an entry", kind: "number" },
      { path: "wire.thresholds.critical", label: "Severity: critical", kind: "number" },
      { path: "wire.entry_confirmation", label: "Entries need confirmation", kind: "boolean" },
      { path: "wire.unexplained_move_entries", label: "An unexplained move in a stock we don't hold wakes the agent for an entry", kind: "boolean" },
      { path: "wire.trigger_max_age_minutes", label: "Only items newer than this can trigger (min)", kind: "number" },
      { path: "wire.symbol_cooldown_minutes", label: "Per-symbol trigger cooldown (min)", kind: "number" },
      { path: "wire.emergency_action", label: "Critical bad news on a holding", kind: "select", options: ["review", "exit"] },
      { path: "wire.anomaly.price_z", label: "Price shock z-score (after SPY's move)", kind: "number", step: 0.5 },
      { path: "wire.anomaly.volume_multiple", label: "Volume shock (× median)", kind: "number", step: 0.5 },
      { path: "wire.anomaly.market_z", label: "Market shock z-score (SPY, 5 min)", kind: "number", step: 0.5 },
      { path: "wire.odds_swing_pts", label: "Prediction-market odds swing (pts in an hour)", kind: "number" },
      { path: "wire.scan_max_symbols", label: "Symbols in the price scan", kind: "number" },
      { path: "wire.scan_min_dollar_volume", label: "Min 20-day dollar volume to be scanned ($)", kind: "number" },
      { path: "wire.retention_days", label: "Keep news items (days)", kind: "number" },
      { path: "wire.disabled_sources", label: "Disabled sources (ids, comma-separated)", kind: "idlist" },
    ],
  },
  {
    title: "Article summaries (local model: the News page and the agent's news)",
    fields: [
      { path: "wire.summaries.enabled", label: "Summarize important articles", kind: "boolean" },
      { path: "wire.summaries.min_severity", label: "Min severity (notable items always)", kind: "number" },
      { path: "wire.summaries.max_per_hour", label: "Max articles per hour", kind: "number" },
      { path: "wire.summaries.skip_domains", label: "Never fetch (domains, comma-separated)", kind: "idlist" },
      { path: "wire.summaries.pause_hours", label: "Pause hours (UTC ranges, e.g. 22-6)", kind: "idlist" },
    ],
  },
  {
    title: "Universe & account",
    fields: [
      { path: "universe.benchmarks", label: "Benchmark ETFs (comma-separated)", kind: "list" },
      { path: "universe.stream_max_symbols", label: "Live price subscriptions (free plan: 30)", kind: "number" },
      { path: "account.starting_capital", label: "Starting capital ($), for total return", kind: "number" },
    ],
  },
  ...AGENT_SETTINGS_SECTIONS,
]
