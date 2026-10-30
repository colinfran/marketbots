import os from "node:os"
import type { HostStatus } from "@mb/core/host"
import si from "systeminformation"
import { cpuSensors, diskRates, type Board } from "./lhm"
import { errorMessage } from "./log"
import { readNvidia } from "./nvidia"

/** One reading of the machine: what Windows reports, every NVIDIA card, and the motherboard's sensors. */
export type Reading = Pick<HostStatus, "system" | "cpu" | "gpus" | "memory" | "storage"> & { errors: string[] }

const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** "11th Gen Intel(R) Core(TM) i5-11400 @ 2.60GHz" → "11th Gen Intel Core i5-11400". */
export const cpuModel = (raw: string | undefined) =>
  raw
    ?.replace(/\((R|TM)\)/gi, "")
    .replace(/\s*@.*$/, "")
    .replace(/\s+/g, " ")
    .trim() || null

/**
 * Reads the machine. Windows' own queries for identity and volumes are slow (WMI), so the CPU and
 * OS identity are read once an hour and the volumes every 30 seconds; load, memory, the cards and
 * the sensors every reading. A source that fails leaves its fields null and adds to `errors`:
 * nothing is filled in from elsewhere.
 */
export class Collector {
  private readonly cache = new Map<string, { until: number; value?: unknown; error?: unknown }>()

  constructor(private readonly board: Board) {}

  private async cached<T>(key: string, ms: number, read: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key)
    if (hit && Date.now() < hit.until) {
      if ("error" in hit) throw hit.error
      return hit.value as T
    }
    try {
      const value = await read()
      this.cache.set(key, { until: Date.now() + ms, value })
      return value
    } catch (error) {
      this.cache.set(key, { until: Date.now() + ms, error })
      throw error
    }
  }

  async read(): Promise<Reading> {
    const errors: string[] = []
    const fail =
      (name: string) =>
      (e: unknown): null => {
        errors.push(`${name}: ${errorMessage(e)}`)
        return null
      }
    const [cpu, load, volumes, osInfo, gpus, sensors] = await Promise.all([
      this.cached("cpu", 3_600_000, () => si.cpu()).catch(fail("CPU")),
      si.currentLoad().catch(fail("CPU load")),
      this.cached("volumes", 30_000, () => si.fsSize()).catch(fail("Storage")),
      this.cached("os", 3_600_000, () => si.osInfo()).catch(fail("Operating system")),
      readNvidia().catch(fail("NVIDIA")),
      this.board.sensors().catch(fail("Motherboard sensors")),
    ])
    const board = sensors ? cpuSensors(sensors) : null
    const rates = sensors ? diskRates(sensors) : { read_bps: null, write_bps: null }
    const total = os.totalmem()
    const free = os.freemem()
    return {
      system: {
        hostname: os.hostname(),
        platform: osInfo ? [osInfo.distro, osInfo.release].filter(Boolean).join(" ") : `${os.type()} ${os.release()}`,
        uptime_s: os.uptime(),
      },
      cpu: {
        model: cpuModel(os.cpus()[0]?.model),
        cores: os.cpus().length || null,
        physical_cores: finite(cpu?.physicalCores),
        utilization: finite(load?.currentLoad),
        per_core: load?.cpus.map((c) => finite(c.load)) ?? [],
        temperature_c: board?.temperature_c ?? null,
        clock_mhz: board?.clock_mhz ?? null,
        power_w: board?.power_w ?? null,
        fan_rpm: board?.fan_rpm ?? null,
      },
      gpus: gpus ?? [],
      memory: { total_bytes: total, used_bytes: total - free, available_bytes: free, utilization: total ? ((total - free) / total) * 100 : null },
      storage: {
        volumes: (volumes ?? []).map((v) => ({
          mount: v.mount,
          filesystem: v.type || null,
          total_bytes: finite(v.size),
          used_bytes: finite(v.used),
          available_bytes: finite(v.available),
          utilization: finite(v.use),
        })),
        ...rates,
      },
      errors,
    }
  }
}
