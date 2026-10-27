"use client"

import { BrainIcon, LoaderIcon } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { CommandResult, useCommand } from "@/components/command"
import { Button } from "@/components/ui/button"

/** Owner: put a pair in front of the AI right now (watch it work on the AI research page). */
export function EvaluateForm({ universe, disabled }: { universe: string[]; disabled: boolean }) {
  const [symbol, setSymbol] = useState(universe[0] ?? "BTC/USD")
  const { busy, result, error, send } = useCommand()
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        void send({ type: "cycle.run_now", symbols: [symbol] })
      }}
    >
      <div className="flex gap-2">
        <select aria-label="Pair" className="bg-background h-8 rounded-md border px-2 font-mono text-sm" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {universe.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={busy || disabled}>
          {busy ? <LoaderIcon className="animate-spin" aria-hidden /> : <BrainIcon aria-hidden />}
          Ask the AI
        </Button>
      </div>
      <CommandResult result={result} error={error} />
      {result && (
        <Link href="/research" className="text-muted-foreground text-xs hover:underline">
          Watch the research live
        </Link>
      )}
    </form>
  )
}
