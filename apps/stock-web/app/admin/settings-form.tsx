"use client"

import type { Settings } from "@mb/stock-core/settings"
import { LoaderIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { CommandResult, useCommand } from "@/components/command"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

/**
 * Every tunable setting, grouped. Only changed fields are sent, as a patch the engine validates
 * against the full schema (with optimistic concurrency, so two tabs can't overwrite each other).
 */

type Field = { path: string; label: string; kind: "number" | "boolean" | "text" | "list" | "idlist" | "select"; options?: string[]; step?: number }

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Stock sizing",
    fields: [
      { path: "risk.max_position_pct", label: "Max per position (% of equity)", kind: "number" },
      { path: "risk.max_open_positions", label: "Max open stock positions", kind: "number" },
      { path: "risk.max_new_buys_per_cycle", label: "Max new buys per cycle", kind: "number" },
      { path: "risk.cash_reserve_pct", label: "Cash always kept (% of equity)", kind: "number" },
      { path: "risk.max_overnight_pct", label: "Max carried overnight (% of equity)", kind: "number" },
    ],
  },
  {
    title: "Stock entries & exits",
    fields: [
      { path: "risk.min_conviction", label: "Min AI conviction to buy (1-10)", kind: "number" },
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
      { path: "risk.profit_lock_pct", label: "Day gain that halves new sizes (%)", kind: "number", step: 0.5 },
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
      { path: "options.max_underlyings_per_cycle", label: "Option chains loaded per cycle", kind: "number" },
      { path: "options.contracts_per_underlying", label: "Contracts shown to the AI per stock", kind: "number" },
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
      { path: "ai.stream_reasoning", label: "Stream model reasoning summaries", kind: "boolean" },
      { path: "ai.research_timeout_seconds", label: "Research timeout (s)", kind: "number" },
      { path: "ai.decision_timeout_seconds", label: "Decision timeout (s)", kind: "number" },
    ],
  },
  {
    title: "Schedule",
    fields: [
      { path: "schedule.premarket_lead_minutes", label: "Premarket briefing before the open (min)", kind: "number" },
      { path: "schedule.open_buffer_minutes", label: "Wait after the open (min)", kind: "number" },
      { path: "schedule.trade_interval_minutes", label: "Intraday cycle every (min)", kind: "number" },
      { path: "schedule.close_window_minutes", label: "Closing cycle before the bell (min)", kind: "number" },
      { path: "schedule.postmarket_delay_minutes", label: "Postmarket review after the bell (min)", kind: "number" },
      { path: "schedule.max_phase_attempts", label: "Attempts for once-a-day phases", kind: "number" },
      { path: "schedule.trigger_move_pct", label: "Extra cycle when a holding moves (%)", kind: "number", step: 0.5 },
      { path: "schedule.trigger_cooldown_minutes", label: "Price-move trigger cooldown (min)", kind: "number" },
      { path: "schedule.min_cycle_gap_minutes", label: "Min gap between cycles (min)", kind: "number" },
    ],
  },
  {
    title: "News engine",
    fields: [
      { path: "wire.mode", label: "Mode (off = scheduled cycles only; shadow = log triggers, act on none)", kind: "select", options: ["live", "shadow", "off"] },
      { path: "wire.research_mode", label: "Grok research (auto skips it when our feeds leave no gap)", kind: "select", options: ["auto", "gap_fill", "full"] },
      { path: "wire.thresholds.annotate", label: "Severity: annotate", kind: "number" },
      { path: "wire.thresholds.review", label: "Severity: review a holding", kind: "number" },
      { path: "wire.thresholds.evaluate", label: "Severity: evaluate an entry", kind: "number" },
      { path: "wire.thresholds.critical", label: "Severity: critical", kind: "number" },
      { path: "wire.entry_confirmation", label: "Entries need confirmation", kind: "boolean" },
      { path: "wire.trigger_max_age_minutes", label: "Only items newer than this can trigger (min)", kind: "number" },
      { path: "wire.max_event_cycles_per_hour", label: "Max event cycles per hour", kind: "number" },
      { path: "wire.max_event_cycles_per_day", label: "Max event cycles per day", kind: "number" },
      { path: "wire.event_budget_reserve_pct", label: "AI budget reserved for events (%)", kind: "number" },
      { path: "wire.symbol_cooldown_minutes", label: "Per-symbol trigger cooldown (min)", kind: "number" },
      { path: "wire.event_min_gap_seconds", label: "Min gap between event cycles (s)", kind: "number" },
      { path: "wire.event_research", label: "Event research", kind: "select", options: ["x_verify", "none"] },
      { path: "wire.event_research_timeout_seconds", label: "Event research timeout (s)", kind: "number" },
      { path: "wire.event_decision_timeout_seconds", label: "Event decision timeout (s)", kind: "number" },
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
    title: "Universe & account",
    fields: [
      { path: "universe.benchmarks", label: "Benchmark ETFs (comma-separated)", kind: "list" },
      { path: "universe.stream_max_symbols", label: "Live price subscriptions (free plan: 30)", kind: "number" },
      { path: "account.starting_capital", label: "Starting capital ($), for total return", kind: "number" },
    ],
  },
]

