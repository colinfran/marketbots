import type { WireSettingsBase } from "@mb/core/settings"

/** The `wire` settings both bots ship with (their DEFAULT_SETTINGS.wire, shared fields only). */
export const WIRE_SETTINGS: WireSettingsBase = {
  mode: "live",
  thresholds: { annotate: 30, review: 55, evaluate: 70, critical: 85 },
  entry_confirmation: true,
  unexplained_move_entries: false,
  trigger_max_age_minutes: 15,
  symbol_cooldown_minutes: 30,
  max_event_cycles_per_hour: 4,
  max_event_cycles_per_day: 24,
  anomaly: { price_z: 4, volume_multiple: 5, market_z: 4 },
  disabled_sources: [],
  retention_days: 30,
  odds_swing_pts: 15,
  summaries: {
    enabled: true,
    min_severity: 55,
    max_per_hour: 60,
    skip_domains: ["wsj.com", "ft.com", "bloomberg.com", "nytimes.com", "economist.com", "barrons.com", "seekingalpha.com"],
    pause_hours: [],
  },
}
