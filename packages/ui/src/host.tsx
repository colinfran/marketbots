"use client"

import {
  FAN_CURVE,
  FAN_MIN_PCT,
  FAN_PROTECT_C,
  HOST_CURRENCIES,
  HOST_INTERVALS_MS,
  HOST_RANGES,
  hostFresh,
  type EnergyPeriod,
  type FanMode,
  type HostCommand,
  type HostFans,
  type HostGpu,
  type HostHistoryView,
  type HostRange,
  type HostStatusView,
} from "@mb/core/host"
import { cn } from "cn"
import { CpuIcon, FanIcon, GpuIcon, LoaderIcon, MemoryStickIcon, PlugZapIcon, TriangleAlertIcon } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { Empty, KV, Meter, SectionTitle } from "./bits"
import { ChartTabsList, LinesChart, type LineSpec } from "./charts"
import { CommandResult, useCommand } from "./command"
import { Button } from "./components/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/card"
import { Input } from "./components/input"
import { Label } from "./components/label"
import { Slider } from "./components/slider"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/table"
import { useKit } from "./kit"
import { num } from "./lib/format"
import { useNow } from "./live"

/**
 * Admin → Server (docs/SERVER.md §11), the same in both dashboards: the Windows server's CPU, GPUs,
 * memory, fans, storage and power as the host agent last read them (polled every 2 seconds), their
 * history, and the owner's fan and agent settings. Readings older than HOST_STALE_MS are not shown
 * as current: the page says the agent is offline instead.
 *
 * Colors follow the entity across every chart: the CPU is series 1, the first card series 2, the
 * second series 3 (styles.css).
 */

// ─── Formatting ──────────────────────────────────────────────────────────────

const GB = 1024 ** 3
const bytes = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n >= 1024 * GB ? `${num(n / (1024 * GB), 2)} TB` : `${num(n / GB, 1)} GB`)
const rate = (n: number | null) => (n === null ? "—" : n < 1024 ** 2 ? `${num(n / 1024, 0)} KB/s` : `${num(n / 1024 ** 2, 1)} MB/s`)
const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "—" : `${num(v, digits)}%`)
const celsius = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${num(v, 0)} °C`)
const watts = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "—" : `${num(v, digits)} W`)
const kwh = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${num(v, 2)} kWh`)
const money = (v: number | null | undefined, currency: string) => (v === null || v === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(v))
const hours = (ms: number) => num(ms / 3_600_000, 1)

