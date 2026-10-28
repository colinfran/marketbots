"use client"

import { PHASES, type Phase } from "@mb/stock-core/settings"
import { BrainIcon, LoaderIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { Button } from "@mb/ui/components/button"
import { Input } from "@mb/ui/components/input"
import { CommandResult, useCommand } from "@/components/command"

/** Owner: run a cycle now, optionally putting specific tickers in front of the AI (watch it work on the Live page). */
export function EvaluateForm({ disabled }: { disabled: boolean }) {
  const [phase, setPhase] = useState<Phase | "auto">("auto")
  const [symbols, setSymbols] = useState("")
  const { busy, result, error, send } = useCommand()
  const tickers = symbols
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase().replace(/^\$/, ""))
    .filter(Boolean)
  const valid = tickers.every((t) => /^[A-Z][A-Z.]{0,9}$/.test(t)) && tickers.length <= 5
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void send({ type: "cycle.run_now", ...(phase === "auto" ? {} : { phase }), ...(tickers.length ? { symbols: tickers } : {}) })
      }}
    >
      <div className="flex flex-wrap gap-2">
        <select aria-label="Phase" className="bg-background h-8 rounded-md border px-2 text-sm" value={phase} onChange={(e) => setPhase(e.target.value as Phase | "auto")}>
          <option value="auto">Phase: per schedule</option>
          {PHASES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Input aria-label="Tickers to evaluate" placeholder="Tickers (optional): NVDA, AAPL" className="h-8 w-56 font-mono text-xs" value={symbols} onChange={(e) => setSymbols(e.target.value)} />
        <Button type="submit" size="sm" disabled={busy || disabled || !valid}>
          {busy ? <LoaderIcon className="animate-spin" aria-hidden /> : <BrainIcon aria-hidden />}
          Run a cycle
        </Button>
      </div>
      {!valid && <p className="text-loss text-xs">Up to 5 tickers, like NVDA or BRK.B.</p>}
      <CommandResult result={result} error={error} />
      {result && (
        <Link href="/" className="text-muted-foreground text-xs hover:underline">
          Watch it live
        </Link>
      )}
    </form>
  )
}
