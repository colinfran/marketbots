import { readFile } from "node:fs/promises"

/**
 * LibreHardwareMonitor: the sensor utility that reads the motherboard (CPU package temperature, fan
 * RPMs) and sets its fan headers, through its PawnIO driver. It runs elevated on the server and
 * serves its sensor tree on loopback behind a password (scripts/install-sensors.ps1); the connection
 * file holds the port and the login, and never leaves this machine.
 */

/** One sensor of the tree, flattened. */
export type Sensor = { id: string; hardwareId: string; name: string; type: string; value: number | null }

/** A motherboard fan header the agent may set: `/lpc/<chip>/<n>/control/<n>`. */
export const FAN_CONTROL_ID = /^\/lpc\/[^/]+\/\d+\/control\/\d+$/

/** Units LHM writes after a value, as a factor to the base unit (MHz, B/s), or a conversion. */
const UNITS: Record<string, (v: number) => number> = {
  "°F": (v) => ((v - 32) * 5) / 9,
  GHZ: (v) => v * 1000,
  "KB/S": (v) => v * 1024,
  "MB/S": (v) => v * 1024 ** 2,
  "GB/S": (v) => v * 1024 ** 3,
}

/**
 * A reading as a number: a plain number, or LHM's value strings ("45.5 °C", "1510 RPM", "40 %",
 * "63.1 W", "4187.1 MHz", "430099.5 B/s"). °F becomes °C, clocks MHz, rates bytes per second.
 */
export const sensorValue = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value !== "string") return null
  const match = value.trim().match(/^(-?\d+(?:[.,]\d+)?)\s*(°[CF]|RPM|%|W|[MG]Hz|[KMG]?B\/s)?$/i)
  if (!match) return null
  const parsed = Number(match[1].replace(",", "."))
  const convert = match[2] ? UNITS[match[2].toUpperCase()] : undefined
  return convert ? convert(parsed) : parsed
}

type Node = { HardwareId?: unknown; SensorId?: unknown; Text?: unknown; Type?: unknown; RawValue?: unknown; Value?: unknown; Children?: unknown }

/** Every sensor in LHM's `data.json` tree, with the hardware it belongs to. */
export const libreSensors = (tree: unknown): Sensor[] => {
  if (!tree || typeof tree !== "object" || !Array.isArray((tree as Node).Children)) throw new Error("LibreHardwareMonitor returned an invalid sensor tree.")
  const sensors: Sensor[] = []
  const walk = (node: unknown, hardwareId: string) => {
    if (!node || typeof node !== "object") return
    const n = node as Node
    const parent = typeof n.HardwareId === "string" ? n.HardwareId : hardwareId
    if (typeof n.SensorId === "string") {
      sensors.push({ id: n.SensorId, hardwareId: parent, name: typeof n.Text === "string" ? n.Text : "", type: typeof n.Type === "string" ? n.Type : "", value: sensorValue(n.RawValue ?? n.Value) })
    }
    if (Array.isArray(n.Children)) for (const child of n.Children) walk(child, parent)
  }
  walk(tree, "")
  return sensors
}

const isCpu = (s: Sensor) => /^\/(intelcpu|amdcpu|cpu)\//i.test(s.id)

