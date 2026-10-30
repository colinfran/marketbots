import { fork } from "node:child_process"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { FAN_CURVE, FAN_PROTECT_C, fanSettingsSchema, type FanSettings, type HostFans } from "@mb/core/host"
import { cpuSensors, FAN_CONTROL_ID, motherboardFans, type Board } from "./lhm"
import { errorMessage, type Log } from "./log"

/**
 * One setting for every motherboard CPU/case fan (@mb/core/host FAN_MODES), applied every two
 * seconds. Safety rules, in every mode but BIOS:
 * - at FAN_PROTECT_C, with no CPU temperature, or with a controlled fan reporting no RPM, every
 *   controlled fan runs at 100%;
 * - speeds go up at once and come down at most 5 points a tick;
 * - before any write, the watchdog (fan-watchdog.ts, its own process) is told which headers the
 *   agent owns. If the agent stops heartbeating for 8 seconds or exits, it hands them back to the BIOS.
 *
 * Only headers seen with a spinning fan count, never one named like a pump. The setting and the
 * headers are saved in `file` and restored at start; with no saved setting the BIOS keeps control.
 * With `control` off the agent only reads the fans (another app, or the BIOS, sets them).
 */

/** The curve's speed for a CPU temperature; 100% at FAN_PROTECT_C or with no temperature. */
export const curvePct = (temp: number | null) => {
  if (temp === null || !Number.isFinite(temp) || temp >= FAN_PROTECT_C) return 100
  if (temp <= FAN_CURVE[0].temp_c) return FAN_CURVE[0].pct
  for (let i = 1; i < FAN_CURVE.length; i++) {
    const lo = FAN_CURVE[i - 1]
    const hi = FAN_CURVE[i]
    if (temp <= hi.temp_c) return Math.ceil(lo.pct + ((hi.pct - lo.pct) * (temp - lo.temp_c)) / (hi.temp_c - lo.temp_c))
  }
  return 100
}

/** How far a tick may lower the speed. */
export const STEP_DOWN_PCT = 5

export const TICK_MS = 2_000

/** Acknowledges the headers the agent owns before it writes to them (the watchdog). */
export type Guard = (ids: string[]) => Promise<void>

type Channel = { id: string; name: string; rpm: number | null; target: number | null }

export class FanController {
  private settings: FanSettings = { mode: "bios", manual_pct: 100 }
  /** Headers seen with a spinning fan (not a pump): the ones a setting applies to. */
  private readonly known = new Set<string>()
  /** Headers the agent has taken from the BIOS. */
  private readonly controlled = new Set<string>()
  private channels: Channel[] = []
  private temperature: number | null = null
  private error: string | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  private busy = false

  constructor(
    private readonly d: {
      board: Board
      /** Where the setting and its headers are saved. */
      file: string
      control: boolean
      /** The watchdog's acknowledgement; required when `control` is on. */
      guard?: Guard
      log: Log
    },
  ) {}

  async start() {
    if (this.d.control) {
      const saved = await this.load()
      if (saved) {
        this.settings = { mode: saved.mode, manual_pct: saved.manual_pct }
        for (const id of saved.channel_ids) {
          this.known.add(id)
          this.controlled.add(id)
        }
      }
      await this.guard([...this.controlled])
    }
    await this.tick()
    this.timer = setInterval(() => {
      if (!this.busy) void this.tick()
    }, TICK_MS)
    this.timer.unref()
  }

