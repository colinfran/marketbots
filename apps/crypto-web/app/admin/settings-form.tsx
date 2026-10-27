"use client"

import type { Settings } from "@mb/crypto-core/settings"
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

type Field = { path: string; label: string; help?: string; kind: "number" | "boolean" | "text" | "list" | "idlist" | "select"; options?: string[]; step?: number }

const GROUPS: { title: string; fields: Field[] }[] = [
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
      { path: "wire.research_mode", label: "Grok research (auto skips it when our feeds leave no gap)", kind: "select", options: ["auto", "gap_fill", "full"] },
      { path: "wire.thresholds.annotate", label: "Severity: annotate", kind: "number" },
      { path: "wire.thresholds.review", label: "Severity: review a holding", kind: "number" },
      { path: "wire.thresholds.evaluate", label: "Severity: evaluate an entry", kind: "number" },
      { path: "wire.thresholds.critical", label: "Severity: critical", kind: "number" },
      { path: "wire.entry_confirmation", label: "Entries need confirmation", kind: "boolean" },
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
    title: "Universe & paper wallet",
    fields: [
      { path: "universe.kraken_symbols", label: "Pairs (comma-separated, e.g. BTC/USD)", kind: "list" },
      { path: "paper.starting_usd", label: "Paper starting capital ($): applies at next reset", kind: "number" },
      { path: "kraken.taker_fee_bps", label: "Paper fee per fill (bps): applies at next reset", kind: "number" },
      { path: "kraken.paper_slippage_bps", label: "Paper slippage (bps): applies at next reset", kind: "number" },
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
      <div className="bg-background/90 sticky bottom-0 flex items-center gap-3 border-t py-3 backdrop-blur">
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
