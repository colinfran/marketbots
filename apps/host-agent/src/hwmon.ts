import { readdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { FAN_CONTROL_ID, type Board, type Sensor } from "./lhm"

/**
 * The Linux board (Board, like Lhm on Windows): the kernel's hwmon drivers, read from sysfs.
 * - coretemp (or k10temp): the CPU package temperature.
 * - the motherboard's Super I/O (nct6775 driver; the server's NCT6798D): fan RPMs and the PWM
 *   headers. Its sensors get LibreHardwareMonitor's ids (`/lpc/nct6798d/0/fan|control/<n>`, n =
 *   header − 1), so the fan settings saved on Windows (fan-settings.json) keep naming the same headers.
 * - cpufreq for the cores' clocks, /proc/diskstats for the drives' read and write rates.
 *
 * Setting a header switches it to manual (pwmN_enable = 1) and writes its duty; handing it back
 * restores the automatic mode it had before (SmartFan on Nuvoton chips). That mode is saved in
 * `stateFile` the first time the agent takes a header, so the fan watchdog, a separate process,
 * can hand it back too. Writing needs the udev rule in apps/host-agent/linux/ (the agent isn't root).
 */

/** Kernel chip names → LibreHardwareMonitor's, so ids saved on Windows still match. */
const LHM_CHIP: Record<string, string> = { nct6798: "nct6798d" }
/** Fan controllers: the nct6775 driver's chips (nct6106 … nct6799) and the it87 driver's. */
const SUPER_IO = /^(nct6\d{3}|it8\d{3})$/
const CPU_CHIP = /^(coretemp|k10temp)$/
/** The automatic mode to hand a header back to when its earlier one wasn't saved: SmartFan IV on Nuvoton chips. */
const DEFAULT_AUTO_ENABLE = 5
/** Whole drives in /proc/diskstats (not partitions). Sectors there are always 512 bytes. */
const WHOLE_DISK = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|hd[a-z]+)$/
const SECTOR = 512

type Chip = { dir: string; name: string }
type Paths = { hwmon?: string; cpu?: string; diskstats?: string }

const readText = async (file: string) => {
  try {
    return (await readFile(file, "utf8")).trim()
  } catch {
    return null
  }
}

