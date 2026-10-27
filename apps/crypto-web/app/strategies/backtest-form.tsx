"use client"

import { BACKTEST_STRATEGIES } from "@mb/crypto-core/commands"
import { LoaderIcon } from "lucide-react"
import { useState } from "react"
import { CommandResult, useCommand } from "@/components/command"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { titleCase } from "@/lib/format"

type BacktestStrategy = (typeof BACKTEST_STRATEGIES)[number]

/** Owner-only: launch a backtest of the deterministic strategy layer on Kraken history. */
export function BacktestForm({ universe, feeBps, slippageBps }: { universe: string[]; feeBps: number; slippageBps: number }) {
  const { busy, result, error, send } = useCommand()
  const [symbols, setSymbols] = useState(universe.slice(0, 5).join(", "))
  const [strategies, setStrategies] = useState<BacktestStrategy[]>([...BACKTEST_STRATEGIES])
  const [interval, setInterval_] = useState<60 | 240 | 1440>(240)
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        void send({
          type: "backtest.run",
          params: {
            symbols: symbols.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
            strategies,
            interval,
            starting_usd: 10_000,
            fee_bps: feeBps,
            slippage_bps: slippageBps,
            in_sample_fraction: 0.7,
          },
        })
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="bt-symbols">Pairs</Label>
        <Input id="bt-symbols" value={symbols} onChange={(e) => setSymbols(e.target.value)} />
      </div>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Strategies</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {BACKTEST_STRATEGIES.map((s) => (
            <label key={s} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={strategies.includes(s)} onChange={(e) => setStrategies(e.target.checked ? [...strategies, s] : strategies.filter((x) => x !== s))} />
              {titleCase(s)}
            </label>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          Event-driven needs research at decision time, so it can&apos;t be backtested without look-ahead. Long-term trend holds for weeks, longer than the backtest&apos;s 72h
          time stop.
        </p>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Bar interval</legend>
        <div className="flex gap-3 text-sm">
          {([60, 240, 1440] as const).map((i) => (
            <label key={i} className="inline-flex items-center gap-1.5">
              <input type="radio" name="interval" checked={interval === i} onChange={() => setInterval_(i)} />
              {i === 60 ? "1h (30 days)" : i === 240 ? "4h (120 days)" : "1d (2 years)"}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="text-muted-foreground text-xs">
        Costs: {feeBps} bps fee + {slippageBps} bps slippage per side (the paper wallet&apos;s settings). 70% in-sample / 30% out-of-sample.
      </p>
      <Button type="submit" size="sm" disabled={busy || !strategies.length}>
        {busy && <LoaderIcon className="animate-spin" aria-hidden />}
        Run backtest
      </Button>
      <CommandResult result={result} error={error} />
    </form>
  )
}
