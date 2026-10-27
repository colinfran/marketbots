"use client"

// Mirrored in cryptomarketbot and stockmarketbot (apps/web/app/admin/seed-card.tsx): keep in sync.

import type { SeedRunDoc } from "@mb/crypto-core/db"
import { LoaderIcon, SproutIcon } from "lucide-react"
import Link from "next/link"
import { useState, useSyncExternalStore } from "react"
import { StatusBadge } from "@/components/bits"
import { CommandButton, CommandResult, useCommand } from "@/components/command"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { usd } from "@/lib/format"

/**
 * Owner: the one-time seed buy. Shows the current or last run and schedules a new one (amount and
 * time, defaulting to $2,000 at the next 09:45 New York time). After a completed run, scheduling
 * another needs the "force" box and a confirmation, because the seed is meant to happen once.
 */

const NY = "America/New_York"

/** New York's offset from UTC at an instant, in minutes (−240 in summer, −300 in winter). */
const nyOffsetMinutes = (at: Date) => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: NY, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? ""
  const m = /GMT([+-])(\d{1,2}):?(\d{2})?/.exec(name)
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : -300
}

/** The next hour:minute in New York, skipping weekends when asked (holidays aren't known here). */
export const nextNyTime = (hour: number, minute: number, weekdaysOnly: boolean, now = new Date()) => {
  for (let d = 0; d < 9; d++) {
    const [y, mo, da] = new Intl.DateTimeFormat("en-CA", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(now.getTime() + d * 86_400_000))
      .split("-")
      .map(Number)
    const weekday = new Date(Date.UTC(y, mo - 1, da)).getUTCDay()
    if (weekdaysOnly && (weekday === 0 || weekday === 6)) continue
    const wall = Date.UTC(y, mo - 1, da, hour, minute)
    const at = new Date(wall - nyOffsetMinutes(new Date(wall)) * 60_000)
    if (at.getTime() > now.getTime()) return at
  }
  return new Date(now.getTime() + 86_400_000)
}

const pad = (n: number) => String(n).padStart(2, "0")
/** A Date as the value of a datetime-local input (the browser's own time zone). */
const toLocalInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const noSubscribe = () => () => undefined
const nyText = (d: Date) => d.toLocaleString("en-US", { timeZone: NY, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export function SeedCard({ runs, weekdaysOnly, note }: { runs: SeedRunDoc[]; weekdaysOnly: boolean; note: string }) {
  const latest = runs[0] ?? null
  const active = runs.find((r) => r.status === "scheduled" || r.status === "running") ?? null
  const hasDone = runs.some((r) => r.status === "done")
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SproutIcon className="size-4" aria-hidden />
          One-time seed {latest && <StatusBadge status={latest.status} />}
        </CardTitle>
        <CardDescription>{note}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {latest && <RunSummary run={latest} />}
        {active?.status === "scheduled" ? (
          <CommandButton
            command={{ type: "seed.cancel" }}
            label="Cancel the scheduled seed"
            confirm={{ title: "Cancel the seed?", description: `Nothing will be bought at ${nyText(new Date(active.at))} ET. You can schedule it again later.`, action: "Cancel seed" }}
          />
        ) : active ? null : (
          <SeedForm hasDone={hasDone} weekdaysOnly={weekdaysOnly} />
        )}
      </CardContent>
    </Card>
  )
}

function RunSummary({ run }: { run: SeedRunDoc }) {
  const r = run.result
  return (
    <div className="space-y-2 text-sm">
      <p>
        {usd(run.amount_usd, { whole: true })} · {run.status === "scheduled" ? "runs" : "scheduled for"} {nyText(new Date(run.at))} ET
        {run.force && <span className="text-muted-foreground"> · forced</span>}
        {run.cycle_id && (
          <>
            {" · "}
            <Link href={`/research/${run.cycle_id}`} className="underline-offset-2 hover:underline">
              research and decision
            </Link>
          </>
        )}
      </p>
      {run.error && <p className="text-loss text-xs">{run.error}</p>}
      {r && r.allocations.length > 0 && (
        <ul className="space-y-1">
          {r.allocations.map((a) => {
            const order = r.orders.find((o) => o.symbol === a.symbol)
            return (
              <li key={a.symbol} className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{a.symbol}</span>
                <span className="text-muted-foreground text-xs">
                  {a.weight_pct}% · {usd(a.notional_usd)}
                </span>
                {order && <StatusBadge status={order.status} />}
                {order?.reason && order.status !== "filled" && <span className="text-muted-foreground text-xs">{order.reason}</span>}
              </li>
            )
          })}
        </ul>
      )}
      {r?.rationale && <p className="text-muted-foreground line-clamp-4 text-xs">{r.rationale}</p>}
    </div>
  )
}

function SeedForm({ hasDone, weekdaysOnly }: { hasDone: boolean; weekdaysOnly: boolean }) {
  const { busy, result, error, send } = useCommand()
  const [amount, setAmount] = useState("2000")
  // The default depends on the browser's clock and time zone, so the server renders it empty.
  const defaultAt = useSyncExternalStore(noSubscribe, () => toLocalInput(nextNyTime(9, 45, weekdaysOnly)), () => "")
  const [edited, setAt] = useState<string | null>(null)
  const at = edited ?? defaultAt
  const [force, setForce] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const when = at ? new Date(at) : null
  const valid = !!when && Number.isFinite(when.getTime()) && Number(amount) >= 100 && Number(amount) <= 10_000
  const submit = () => {
    if (!valid || !when) return
    void send({ type: "seed.schedule", amount_usd: Number(amount), at: when.toISOString(), ...(force ? { force: true } : {}) })
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (force) setConfirming(true)
        else submit()
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="seed-amount">Amount (USD)</Label>
          <Input id="seed-amount" type="number" min={100} max={10_000} step={50} className="w-32" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="seed-at">Time (your local time)</Label>
          <Input id="seed-at" type="datetime-local" className="w-56" value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
        <Button type="submit" size="sm" disabled={busy || !valid || (hasDone && !force)}>
          {busy && <LoaderIcon className="animate-spin" aria-hidden />}
          Schedule seed
        </Button>
      </div>
      {when && Number.isFinite(when.getTime()) && <p className="text-muted-foreground text-xs">That is {nyText(when)} New York time.</p>}
      {hasDone && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          Force a new seed (one already ran)
        </label>
      )}
      <CommandResult result={result} error={error} />
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run another seed?</DialogTitle>
            <DialogDescription>
              A seed has already run. This schedules a second one-time buy of {usd(Number(amount), { whole: true })}
              {when ? ` at ${nyText(when)} New York time` : ""}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              onClick={() => {
                setConfirming(false)
                submit()
              }}
            >
              Schedule anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}