const mean = (values: (number | null)[]) => {
  const v = values.filter((x): x is number => x !== null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/**
 * The CPU's package temperature (−20…150 °C, else null), its cores' average clock (Windows itself
 * only reports the base clock), its package power, and a fan LHM explicitly names as the CPU's.
 */
export const cpuSensors = (sensors: Sensor[]) => {
  const cpu = sensors.filter(isCpu)
  const temp = cpu.find((s) => s.type === "Temperature" && /^CPU Package$/i.test(s.name))?.value
  const fan = sensors.find((s) => s.type === "Fan" && /cpu/i.test(s.name) && s.value !== null)?.value
  return {
    temperature_c: temp !== null && temp !== undefined && temp >= -20 && temp <= 150 ? temp : null,
    clock_mhz: mean(cpu.filter((s) => s.type === "Clock" && /^CPU Core #\d+$/i.test(s.name)).map((s) => s.value)),
    power_w: cpu.find((s) => s.type === "Power" && /^CPU Package$/i.test(s.name))?.value ?? null,
    fan_rpm: fan !== null && fan !== undefined && fan >= 0 ? fan : null,
  }
}

/** Every drive's read and write rate added up (bytes per second); null when LHM reports no drive. */
export const diskRates = (sensors: Sensor[]) => {
  const drives = sensors.filter((s) => s.type === "Throughput" && /^\/(nvme|hdd|ssd|storage)\//i.test(s.id))
  const sum = (name: RegExp) => {
    const v = drives.filter((s) => name.test(s.name) && s.value !== null).map((s) => s.value!)
    return v.length ? v.reduce((a, b) => a + b, 0) : null
  }
  return { read_bps: sum(/^Read Rate$/i), write_bps: sum(/^Write Rate$/i) }
}

/** The motherboard's controllable fan headers, each with its current % and the RPM of the fan on it. */
export const motherboardFans = (sensors: Sensor[]) =>
  sensors
    .filter((s) => s.type === "Control" && FAN_CONTROL_ID.test(s.id))
    .map((s) => ({ id: s.id, name: s.name, pct: s.value, rpm: sensors.find((f) => f.type === "Fan" && f.id === s.id.replace("/control/", "/fan/"))?.value ?? null }))

/** The board as the fan controller sees it: read the tree, set (or release, with null) a header. */
export type Board = { sensors(): Promise<Sensor[]>; setControl(id: string, pct: number | null): Promise<void> }

type Connection = { port: number; username: string; password: string }

export class Lhm implements Board {
  private connection: Connection | null = null

  constructor(private readonly file: string) {}

  private async connect(): Promise<Connection> {
    if (this.connection) return this.connection
    let text: string
    try {
      text = await readFile(this.file, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("LibreHardwareMonitor is not installed: run apps/host-agent/scripts/install-sensors.ps1 as administrator.")
      throw new Error(`Unable to read the LibreHardwareMonitor connection file: ${(e as Error).message}`)
    }
    const c = JSON.parse(text.replace(/^﻿/, "")) as Partial<Connection>
    if (!Number.isInteger(c.port) || c.port! < 1 || c.port! > 65535 || typeof c.username !== "string" || typeof c.password !== "string" || !c.password) {
      throw new Error("Invalid LibreHardwareMonitor connection file.")
    }
    return (this.connection = c as Connection)
  }

  private async request(path: string, method = "GET"): Promise<unknown> {
    const c = await this.connect()
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${c.port}/${path}`, {
        method,
        headers: { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}` },
        signal: AbortSignal.timeout(2_000),
        redirect: "error",
      })
    } catch {
      throw new Error("LibreHardwareMonitor is not responding: start it as administrator (its sign-in task) and approve its PawnIO driver.")
    }
    if (!res.ok) throw new Error(`LibreHardwareMonitor sensor request failed (HTTP ${res.status}).`)
    return res.json()
  }

  async sensors() {
    return libreSensors(await this.request("data.json"))
  }

  async setControl(id: string, pct: number | null) {
    if (!FAN_CONTROL_ID.test(id) || (pct !== null && (!Number.isFinite(pct) || pct < 40 || pct > 100))) throw new Error("Invalid motherboard fan control or speed (40–100%).")
    const query = new URLSearchParams({ action: "Set", id, value: pct === null ? "null" : String(pct) })
    const result = (await this.request(`Sensor?${query}`, "POST")) as { result?: string; message?: string } | null
    if (result?.result !== "ok") throw new Error(`LibreHardwareMonitor rejected the fan setting: ${result?.message ?? "no response"}`)
  }
}