  /** Releases every header to the BIOS (shutdown). */
  async stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.d.control) await this.serial(() => this.release())
  }

  snapshot(): HostFans {
    const shown = this.channels.filter((c) => (c.rpm ?? 0) > 0 || this.known.has(c.id))
    return {
      control: this.d.control ? "agent" : "off",
      mode: this.d.control ? this.settings.mode : null,
      manual_pct: this.d.control ? this.settings.manual_pct : null,
      target_pct: this.channels.find((c) => c.target !== null)?.target ?? null,
      temperature_c: this.temperature,
      fans: shown.map((c) => ({ id: c.id, name: c.name, rpm: c.rpm })),
      error: this.error,
    }
  }

  /** A failure reported from outside the tick (the watchdog's). */
  fault(message: string) {
    this.error = message
  }

  /** Applies and saves a new setting; on failure, keeps the previous one and hands the fans back to the BIOS. */
  update(input: FanSettings): Promise<HostFans> {
    return this.serial(async () => {
      if (!this.d.control) throw new Error("Fan control is off on the server (FAN_CONTROL=off in .env).")
      const next = fanSettingsSchema.parse(input)
      if (next.mode !== "bios" && !this.channels.some((c) => (c.rpm ?? 0) > 0)) throw new Error("No connected motherboard fans with RPM feedback.")
      const previous = this.settings
      this.settings = next
      // Back to BIOS: release every known header, including ones this run never took.
      if (next.mode === "bios") for (const id of this.known) this.controlled.add(id)
      try {
        await this.apply()
        await this.save()
      } catch (e) {
        this.settings = previous
        this.error = `Fan settings were not saved: ${errorMessage(e)}`
        this.d.log.error("fan settings failed", { error: this.error })
        await this.release().catch((r) => this.d.log.error("fan release failed; the watchdog retries", { error: errorMessage(r) }))
        throw new Error(this.error)
      }
      return this.snapshot()
    })
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const run = this.queue.then(action)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** One pass: read the board, apply the setting. Runs every TICK_MS; exposed for tests. */
  tick() {
    this.busy = true
    return this.serial(async () => {
      try {
        await this.apply()
      } catch (e) {
        this.error = errorMessage(e)
        this.d.log.warn("fan control", { error: this.error })
        if (this.d.control) await this.release().catch((r) => this.d.log.error("fan release failed; the watchdog retries", { error: errorMessage(r) }))
      }
    }).finally(() => (this.busy = false))
  }

  private async guard(ids: string[]) {
    if (!this.d.guard) throw new Error("The fan watchdog isn't running.")
    await this.d.guard(ids)
  }

  private async release() {
    const results = await Promise.allSettled(
      [...this.controlled].map(async (id) => {
        await this.d.board.setControl(id, null)
        this.controlled.delete(id)
      }),
    )
    for (const c of this.channels) if (!this.controlled.has(c.id)) c.target = null
    const failed = results.find((r) => r.status === "rejected")
    if (failed) throw failed.reason
  }

  private async apply() {
    const sensors = await this.d.board.sensors()
    const previous = this.channels.map((c) => c.target).filter((t): t is number => t !== null)
    const targets = new Map(this.channels.map((c) => [c.id, c.target]))
    this.temperature = cpuSensors(sensors).temperature_c
    this.channels = motherboardFans(sensors).map((f) => ({ id: f.id, name: f.name, rpm: f.rpm, target: targets.get(f.id) ?? null }))
    for (const c of this.channels) if ((c.rpm ?? 0) > 0 && !/pump/i.test(c.name)) this.known.add(c.id)
    if (!this.d.control) {
      this.error = null
      return
    }
    const active = this.settings.mode === "bios" ? new Set<string>() : this.known
    const touched = [...new Set([...active, ...this.controlled])]
    if (touched.length) await this.guard(touched)
    const unsafe = this.temperature === null || this.temperature >= FAN_PROTECT_C || [...active].some((id) => !((this.channels.find((c) => c.id === id)?.rpm ?? 0) > 0))
    const want = unsafe ? 100 : this.settings.mode === "manual" ? this.settings.manual_pct : curvePct(this.temperature)
    const pct = !unsafe && previous.length ? Math.max(want, Math.max(...previous) - STEP_DOWN_PCT) : want
    const results = await Promise.allSettled(
      touched.map(async (id) => {
        if (!active.has(id)) {
          await this.d.board.setControl(id, null)
          this.controlled.delete(id)
          const c = this.channels.find((x) => x.id === id)
          if (c) c.target = null
          return
        }
        const channel = this.channels.find((c) => c.id === id)
        if (!channel) throw new Error(`A saved fan header is missing: ${id}`)
        this.controlled.add(id)
        await this.d.board.setControl(id, pct)
        channel.target = pct
      }),
    )
    const failed = results.find((r) => r.status === "rejected")
    if (failed) throw failed.reason
    this.error = unsafe && active.size ? "Cooling protection: every fan at full speed (high or missing CPU temperature, or a fan reporting no RPM)." : null
  }

  private async load(): Promise<(FanSettings & { channel_ids: string[] }) | null> {
    let text: string
    try {
      text = await readFile(this.d.file, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new Error(`Unable to read the fan settings: ${errorMessage(e)}`)
    }
    const raw = JSON.parse(text) as { mode?: unknown; manual_pct?: unknown; channel_ids?: unknown }
    const ids = raw.channel_ids
    if (!Array.isArray(ids) || ids.length > 32 || !ids.every((id) => typeof id === "string" && FAN_CONTROL_ID.test(id))) throw new Error("Invalid saved fan headers.")
    return { ...fanSettingsSchema.parse({ mode: raw.mode, manual_pct: raw.manual_pct }), channel_ids: ids as string[] }
  }

  private async save() {
    await mkdir(dirname(this.d.file), { recursive: true })
    const tmp = `${this.d.file}.tmp`
    await writeFile(tmp, `${JSON.stringify({ ...this.settings, channel_ids: [...this.known] }, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.d.file)
  }
}

/**
 * Starts the watchdog as its own detached process (so it outlives the agent). `guard` heartbeats
 * it: each heartbeat names the headers the agent owns and must be acknowledged within 1.5 s, or the
 * write it precedes doesn't happen. `close` disconnects it on shutdown; it then releases what it
 * was last told about and exits. It gets no stdio (the scheduled task runs the agent without a
 * console, and writing to an inherited stderr there killed it); it logs to `logDir` itself.
 */
export const startWatchdog = (
  script: URL,
  connectionFile: string,
  logDir: string,
  log: Log,
  on: { error(message: string): void; /** It stopped while the agent still needed it. */ exit(): void },
): { guard: Guard; close(): void } => {
  const worker = fork(script, [connectionFile, logDir], { detached: true, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] })
  const pending = new Map<number, () => void>()
  let sequence = 0
  let closing = false
  worker.on("message", (m: { ack?: number; error?: string }) => {
    // The watchdog logs its own errors to the file; this shows them on the page.
    if (m.error) on.error(m.error)
    if (m.ack !== undefined) pending.get(m.ack)?.()
  })
  worker.on("error", (e) => on.error(`Fan watchdog failed: ${e.message}`))
  worker.on("exit", (code) => {
    if (closing) return
    log.error("the fan watchdog stopped", { code })
    on.error("The fan watchdog stopped: fan control is off until the agent restarts.")
    on.exit()
  })
  worker.unref()
  const close = () => {
    closing = true
    if (worker.connected) worker.disconnect()
  }
  const guard: Guard = (ids) =>
    new Promise<void>((resolve, reject) => {
      if (!worker.connected) return reject(new Error("The fan watchdog is unavailable."))
      const n = ++sequence
      const timer = setTimeout(() => {
        pending.delete(n)
        reject(new Error("The fan watchdog didn't acknowledge cooling protection."))
      }, 1_500)
      pending.set(n, () => {
        clearTimeout(timer)
        pending.delete(n)
        resolve()
      })
      worker.send({ type: "heartbeat", ids, sequence: n }, (e) => {
        if (!e) return
        clearTimeout(timer)
        pending.delete(n)
        reject(e)
      })
    })
  return { guard, close }
}