const uptime = (s: number | null) => {
  if (s === null) return "—"
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} m` : `${m} m`
}

/** Each card's chart slot, by its index on the bus: the CPU holds slot 1. */
const gpuSlots = (gpus: { id: string }[]) => new Map(gpus.slice(0, 2).map((g, i) => [g.id, (i + 2) as 2 | 3]))

const shortModel = (model: string) => model.replace(/^NVIDIA (GeForce )?/, "")

const COMMANDS = { endpoint: "/api/host/commands", runner: "the server's host agent" }

/** A command hook, held above a form that remounts when the saved values change, so its result outlives the remount. */
type Command = ReturnType<typeof useCommand<HostCommand>>

// ─── Pieces ──────────────────────────────────────────────────────────────────

function SummaryCard({ icon: Icon, label, value, children }: { icon: typeof CpuIcon; label: string; value: ReactNode; children: ReactNode }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-1.5">
          <Icon className="size-3.5" aria-hidden />
          {label}
        </CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 px-4 text-sm">{children}</CardContent>
    </Card>
  )
}

const Muted = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground text-xs tabular-nums">{children}</p>

// ─── The page ────────────────────────────────────────────────────────────────

export function HostDashboard({ initial, timeZone }: { initial: HostStatusView | null; timeZone?: string }) {
  const kit = useKit()
  const now = useNow(1_000)
  const [status, setStatus] = useState(initial)
  useEffect(() => {
    let stop = false
    const poll = async () => {
      if (document.visibilityState !== "visible") return
      const res = await fetch("/api/host/status", { cache: "no-store" }).catch(() => null)
      if (stop || !res?.ok) return
      setStatus((await res.json()) as HostStatusView | null)
    }
    const t = setInterval(() => void poll(), 2_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])

  const fresh = hostFresh(status, now)
  const live = fresh ? status : null
  const slots = gpuSlots([...(status?.gpus ?? [])].sort((a, b) => a.index - b.index))
  return (
    <div className="space-y-8">
      <AgentLine status={status} fresh={fresh} now={now} time={kit.format.time} />
      {live && live.errors.length > 0 && (
        <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="status">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden />
          <p>
            <span className="font-medium">Some sensors are unavailable.</span> <span className="text-muted-foreground">{live.errors.join(" · ")}</span>
          </p>
        </div>
      )}
      <Summary status={live} />
      <HostCharts status={status} slots={slots} timeZone={timeZone} dateTime={(ms) => kit.format.dateTime(new Date(ms))} />
      <Hardware status={live} />
      <Fans status={status} live={!!live} />
      <Storage status={live} />
      <Energy status={live} />
      {status && <HostSettings status={status} />}
    </div>
  )
}

function AgentLine({ status, fresh, now, time }: { status: HostStatusView | null; fresh: boolean; now: number; time(v: string): string }) {
  if (!status) return <Empty>The host agent has never reported. It runs on the server at sign-in (docs/SERVER.md §11); check its scheduled task and its log.</Empty>
  const age = Math.round((now - new Date(status.at).getTime()) / 1000)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <span className={cn("size-2 rounded-full", fresh ? "bg-gain" : "bg-loss")} aria-hidden />
        {fresh ? "Live" : "Offline"}
      </span>
      {fresh ? (
        <span className="text-muted-foreground">
          {status.system.hostname} · {status.system.platform} · up {uptime(status.system.uptime_s)} · read every {status.settings.interval_ms / 1000} s, last at {time(status.at)}
        </span>
      ) : (
        <span className="text-loss">
          No reading for {age < 120 ? `${age} s` : `${Math.round(age / 60)} min`} (last at {time(status.at)}): the host agent is stopped or can&apos;t reach the database. Current readings are hidden; the history
          below stays.
        </span>
      )}
    </div>
  )
}

function Summary({ status: s }: { status: HostStatusView | null }) {
  const gpus = [...(s?.gpus ?? [])].sort((a, b) => a.index - b.index)
  return (
    <section aria-label="At a glance" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <SummaryCard icon={CpuIcon} label="Processor" value={pct(s?.cpu.utilization)}>
        <Meter value={s?.cpu.utilization ?? null} />
        <Muted>
          {celsius(s?.cpu.temperature_c)} · {s?.cpu.clock_mhz ? `${num(s.cpu.clock_mhz / 1000, 2)} GHz` : "—"} · {watts(s?.cpu.power_w)}
        </Muted>
        <Muted>{s?.cpu.model ?? "—"}</Muted>
      </SummaryCard>
      <SummaryCard icon={GpuIcon} label={gpus.length > 1 ? "Graphics cards" : "Graphics"} value={gpus.length ? gpus.map((g) => pct(g.utilization)).join(" · ") : "—"}>
        {gpus.length ? (
          gpus.map((g) => (
            <div key={g.id} className="space-y-1">
              <Meter value={g.utilization} />
              <Muted>
                {shortModel(g.model)}: {celsius(g.temperature_c)} · {bytes(g.memory_used_bytes)} / {bytes(g.memory_total_bytes)}
              </Muted>
            </div>
          ))
        ) : (
          <Muted>No NVIDIA card reported.</Muted>
        )}
      </SummaryCard>
      <SummaryCard icon={MemoryStickIcon} label="Memory" value={pct(s?.memory.utilization)}>
        <Meter value={s?.memory.utilization ?? null} />
        <Muted>
          {bytes(s?.memory.used_bytes)} used of {bytes(s?.memory.total_bytes)}
        </Muted>
      </SummaryCard>
      <SummaryCard icon={PlugZapIcon} label="Outlet power" value={watts(s?.power.watts, 1)}>
        <Muted>{s?.power.outlet ? `${s.power.outlet.name} (${s.power.outlet.model})` : (s?.power.error ?? "No outlet")}</Muted>
        {s?.energy && (
          <Muted>
            Today {kwh(s.energy.today_kwh)} · {money(s.energy.today_kwh === null ? null : s.energy.today_kwh * s.settings.price_per_kwh, s.settings.currency)}
          </Muted>
        )}
      </SummaryCard>
    </section>
  )
}

// ─── History ─────────────────────────────────────────────────────────────────

const RANGE_KEYS = Object.keys(HOST_RANGES) as HostRange[]

function ChartCard({ title, value, className, children }: { title: string; value?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Card className={cn("gap-3 py-4", className)}>
      <CardHeader className="flex flex-row items-baseline justify-between gap-2 px-4">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {value !== undefined && <span className="text-muted-foreground font-mono text-xs tabular-nums">{value}</span>}
      </CardHeader>
      <CardContent className="px-4">{children}</CardContent>
    </Card>
  )
}

function HostCharts({ status, slots, timeZone, dateTime }: { status: HostStatusView | null; slots: Map<string, 2 | 3>; timeZone?: string; dateTime(ms: number): string }) {
  const [range, setRange] = useState<HostRange>("1h")
  const [history, setHistory] = useState<HostHistoryView | null>(null)
  useEffect(() => {
    let stop = false
    const load = async () => {
      const res = await fetch(`/api/host/history?range=${range}`, { cache: "no-store" }).catch(() => null)
      if (stop || !res?.ok) return
      setHistory((await res.json()) as HostHistoryView)
    }
    void load()
    const t = setInterval(() => void load(), HOST_RANGES[range].res === "raw" ? 10_000 : 60_000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [range])

  const shown = history?.range === range ? history : null
  const points = shown?.points ?? []
  const times = points.map((p) => p.t)
  // Cards in their bus order (by the live reading), else by model; at most two, so three lines with the CPU.
  const cards = (shown?.gpus ?? [])
    .filter((g) => slots.has(g.id) || slots.size === 0)
    .sort((a, b) => (slots.get(a.id) ?? 9) - (slots.get(b.id) ?? 9) || a.model.localeCompare(b.model))
    .slice(0, 2)
  const slotOf = (id: string, i: number) => slots.get(id) ?? ((i + 2) as 2 | 3)
  const r = HOST_RANGES[range]
  const gapMs = Math.max(3 * r.bin_s * 1000, 3 * (status?.settings.interval_ms ?? 2_000), 15_000)
  const empty = shown ? "No readings in this range yet." : "Loading…"
  const common = { times, dateTime, timeZone, gapMs, empty, height: 170 }
  const percent = (v: number) => `${num(v, 0)}%`
  const cardLines = (field: "util" | "temp") => cards.map((g, i): LineSpec => ({ key: g.id, label: shortModel(g.model), slot: slotOf(g.id, i), values: points.map((p) => p.gpus[g.id]?.[field] ?? null) }))
  const last = points.at(-1)
  return (
    <section className="space-y-3">
      {/* Title and ranges wrap onto two rows on a phone. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">History</h2>
        <ChartTabsList tabs={{ value: range, options: RANGE_KEYS.map((k) => ({ key: k, label: HOST_RANGES[k].label })), onChange: (v) => setRange(v as HostRange) }} />
      </div>
      <p className="text-muted-foreground text-xs">
        {r.bin_s ? `Averages over ${r.bin_s >= 3_600 ? `${r.bin_s / 3_600} h` : r.bin_s >= 60 ? `${r.bin_s / 60} min` : `${r.bin_s} s`}. ` : "Every reading. "}
        Kept 30 days (the last hour reading by reading); offline time shows as a gap.
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard title="CPU utilization" value={last ? pct(last.cpu) : undefined}>
          <LinesChart {...common} label="CPU utilization" lines={[{ key: "cpu", label: "CPU", slot: 1, values: points.map((p) => p.cpu) }]} format={percent} range={{ min: 0, max: 100 }} />
        </ChartCard>
        <ChartCard title="GPU utilization">
          <LinesChart {...common} label="GPU utilization per card" lines={cardLines("util")} format={percent} range={{ min: 0, max: 100 }} />
        </ChartCard>
        <ChartCard title="Temperatures">
          <LinesChart
            {...common}
            label="CPU package and GPU temperatures"
            lines={[{ key: "cpu", label: "CPU", slot: 1, values: points.map((p) => p.cpu_temp) }, ...cardLines("temp")]}
            format={(v) => `${num(v, 0)} °C`}
          />
        </ChartCard>
        <ChartCard title="Memory" value={last ? pct(last.memory) : undefined}>
          <LinesChart {...common} label="Memory in use" lines={[{ key: "memory", label: "Memory", slot: 1, values: points.map((p) => p.memory) }]} format={percent} range={{ min: 0, max: 100 }} />
        </ChartCard>
        <ChartCard title="Outlet power" value={last ? watts(last.watts) : undefined} className="lg:col-span-2">
          <LinesChart {...common} label="The server's power draw at the outlet" lines={[{ key: "watts", label: "Power", slot: 1, values: points.map((p) => p.watts) }]} format={(v) => `${num(v, 0)} W`} />
        </ChartCard>
      </div>
    </section>
  )
}

// ─── Hardware ────────────────────────────────────────────────────────────────

function GpuCard({ gpu: g, title }: { gpu: HostGpu; title: string }) {
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <GpuIcon className="size-4" aria-hidden /> {title}
        </CardTitle>
        <CardDescription>{g.model}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <KV label="Utilization">{pct(g.utilization)}</KV>
        <KV label="Temperature">{celsius(g.temperature_c)}</KV>
        <KV label="Video memory">
          {bytes(g.memory_used_bytes)} / {bytes(g.memory_total_bytes)}
        </KV>
        <KV label="Power">
          {watts(g.power_w, 1)}
          {g.power_limit_w ? ` of ${watts(g.power_limit_w)}` : ""}
        </KV>
        <KV label="Fan">{pct(g.fan_pct)}</KV>
        <KV label="Driver">{g.driver ?? "—"}</KV>
      </CardContent>
    </Card>
  )
}

function Hardware({ status: s }: { status: HostStatusView | null }) {
  const kit = useKit()
  if (!s) return null
  const gpus = [...s.gpus].sort((a, b) => a.index - b.index)
  return (
    <section>
      <SectionTitle>Hardware</SectionTitle>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <CpuIcon className="size-4" aria-hidden /> Processor
            </CardTitle>
            <CardDescription>{s.cpu.model ?? "—"}</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <KV label="Utilization">{pct(s.cpu.utilization)}</KV>
            <KV label="Package temperature">{celsius(s.cpu.temperature_c)}</KV>
            <KV label="Clock (core average)">{s.cpu.clock_mhz ? `${num(s.cpu.clock_mhz, 0)} MHz` : "—"}</KV>
            <KV label="Package power">{watts(s.cpu.power_w, 1)}</KV>
            <KV label="CPU fan">{s.cpu.fan_rpm === null ? "—" : `${num(s.cpu.fan_rpm, 0)} RPM`}</KV>
            <KV label="Cores / threads">
              {s.cpu.physical_cores ?? "—"} / {s.cpu.cores ?? "—"}
            </KV>
          </CardContent>
        </Card>
        {gpus.map((g, i) => (
          <GpuCard key={g.id} gpu={g} title={gpus.length > 1 ? `Graphics ${i + 1}` : "Graphics"} />
        ))}
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-base">System</CardTitle>
            <CardDescription>{s.system.platform}</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            <KV label="Name">{s.system.hostname}</KV>
            <KV label="Uptime">{uptime(s.system.uptime_s)}</KV>
            <KV label="Free memory">{bytes(s.memory.available_bytes)}</KV>
            <KV label="Last reading">{kit.format.time(s.at)}</KV>
            <KV label="Host agent">
              {s.agent.version}, since {kit.format.dateTime(s.agent.started_at)}
            </KV>
          </CardContent>
        </Card>
      </div>
      {s.cpu.per_core.length > 0 && (
        <Card className="mt-3 gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm font-medium">Each logical processor</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 px-4 sm:grid-cols-3 lg:grid-cols-6">
            {s.cpu.per_core.map((v, i) => (
              <div key={i} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">#{i + 1}</span>
                  <span className="font-mono tabular-nums">{pct(v)}</span>
                </div>
                <Meter value={v} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  )
}

// ─── Fans ────────────────────────────────────────────────────────────────────

const FAN_MODE_TEXT: Record<FanMode, { label: string; help: string }> = {
  curve: { label: "Automatic cooling (recommended)", help: "Follows the CPU package temperature, the same for every fan." },
  manual: { label: "Manual speed", help: "One fixed speed for every fan, until you change it." },
  bios: { label: "BIOS control", help: "The motherboard runs the fans on its own BIOS settings." },
}

function Fans({ status, live }: { status: HostStatusView | null; live: boolean }) {
  const command = useCommand<HostCommand>(COMMANDS)
  const fans = live ? status?.fans : null
  return (
    <section>
      <SectionTitle>Fans</SectionTitle>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="gap-3 py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-2 text-base">
              <FanIcon className="size-4" aria-hidden /> Motherboard fans
            </CardTitle>
            <CardDescription>CPU and case fans on the board&apos;s headers (the GPUs run their own).</CardDescription>
          </CardHeader>
          <CardContent className="px-4">
            {!fans ? (
              <p className="text-muted-foreground text-sm">No current reading.</p>
            ) : fans.fans.length === 0 ? (
              <p className="text-muted-foreground text-sm">No connected fans reported.</p>
            ) : (
              fans.fans.map((f) => (
                <KV key={f.id} label={f.name}>
                  {f.rpm === null ? "—" : `${num(f.rpm, 0)} RPM`}
                </KV>
              ))
            )}
            {fans && (
              <p className="text-muted-foreground mt-3 text-xs">
                {fans.control === "off"
                  ? "The agent only reads the fans; another app or the BIOS sets them."
                  : `${FAN_MODE_TEXT[fans.mode ?? "bios"].label.replace(" (recommended)", "")}${fans.target_pct !== null ? `: every fan at ${fans.target_pct}%` : ""}. CPU ${celsius(fans.temperature_c)}.`}
              </p>
            )}
            {fans?.error && <p className="text-loss mt-2 text-xs">{fans.error}</p>}
          </CardContent>
        </Card>
        {status && <FanControl key={`${status.fans.mode}:${status.fans.manual_pct}`} fans={status.fans} live={live} command={command} />}
      </div>
    </section>
  )
}

function FanControl({ fans, live, command }: { fans: HostFans; live: boolean; command: Command }) {
  const { busy, result, error, send } = command
  const [mode, setMode] = useState<FanMode>(fans.mode ?? "curve")
  const [speed, setSpeed] = useState(fans.manual_pct ?? 100)
  const off = fans.control === "off"
  const changed = !off && (mode !== fans.mode || (mode === "manual" && speed !== fans.manual_pct))
  return (
    <Card className="gap-3 py-4 lg:col-span-2">
      <CardHeader className="px-4">
        <CardTitle className="text-base">Cooling</CardTitle>
        <CardDescription>
          One setting for every connected CPU and case fan, kept across restarts. In any mode but BIOS, every fan runs at 100% at {FAN_PROTECT_C} °C, without a CPU temperature, or when
          one stops reporting RPM. If the agent stops, a watchdog hands the fans back to the BIOS within 8 seconds; before Windows sign-in the BIOS runs them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        {off && <p className="text-muted-foreground text-sm">Fan control is off on the server (FAN_CONTROL=off in .env.host): the agent only reads the fans.</p>}
        <fieldset disabled={off || !live || busy} className="space-y-4 disabled:opacity-60">
          <div className="space-y-1.5">
            <Label htmlFor="fan-mode">Mode</Label>
            <select id="fan-mode" className="bg-background h-8 w-full max-w-72 min-w-0 rounded-md border px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value as FanMode)}>
              {(["curve", "manual", "bios"] as const).map((m) => (
                <option key={m} value={m}>
                  {FAN_MODE_TEXT[m].label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              {FAN_MODE_TEXT[mode].help}
              {mode === "curve" && ` ${FAN_CURVE.map((p) => `${p.temp_c} °C → ${p.pct}%`).join(", ")}.`}
            </p>
          </div>
          {mode === "manual" && (
            <div className="max-w-md space-y-2">
              <div className="flex justify-between text-sm">
                <Label>Every fan</Label>
                <span className="font-mono tabular-nums">{speed}%</span>
              </div>
              <Slider aria-label="Fan speed" min={FAN_MIN_PCT} max={100} step={1} value={[speed]} onValueChange={([v]) => setSpeed(v)} />
              <div className="text-muted-foreground flex justify-between text-xs">
                <span>Quieter</span>
                <span>More cooling</span>
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" disabled={!changed} onClick={() => void send({ type: "fans.set", mode, manual_pct: speed })}>
              {busy && <LoaderIcon className="animate-spin" aria-hidden />}
              Apply
            </Button>
            {changed && !busy && <span className="text-muted-foreground text-xs">Not applied yet.</span>}
          </div>
        </fieldset>
        <CommandResult result={result} error={error} />
      </CardContent>
    </Card>
  )
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function Storage({ status: s }: { status: HostStatusView | null }) {
  if (!s) return null
  return (
    <section>
      <SectionTitle
        action={
          <span className="text-muted-foreground text-xs tabular-nums">
            Disks: read {rate(s.storage.read_bps)} · write {rate(s.storage.write_bps)}
          </span>
        }
      >
        Storage
      </SectionTitle>
      {s.storage.volumes.length === 0 ? (
        <Empty>No volumes reported.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Volume</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Used</TableHead>
              <TableHead className="text-right">Free</TableHead>
              <TableHead className="w-48">In use</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.storage.volumes.map((v) => (
              <TableRow key={v.mount}>
                <TableCell>
                  <span className="font-medium">{v.mount}</span> <span className="text-muted-foreground text-xs">{v.filesystem ?? ""}</span>
                </TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">{bytes(v.total_bytes)}</TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">{bytes(v.used_bytes)}</TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">{bytes(v.available_bytes)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Meter value={v.utilization} className="flex-1" />
                    <span className="w-12 text-right font-mono text-xs tabular-nums">{pct(v.utilization, 1)}</span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

// ─── Energy ──────────────────────────────────────────────────────────────────

function Energy({ status: s }: { status: HostStatusView | null }) {
  if (!s) return null
  const e = s.energy
  const cost = (k: number | null) => money(k === null ? null : k * s.settings.price_per_kwh, s.settings.currency)
  const periods: [string, EnergyPeriod | null][] = [
    ["Last 24 hours", e?.last_24h ?? null],
    ["Last 7 days", e?.last_7d ?? null],
    ["Last 30 days", e?.last_30d ?? null],
  ]
  return (
    <section>
      <SectionTitle>Energy and cost</SectionTitle>
      {!e ? (
        <Empty>{s.power.error ?? "Waiting for the outlet's readings."}</Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={PlugZapIcon} label="Today" value={kwh(e.today_kwh)}>
              <p className="tabular-nums">{cost(e.today_kwh)}</p>
              <Muted>Since local midnight.</Muted>
            </SummaryCard>
            {periods.map(([label, p]) => (
              <SummaryCard key={label} icon={PlugZapIcon} label={label} value={kwh(p?.kwh)}>
                <p className="tabular-nums">{cost(p?.kwh ?? null)}</p>
                <Muted>{p ? `${hours(p.recorded_ms)} of ${hours(p.window_ms)} h recorded.` : "—"}</Muted>
              </SummaryCard>
            ))}
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Measured use only: unrecorded time is left out, never estimated. Costs use the current price ({money(s.settings.price_per_kwh, s.settings.currency)}/kWh). Updated every minute.
          </p>
        </>
      )}
    </section>
  )
}

// ─── Settings ────────────────────────────────────────────────────────────────

function HostSettings({ status }: { status: HostStatusView }) {
  const saving = useCommand<HostCommand>(COMMANDS)
  const finding = useCommand<HostCommand>(COMMANDS)
  return <HostSettingsForm key={JSON.stringify(status.settings)} status={status} saving={saving} finding={finding} />
}

function HostSettingsForm({ status, saving, finding }: { status: HostStatusView; saving: Command; finding: Command }) {
  const s = status.settings
  const [interval, setIntervalMs] = useState(s.interval_ms)
  const [price, setPrice] = useState(String(s.price_per_kwh))
  const [currency, setCurrency] = useState(s.currency)
  const [outlet, setOutlet] = useState(s.outlet_id ?? "")
  const devices = status.power.devices
  const priceValue = Number(price)
  const valid = price.trim() !== "" && Number.isFinite(priceValue) && priceValue >= 0 && priceValue <= 1000
  // min-w-0: a select is otherwise as wide as its longest option, wider than a phone.
  const select = "bg-background h-8 w-full max-w-64 min-w-0 rounded-md border px-2 text-sm"
  return (
    <section>
      <SectionTitle>Settings</SectionTitle>
      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="host-interval">Read the sensors every</Label>
              <select id="host-interval" className={select} value={interval} onChange={(e) => setIntervalMs(Number(e.target.value))}>
                {HOST_INTERVALS_MS.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000} seconds
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-price">Electricity price per kWh</Label>
              <Input id="host-price" className="h-8 max-w-40" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={!valid} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-currency">Currency</Label>
              <select id="host-currency" className={select} value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)}>
                {HOST_CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="host-outlet">VeSync outlet</Label>
              <div className="flex gap-2">
                <select id="host-outlet" className={select} value={outlet} onChange={(e) => setOutlet(e.target.value)}>
                  <option value="">{devices.length === 1 ? "The only outlet" : "None selected"}</option>
                  {devices.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.model})
                    </option>
                  ))}
                  {s.outlet_id && !devices.some((d) => d.id === s.outlet_id) && <option value={s.outlet_id}>The saved outlet (not found yet)</option>}
                </select>
                <Button size="sm" variant="outline" disabled={finding.busy || !status.power.configured} onClick={() => void finding.send({ type: "outlets.discover" })}>
                  {finding.busy && <LoaderIcon className="animate-spin" aria-hidden />}
                  Discover
                </Button>
              </div>
              <Muted>{status.power.configured ? "The VeSync login stays on the server (.env.host)." : "Set VESYNC_USERNAME and VESYNC_PASSWORD in .env.host on the server."}</Muted>
              <CommandResult result={finding.result} error={finding.error} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button
              size="sm"
              disabled={!valid || saving.busy}
              onClick={() => void saving.send({ type: "settings.update", settings: { interval_ms: interval, price_per_kwh: priceValue, currency, outlet_id: outlet || null } })}
            >
              {saving.busy && <LoaderIcon className="animate-spin" aria-hidden />}
              Save settings
            </Button>
            <CommandResult result={saving.result} error={saving.error} />
          </div>
        </CardContent>
      </Card>
    </section>
  )
}
