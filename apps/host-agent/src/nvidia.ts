import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { HostGpu } from "@mb/core/host"

/** Every NVIDIA card, from the driver's own `nvidia-smi` (run without a shell). Fields a card doesn't support stay null. */

const FIELDS = ["index", "uuid", "name", "driver_version", "utilization.gpu", "utilization.memory", "memory.used", "memory.total", "temperature.gpu", "power.draw", "power.limit", "fan.speed"] as const

const number = (v: string | undefined) => {
  if (v === undefined || v === "" || v.startsWith("[") || v === "N/A") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const MIB = 1024 ** 2

/** One card per line of `--format=csv,noheader,nounits`, in FIELDS order. */
export const parseNvidia = (stdout: string): HostGpu[] =>
  stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(",").map((f) => f.trim()))
    .filter((f) => f.length >= FIELDS.length && f[1] && f[2])
    .map((f) => {
      const used = number(f[6])
      const total = number(f[7])
      return {
        id: f[1],
        index: number(f[0]) ?? 0,
        model: f[2],
        driver: f[3] || null,
        utilization: number(f[4]),
        memory_utilization: number(f[5]),
        memory_used_bytes: used === null ? null : used * MIB,
        memory_total_bytes: total === null ? null : total * MIB,
        temperature_c: number(f[8]),
        power_w: number(f[9]),
        power_limit_w: number(f[10]),
        fan_pct: number(f[11]),
      }
    })

type Exec = (file: string, args: string[], options: { timeout: number; windowsHide: boolean; maxBuffer: number }) => Promise<{ stdout: string }>

export const readNvidia = async (exec: Exec = promisify(execFile)): Promise<HostGpu[]> => {
  const { stdout } = await exec("nvidia-smi", [`--query-gpu=${FIELDS.join(",")}`, "--format=csv,noheader,nounits"], { timeout: 2_500, windowsHide: true, maxBuffer: 64 * 1024 })
  return parseNvidia(stdout)
}
