import { join } from "node:path"
import type { HostStatusDoc } from "@mb/core/host"
import { MongoClient } from "mongodb"
import { Collector } from "./collector"
import { drainCommands } from "./commands"
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
 * writes it into its database (`serverstats`) for Admin → Server, runs the motherboard fans, and answers the
 * owner's commands. Started at sign-in by its scheduled task; the fan watchdog it starts hands the
 * fans back to the BIOS if it dies.
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
  logToFile(join(env.HOST_DATA_DIR, "logs"))
  const settings = new SettingsFile(join(env.HOST_DATA_DIR, "settings.json"))
  await settings.load()
  const client = new MongoClient(env.MONGODB_URI, { appName: "marketbots-host-agent", maxPoolSize: 5 })
  const store = new HostStore(client, env.HOST_DATABASES)
  await store.init()

  const board = new Lhm(env.LHM_CONNECTION_FILE)
  const control = env.FAN_CONTROL === "on"
  // The bundle's sibling: fan control runs from the built agent (dist/), not from tsx.
  const watchdog = control ? startWatchdog(new URL("./fan-watchdog.js", import.meta.url), env.LHM_CONNECTION_FILE, log, (m) => fans.fault(m)) : null
  const fans = new FanController({ board, file: join(env.HOST_DATA_DIR, "fan-settings.json"), control, guard: watchdog?.guard, log })
  await fans.start()

  const power = new PowerMonitor(
    { username: env.VESYNC_USERNAME, password: env.VESYNC_PASSWORD, timeZone: env.VESYNC_TIMEZONE, countryCode: env.VESYNC_COUNTRY_CODE, refreshMs: env.VESYNC_REFRESH_MS },
    () => settings.value.outlet_id,
  )
  const collector = new Collector(board)
  const minutes = new MinuteSamples()
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
        const totals = await store.energy(energyOutlet, t, localMidnight(t))
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
    await store.write(status, samples)
  }

  let stopping = false
  let readTimer: NodeJS.Timeout | null = null
  const loop = async () => {
    const started = Date.now()
    await read().catch((e) => log.warn("reading failed", { error: errorMessage(e) }))
    if (!stopping) readTimer = setTimeout(() => void loop(), Math.max(0, started + settings.value.interval_ms - Date.now()))
  }

  let draining = false
  const commandTimer = setInterval(() => {
    if (draining) return
    draining = true
    drainCommands(
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
      .catch((e) => log.warn("command poll failed", { error: errorMessage(e) }))
      .finally(() => (draining = false))
  }, 1_000)

  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log.info("stopping", { signal })
    if (readTimer) clearTimeout(readTimer)
    clearInterval(commandTimer)
    await store.writeSamples(minutes.flush()).catch((e) => log.warn("last minute not written", { error: errorMessage(e) }))
    await fans.stop().catch((e) => log.error("fan release failed; the watchdog retries", { error: errorMessage(e) }))
    watchdog?.close()
    await client.close().catch(() => undefined)
    process.exit(0)
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.once(signal, () => void shutdown(signal))

  log.info("host agent started", { version: VERSION, databases: env.HOST_DATABASES, fan_control: env.FAN_CONTROL, interval_ms: settings.value.interval_ms })
  void loop()
}

main().catch((e) => {
  log.error("host agent failed to start", { error: errorMessage(e) })
  process.exit(1)
})