const readNumber = async (file: string) => {
  const text = await readText(file)
  if (text === null || text === "") return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

const permission = (e: unknown) => ["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")

export class Hwmon implements Board {
  private readonly hwmon: string
  private readonly cpu: string
  private readonly diskstats: string
  private disks: { t: number; bytes: Map<string, { read: number; write: number }> } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly stateFile: string,
    paths: Paths = {},
  ) {
    this.hwmon = paths.hwmon ?? "/sys/class/hwmon"
    this.cpu = paths.cpu ?? "/sys/devices/system/cpu"
    this.diskstats = paths.diskstats ?? "/proc/diskstats"
  }

  private async chips(): Promise<Chip[]> {
    let entries: string[]
    try {
      entries = await readdir(this.hwmon)
    } catch {
      return []
    }
    const chips = await Promise.all(entries.map(async (e) => ({ dir: join(this.hwmon, e), name: (await readText(join(this.hwmon, e, "name"))) ?? "" })))
    return chips.filter((c) => c.name).sort((a, b) => a.dir.localeCompare(b.dir))
  }

  private async cpuSensors(chip: Chip): Promise<Sensor[]> {
    const hw = "/cpu/0"
    const files = await readdir(chip.dir)
    const sensors: Sensor[] = []
    for (const f of files) {
      const m = f.match(/^temp(\d+)_input$/)
      if (!m) continue
      const label = (await readText(join(chip.dir, `temp${m[1]}_label`))) ?? ""
      const raw = await readNumber(join(chip.dir, f))
      const value = raw === null ? null : raw / 1000
      // coretemp: "Package id 0", "Core 0"…; k10temp: "Tctl" (the control temperature AMD exposes).
      const core = label.match(/^Core (\d+)$/)
      const name = /^(Package id 0|Tctl)$/.test(label) ? "CPU Package" : core ? `CPU Core #${Number(core[1]) + 1}` : label
      if (name) sensors.push({ id: `${hw}/temperature/${m[1]}`, hardwareId: hw, name, type: "Temperature", value })
    }
    return sensors
  }

  /** Each logical CPU's current clock (cpufreq reports kHz). */
  private async clocks(): Promise<Sensor[]> {
    let entries: string[]
    try {
      entries = await readdir(this.cpu)
    } catch {
      return []
    }
    const cpus = entries.filter((e) => /^cpu\d+$/.test(e)).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    const sensors = await Promise.all(
      cpus.map(async (c): Promise<Sensor | null> => {
        const khz = await readNumber(join(this.cpu, c, "cpufreq", "scaling_cur_freq"))
        const n = Number(c.slice(3))
        return khz === null ? null : { id: `/cpu/0/clock/${n + 1}`, hardwareId: "/cpu/0", name: `CPU Core #${n + 1}`, type: "Clock", value: khz / 1000 }
      }),
    )
    return sensors.filter((s): s is Sensor => s !== null)
  }

  private async fanSensors(chip: Chip): Promise<Sensor[]> {
    const hw = `/lpc/${LHM_CHIP[chip.name] ?? chip.name}/0`
    const files = await readdir(chip.dir)
    const sensors: Sensor[] = []
    for (const f of files) {
      const fan = f.match(/^fan(\d+)_input$/)
      const pwm = f.match(/^pwm(\d+)$/)
      if (fan) {
        const n = Number(fan[1])
        sensors.push({ id: `${hw}/fan/${n - 1}`, hardwareId: hw, name: `Fan #${n}`, type: "Fan", value: await readNumber(join(chip.dir, f)) })
      } else if (pwm) {
        const n = Number(pwm[1])
        const raw = await readNumber(join(chip.dir, f))
        sensors.push({ id: `${hw}/control/${n - 1}`, hardwareId: hw, name: `Fan #${n}`, type: "Control", value: raw === null ? null : Math.round((raw / 255) * 1000) / 10 })
      }
    }
    return sensors
  }

  /** Every whole drive's read and write rate since the previous call (none on the first). */
  private async diskRates(): Promise<Sensor[]> {
    const text = await readText(this.diskstats)
    if (text === null) return []
    const t = Date.now()
    const bytes = new Map<string, { read: number; write: number }>()
    for (const line of text.split("\n")) {
      const f = line.trim().split(/\s+/)
      if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue
      bytes.set(f[2], { read: Number(f[5]) * SECTOR, write: Number(f[9]) * SECTOR })
    }
    const previous = this.disks
    this.disks = { t, bytes }
    if (!previous || t <= previous.t) return []
    const seconds = (t - previous.t) / 1000
    const sensors: Sensor[] = []
    let index = 0
    for (const [name, now] of bytes) {
      const before = previous.bytes.get(name)
      if (!before) continue
      const hw = `/${name.startsWith("nvme") ? "nvme" : "hdd"}/${index++}`
      const rate = (a: number, b: number) => Math.max(0, (a - b) / seconds)
      sensors.push(
        { id: `${hw}/throughput/0`, hardwareId: hw, name: "Read Rate", type: "Throughput", value: rate(now.read, before.read) },
        { id: `${hw}/throughput/1`, hardwareId: hw, name: "Write Rate", type: "Throughput", value: rate(now.write, before.write) },
      )
    }
    return sensors
  }

  async sensors(): Promise<Sensor[]> {
    const chips = await this.chips()
    const cpuChip = chips.find((c) => CPU_CHIP.test(c.name))
    const superIo = chips.find((c) => SUPER_IO.test(c.name))
    if (!cpuChip && !superIo) throw new Error("No motherboard sensors: load the coretemp and nct6775 kernel modules (apps/host-agent/linux/).")
    const [cpu, clocks, fans, disks] = await Promise.all([
      cpuChip ? this.cpuSensors(cpuChip) : [],
      this.clocks(),
      superIo ? this.fanSensors(superIo) : [],
      this.diskRates(),
    ])
    return [...cpu, ...clocks, ...fans, ...disks]
  }

  private async loadState(): Promise<Record<string, number>> {
    const text = await readText(this.stateFile)
    if (!text) return {}
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number] => Number.isInteger(e[1])))
    } catch {
      return {}
    }
  }

  private async saveState(state: Record<string, number>) {
    // Per process: the agent and the fan watchdog may both save (never at once, but never share a temp file).
    const tmp = `${this.stateFile}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.stateFile)
  }

  /** One header at a time: the fan controller sets its headers in parallel, and each read-modify-writes the saved modes. */
  setControl(id: string, pct: number | null): Promise<void> {
    const run = this.queue.then(() => this.set(id, pct))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async set(id: string, pct: number | null) {
    const header = FAN_CONTROL_ID.test(id) ? id.match(/\/control\/(\d+)$/) : null
    if (!header || (pct !== null && (!Number.isFinite(pct) || pct < 40 || pct > 100))) throw new Error("Invalid motherboard fan control or speed (40–100%).")
    const chip = (await this.chips()).find((c) => SUPER_IO.test(c.name))
    if (!chip) throw new Error("No motherboard fan controller: load the nct6775 kernel module (apps/host-agent/linux/).")
    const n = Number(header[1]) + 1
    const pwm = join(chip.dir, `pwm${n}`)
    const enable = `${pwm}_enable`
    const key = `${chip.name}/pwm${n}`
    try {
      const current = await readNumber(enable)
      if (current === null) throw new Error(`Fan header ${n} has no PWM control on this board.`)
      const state = await this.loadState()
      if (pct === null) {
        // Hand back: only a header in manual mode needs it; the mode it had before, else the chip's automatic one.
        if (current === 1) await writeFile(enable, String(state[key] ?? DEFAULT_AUTO_ENABLE))
        if (key in state) {
          delete state[key]
          await this.saveState(state)
        }
        return
      }
      if (current !== 1) {
        if (!(key in state)) {
          state[key] = current
          await this.saveState(state)
        }
        await writeFile(enable, "1")
      }
      await writeFile(pwm, String(Math.round((pct / 100) * 255)))
    } catch (e) {
      if (permission(e)) throw new Error("No permission to set the motherboard fans: install the udev rule in apps/host-agent/linux/.")
      throw e
    }
  }
}
