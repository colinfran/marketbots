import type { Server } from "node:http"
import { join } from "node:path"
import type { HostStatusDoc } from "@mb/core/host"
import { startApi } from "./api"
import { Collector } from "./collector"
import { HostCommands } from "./commands"
import { loadEnv } from "./env"
import { FanController, startWatchdog } from "./fans"
import { Lhm } from "./lhm"
import { errorMessage, log, logToFile } from "./log"
import { MinuteSamples, rawSample, type SampleInput } from "./samples"
import { SettingsFile } from "./settings"
import { HostStore } from "./store"
import { PowerMonitor } from "./vesync"

/**
 * The host agent (docs/SERVER.md §11): reads the Windows server's hardware every `interval_ms`,
 * keeps it on the server (store.ts) and serves it to Admin → Server through its API (api.ts), runs
 * the motherboard fans, and answers the owner's commands. Started at sign-in by its scheduled task;
 * the fan watchdog it starts hands the fans back to the BIOS if it dies.
 */

/** The commit it was built from (build.mjs). */
const VERSION = process.env.HOST_AGENT_VERSION ?? "dev"

const ENERGY_REFRESH_MS = 60_000

const localMidnight = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

async function main() {
  const env = loadEnv()
  const logDir = join(env.HOST_DATA_DIR, "logs")
  logToFile(logDir)
  const settings = new SettingsFile(join(env.HOST_DATA_DIR, "settings.json"))
  await settings.load()
  const store = new HostStore(join(env.HOST_DATA_DIR, "host.sqlite"))

  // Everything shutdown() uses, declared before the watchdog that may call it.
  const minutes = new MinuteSamples()
  let stopping = false
  let readTimer: NodeJS.Timeout | null = null
  let api: Server | null = null

  const board = new Lhm(env.LHM_CONNECTION_FILE)
  const control = env.FAN_CONTROL === "on"
  // The bundle's sibling: fan control runs from the built agent (dist/), not from tsx. Without its
  // watchdog the agent can't set the fans, so it exits with an error and its task restarts it.
  const watchdog = control
    ? startWatchdog(new URL("./fan-watchdog.js", import.meta.url), env.LHM_CONNECTION_FILE, logDir, log, {
        error: (m) => fans.fault(m),
        exit: () => void shutdown("watchdog stopped", 1),
      })
    : null
  const fans = new FanController({ board, file: join(env.HOST_DATA_DIR, "fan-settings.json"), control, guard: watchdog?.guard, log })
  await fans.start()

  const power = new PowerMonitor(
    { username: env.VESYNC_USERNAME, password: env.VESYNC_PASSWORD, timeZone: env.VESYNC_TIMEZONE, countryCode: env.VESYNC_COUNTRY_CODE, refreshMs: env.VESYNC_REFRESH_MS },
    () => settings.value.outlet_id,
  )
  const collector = new Collector(board)
  const startedAt = new Date()
  let energy: HostStatusDoc["energy"] = null
  let energyAt = 0
  let refreshPower = false

  const read = async () => {
    const [reading, outlet] = await Promise.all([collector.read(), power.read(refreshPower)])
    refreshPower = false
    const t = Date.now()
    const errors = [...reading.errors]
    const outletId = outlet.outlet?.id ?? null
    const input: SampleInput = {
      t,
      cpu: reading.cpu.utilization,
      cpu_temp: reading.cpu.temperature_c,
      memory: reading.memory.utilization,
      watts: outlet.watts,
      outlet_id: outletId,
      gpus: reading.gpus.map((g) => ({ id: g.id, model: g.model, util: g.utilization, temp: g.temperature_c })),
    }
    const samples = [rawSample(input), ...minutes.add(input)]
    // The recorded use of the outlet in use, else of the saved one (its history stays while VeSync is down).
    const energyOutlet = outletId ?? settings.value.outlet_id
    if (!energyOutlet) energy = null
    else if (t - energyAt >= ENERGY_REFRESH_MS) {
      energyAt = t
      try {
        const totals = store.energy(energyOutlet, t, localMidnight(t))
        energy = { as_of: new Date(t), today_kwh: outlet.energy_today_kwh ?? totals.today_recorded_kwh, last_24h: totals.last_24h, last_7d: totals.last_7d, last_30d: totals.last_30d }
      } catch (e) {
        errors.push(`Recorded energy: ${errorMessage(e)}`)
      }
    }
    // Not configured is a setup state, shown on the power card; a failure is a sensor error.
    if (outlet.configured && outlet.error) errors.push(`VeSync: ${outlet.error}`)
    const status: HostStatusDoc = {
      _id: "current",
      at: new Date(t),
      agent: { version: VERSION, started_at: startedAt },
      system: reading.system,
      cpu: reading.cpu,
      gpus: reading.gpus,
      memory: reading.memory,
      storage: reading.storage,
      fans: fans.snapshot(),
      power: { configured: outlet.configured, outlet: outlet.outlet, watts: outlet.watts, energy_today_kwh: outlet.energy_today_kwh, updated_at: outlet.updated_at, devices: outlet.devices, error: outlet.error },
      energy,
      settings: settings.value,
      errors,
    }
    store.write(status, samples)
  }

  const loop = async () => {
    const started = Date.now()
    await read().catch((e) => log.warn("reading failed", { error: errorMessage(e) }))
    if (!stopping) readTimer = setTimeout(() => void loop(), Math.max(0, started + settings.value.interval_ms - Date.now()))
  }

  const commands = new HostCommands(
    store,
    {
      fans,
      settings,
      power,
      onSettings: () => {
        refreshPower = true
        energyAt = 0
      },
    },
    log,
  )
  // Without its API the agent still reads and runs the fans; only Admin → Server can't reach it.
  if (env.HOST_API_SECRET) {
    api = await startApi({ secret: env.HOST_API_SECRET, store, commands, log }, env.HOST_API_PORT).catch((e) => {
      log.error("API not started", { port: env.HOST_API_PORT, error: errorMessage(e) })
      return null
    })
  } else log.warn("API off: HOST_API_SECRET is empty, so Admin → Server can't reach the agent")

  async function shutdown(signal: string, code = 0) {
    if (stopping) return
    stopping = true
    log.info("stopping", { signal, code })
    if (readTimer) clearTimeout(readTimer)
    api?.close()
    try {
      store.writeSamples(minutes.flush())
    } catch (e) {
      log.warn("last minute not written", { error: errorMessage(e) })
    }
    await fans.stop().catch((e) => log.error("fan release failed; the watchdog retries", { error: errorMessage(e) }))
    watchdog?.close()
    store.close()
    process.exit(code)
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.once(signal, () => void shutdown(signal))

  log.info("host agent started", { version: VERSION, api_port: api ? env.HOST_API_PORT : null, fan_control: env.FAN_CONTROL, interval_ms: settings.value.interval_ms })
  void loop()
}

main().catch((e) => {
  log.error("host agent failed to start", { error: errorMessage(e) })
  process.exit(1)
})
