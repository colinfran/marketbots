import { z } from "zod"
import type { CommandDoc } from "./db"

/**
 * The trading server's own hardware (docs/SERVER.md §11). The host agent (apps/host-agent), a Node
 * process on the Windows server, reads it every couple of seconds and keeps it on the server: the
 * latest reading in memory, samples for the charts and the owner's commands in a local SQLite file.
 * It serves them over a small API behind Caddy, which the dashboards' servers call with a shared
 * secret only while Admin → Server is open: nothing about the machine goes to the bots' database.
 * The page is the same in both dashboards: it is one machine, so one copy.
 */

/** After this long without a reading, the dashboards show the agent as offline instead of its last numbers. */
export const HOST_STALE_MS = 15_000

/** Raw samples (one per reading) serve the hour views and are kept a little over an hour; minute samples, 30 days. */
export const HOST_RAW_KEEP_MS = 65 * 60_000
export const HOST_MINUTE_KEEP_MS = 30 * 86_400_000

// ─── Settings ────────────────────────────────────────────────────────────────

/** How often the agent may read the sensors. */
export const HOST_INTERVALS_MS = [2_000, 5_000, 10_000, 30_000, 60_000] as const

export const HOST_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "JPY"] as const

/** The agent's own settings (Admin → Server → Settings). Kept by the agent; the dashboards send changes as commands. */
export const hostSettingsSchema = z.object({
  interval_ms: z
    .number()
    .int()
    .refine((v) => (HOST_INTERVALS_MS as readonly number[]).includes(v), "not an offered interval"),
  /** Electricity price per kWh in `currency`. Costs always use the current price. */
  price_per_kwh: z.number().min(0).max(1000),
  currency: z.enum(HOST_CURRENCIES),
  /** The VeSync outlet whose readings count (its `cid`); null: the only supported outlet, if there is exactly one. */
  outlet_id: z.string().min(1).max(256).nullable(),
})

export type HostSettings = z.infer<typeof hostSettingsSchema>

export const DEFAULT_HOST_SETTINGS: HostSettings = { interval_ms: 2_000, price_per_kwh: 0.15, currency: "USD", outlet_id: null }

// ─── Fans ────────────────────────────────────────────────────────────────────

/**
 * One setting for every motherboard CPU/case fan the agent finds (never GPU fans or pumps):
 * - curve: follows the CPU package temperature along FAN_CURVE;
 * - manual: one fixed speed, FAN_MIN_PCT–100%;
 * - bios: the motherboard's own control.
 */
export const FAN_MODES = ["curve", "manual", "bios"] as const
export type FanMode = (typeof FAN_MODES)[number]

export const FAN_MIN_PCT = 40

/** Automatic cooling: CPU package °C → fan %, interpolated between points. */
export const FAN_CURVE = [
  { temp_c: 30, pct: 40 },
  { temp_c: 45, pct: 50 },
  { temp_c: 60, pct: 65 },
  { temp_c: 75, pct: 85 },
  { temp_c: 85, pct: 100 },
] as const

/** At this CPU temperature, or with no temperature or a controlled fan reporting no RPM, every controlled fan runs at 100%, in any mode. */
export const FAN_PROTECT_C = 85

export const fanSettingsSchema = z.object({ mode: z.enum(FAN_MODES), manual_pct: z.number().int().min(FAN_MIN_PCT).max(100) })

export type FanSettings = z.infer<typeof fanSettingsSchema>

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * Dashboard → host agent. Like the engines' commands: validated, sent by the dashboard's server to
 * the agent's API (with an audit entry in the sending bot's audit log), validated again, run at once
 * one after another, and kept with their outcome for the page to poll. Either dashboard can send them.
 */
export const hostCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fans.set"), ...fanSettingsSchema.shape }),
  z.object({ type: z.literal("settings.update"), settings: hostSettingsSchema }),
  z.object({ type: z.literal("outlets.discover") }),
])

export type HostCommand = z.infer<typeof hostCommandSchema>

export type HostCommandDoc = CommandDoc<HostCommand>

/** What the page polls of a command it sent. */
export type HostCommandView = Pick<HostCommandDoc, "_id" | "type" | "status" | "result" | "error">

// ─── Readings ────────────────────────────────────────────────────────────────

export type HostGpu = {
  /** The card's UUID. */
  id: string
  index: number
  model: string
  driver: string | null
  utilization: number | null
  memory_utilization: number | null
  memory_used_bytes: number | null
  memory_total_bytes: number | null
  temperature_c: number | null
  power_w: number | null
  power_limit_w: number | null
  fan_pct: number | null
}

export type HostVolume = { mount: string; filesystem: string | null; total_bytes: number | null; used_bytes: number | null; available_bytes: number | null; utilization: number | null }