const get = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], obj)

const setIn = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split(".")
  let cur = obj
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
  cur[keys.at(-1)!] = value
}

const toInput = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v))

export function SettingsForm({ settings, version }: { settings: Settings; version: number }) {
  const initial = useMemo(() => Object.fromEntries(GROUPS.flatMap((g) => g.fields).map((f) => [f.path, get(settings, f.path)])), [settings])
  const [values, setValues] = useState<Record<string, unknown>>(initial)
  const { busy, result, error, send } = useCommand()
  const fields = GROUPS.flatMap((g) => g.fields)
  const parse = (f: Field, raw: unknown): unknown => {
    if (f.kind === "number") return Number(raw)
    if (f.kind === "list") return String(raw).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    if (f.kind === "idlist") return String(raw).split(",").map((s) => s.trim()).filter(Boolean)
    if (f.kind === "text" && f.path === "ai.models.fallback") return toInput(raw).trim() || null
    return raw
  }
  const changed = fields.filter((f) => JSON.stringify(parse(f, values[f.path])) !== JSON.stringify(initial[f.path]))

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault()
        const patch: Record<string, unknown> = {}
        for (const f of changed) setIn(patch, f.path, parse(f, values[f.path]))
        void send({ type: "settings.update", patch, expected_version: version })
      }}
    >
      {GROUPS.map((g) => (
        <fieldset key={g.title} className="space-y-3">
          <legend className="mb-2 text-sm font-semibold">{g.title}</legend>
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            {g.fields.map((f) => {
              const id = `s-${f.path}`
              const dirty = changed.includes(f)
              return (
                <div key={f.path} className="flex items-center justify-between gap-3">
                  <Label htmlFor={id} className={dirty ? "text-foreground font-medium" : "text-muted-foreground font-normal"}>
                    {f.label}
                    {dirty && " •"}
                  </Label>
                  {f.kind === "boolean" ? (
                    <Switch id={id} checked={Boolean(values[f.path])} onCheckedChange={(v) => setValues({ ...values, [f.path]: v })} />
                  ) : f.kind === "select" ? (
                    <select id={id} className="bg-background h-8 rounded-md border px-2 text-sm" value={String(values[f.path])} onChange={(e) => setValues({ ...values, [f.path]: e.target.value })}>
                      {f.options!.map((o) => (
                        <option key={o} value={o}>
                          {o.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      className={f.kind === "number" ? "w-28 text-right font-mono" : "w-64 font-mono text-xs"}
                      type={f.kind === "number" ? "number" : "text"}
                      step={f.step ?? "any"}
                      value={toInput(values[f.path])}
                      onChange={(e) => setValues({ ...values, [f.path]: e.target.value })}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}
      <div className="bg-background/90 sticky bottom-0 flex flex-wrap items-center gap-3 border-t py-3 backdrop-blur">
        <Button type="submit" disabled={busy || changed.length === 0}>
          {busy && <LoaderIcon className="animate-spin" aria-hidden />}
          Save {changed.length ? `${changed.length} change${changed.length > 1 ? "s" : ""}` : ""}
        </Button>
        {changed.length > 0 && (
          <Button type="button" variant="ghost" onClick={() => setValues(initial)}>
            Discard
          </Button>
        )}
        <CommandResult result={result} error={error} />
        <span className="text-muted-foreground ml-auto text-xs">settings v{version} · validated by the engine before it applies them</span>
      </div>
    </form>
  )
}