export type HostFan = { id: string; name: string; rpm: number | null }

export type HostFans = {
  /** "agent": the agent sets the fans; "off": it only reads them (another app or the BIOS controls them). */
  control: "agent" | "off"
  mode: FanMode | null
  manual_pct: number | null
  /** The speed every controlled fan was last set to. */
  target_pct: number | null
  /** CPU package temperature the curve follows. */
  temperature_c: number | null
  fans: HostFan[]
  /** A failure, or a protection warning (everything at 100%). */
  error: string | null
}

export type HostOutlet = { id: string; name: string; model: string }

export type EnergyPeriod = { kwh: number | null; recorded_ms: number; window_ms: number }

/** Dates are `D`: Date in the agent, ISO strings once its API sends them. */
export type HostStatus<D = Date> = {
  _id: "current"
  at: D
  agent: { version: string; started_at: D }
  system: { hostname: string; platform: string; uptime_s: number | null }
  cpu: {
    model: string | null
    cores: number | null
    physical_cores: number | null
    utilization: number | null
    per_core: (number | null)[]
    temperature_c: number | null
    /** The cores' average clock. */
    clock_mhz: number | null
    /** Package power. */
    power_w: number | null
    fan_rpm: number | null
  }
  gpus: HostGpu[]
  memory: { total_bytes: number | null; used_bytes: number | null; available_bytes: number | null; utilization: number | null }
  /** Volumes, and every drive's read and write rate added up (bytes per second). */
  storage: { volumes: HostVolume[]; read_bps: number | null; write_bps: number | null }
  fans: HostFans
  power: {
    configured: boolean
    outlet: HostOutlet | null
    watts: number | null
    /** The outlet's own counter since local midnight, when it has one. */
    energy_today_kwh: number | null
    updated_at: D | null
    /** The supported outlets on the account, from the last discovery. */
    devices: HostOutlet[]
    error: string | null
  }
  /** Measured use from the minute samples (refreshed every minute); null until the outlet reports. */
  energy: { as_of: D; today_kwh: number | null; last_24h: EnergyPeriod; last_7d: EnergyPeriod; last_30d: EnergyPeriod } | null
  settings: HostSettings
  /** Sensors that failed this reading. */
  errors: string[]
}

export type HostStatusDoc = HostStatus<Date>
export type HostStatusView = HostStatus<string>

export type HostSampleGpu = { id: string; model: string; util: number | null; temp: number | null }

/**
 * One chart sample: a single reading (`raw`) or a minute's averages (`1m`). The `_id` is
 * `<res>:<epoch ms>`, so writing a bucket twice (a restart in the same minute, an import) replaces it.
 */
export type HostSampleDoc = {
  _id: string
  res: "raw" | "1m"
  t: Date
  cpu: number | null
  cpu_temp: number | null
  memory: number | null
  watts: number | null
  gpus: HostSampleGpu[]
  /** Minute samples: the energy measured in the minute, and how much of it the readings covered. */
  wh: number | null
  covered_ms: number
  outlet_id: string | null
}

export const sampleId = (res: HostSampleDoc["res"], t: number) => `${res}:${t}`

// ─── Chart ranges ────────────────────────────────────────────────────────────

/** The chart ranges: how far back, from which samples, averaged into bins of `bin_s` seconds (0: as recorded). */
export const HOST_RANGES = {
  "1m": { label: "1 min", ms: 60_000, res: "raw", bin_s: 0 },
  "5m": { label: "5 min", ms: 5 * 60_000, res: "raw", bin_s: 0 },
  "1h": { label: "1 h", ms: 3_600_000, res: "raw", bin_s: 10 },
  "24h": { label: "24 h", ms: 86_400_000, res: "1m", bin_s: 120 },
  "7d": { label: "7 d", ms: 7 * 86_400_000, res: "1m", bin_s: 600 },
  "30d": { label: "30 d", ms: 30 * 86_400_000, res: "1m", bin_s: 3_600 },
} as const satisfies Record<string, { label: string; ms: number; res: HostSampleDoc["res"]; bin_s: number }>

export type HostRange = keyof typeof HOST_RANGES

export const isHostRange = (v: unknown): v is HostRange => typeof v === "string" && Object.hasOwn(HOST_RANGES, v)

export type HostChartPoint = { t: number; cpu: number | null; cpu_temp: number | null; memory: number | null; watts: number | null; gpus: Record<string, { util: number | null; temp: number | null }> }

export type HostHistoryView = { range: HostRange; points: HostChartPoint[]; gpus: { id: string; model: string }[] }

/** Whether a reading is recent enough to show. */
export const hostFresh = (status: { at: Date | string } | null, now = Date.now()) => !!status && now - new Date(status.at).getTime() < HOST_STALE_MS
