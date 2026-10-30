import { createHash } from "node:crypto"
import os from "node:os"
import type { HostOutlet } from "@mb/core/host"
import { Helpers, VeSync, type VeSyncBaseDevice } from "tsvesync"

/**
 * The server's power draw, from a VeSync energy-monitoring smart outlet (tsvesync, VeSync's
 * unofficial cloud API). Read every `refreshMs` (a minute by default); between refreshes the last
 * reading stands. The login stays in `.env` and never reaches a dashboard.
 */

/**
 * Since 2026-10-26 VeSync completes a login only for its own app's ID ("login temporary auth code
 * expired" otherwise); tsvesync 1.6.1 makes up a random one per login. The terminal ID is this
 * machine's, the same across restarts (as pyvesync does), so VeSync sees one known client rather
 * than a new phone each time.
 */
export const VESYNC_APP_ID = "eldodkfj"

export const terminalId = () => {
  const mac = Object.values(os.networkInterfaces())
    .flat()
    .find((n) => n && !n.internal && n.mac !== "00:00:00:00:00:00")?.mac
  return `2${createHash("md5")
    .update(os.hostname() + (mac ?? ""))
    .digest("hex")}`
}

/** The outlet models tsvesync reads power and daily energy from. */
const ENERGY_OUTLETS = new Set(["wifi-switch-1.3", "ESW03-USA", "ESW01-EU", "ESW10-USA", "ESW15-USA", "ESO15-TB"])

type Outlet = VeSyncBaseDevice & { getEnergyUsage?: () => Promise<Record<string, unknown>> }

export type PowerState = {
  configured: boolean
  outlet: HostOutlet | null
  watts: number | null
  energy_today_kwh: number | null
  updated_at: Date | null
  devices: HostOutlet[]
  error: string | null
}

/** A non-negative number, or null ("Not supported", empty, garbage). */
export const finiteReading = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "" || value === "Not supported") return null
  if (typeof value !== "number" && typeof value !== "string") return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

type Api = typeof Helpers.callApi

const result = (response: { code?: number; result?: unknown } | null, status: number, what: string) => {
  if (status !== 200 || response?.code !== 0 || !response.result || typeof response.result !== "object") {
    throw new Error(`VeSync ${what} failed (HTTP ${status}${Number.isFinite(response?.code) ? `, code ${response!.code}` : ""}).`)
  }
  return response.result as Record<string, unknown>
}

/**
 * tsvesync 1.6.1's ESW15-USA energy endpoint is obsolete: read it with the newer deviceDetail and
 * getLastWeekEnergy requests pyvesync documents.
 */
export const readEsw15 = async (manager: VeSync, outlet: VeSyncBaseDevice, callApi: Api = Helpers.callApi.bind(Helpers)) => {
  const common = { ...Helpers.reqBody(manager, "devicestatus"), ...Helpers.reqBodyDetails(), userCountryCode: manager.countryCode, debugMode: false }
  const headers = Helpers.reqHeaderBypass()
  const [detail, detailStatus] = await callApi(
    "/cloud/v1/deviceManaged/deviceDetail",
    "post",
    { ...common, method: "deviceDetail", uuid: outlet.uuid, cid: outlet.cid, deviceId: outlet.cid, configModule: outlet.configModule, configModel: outlet.configModule },
    headers,
    manager,
  )
  const watts = finiteReading(result(detail, detailStatus, "outlet telemetry").power)
  if (watts === null) throw new Error("VeSync outlet telemetry had no usable power reading.")
  const [history, historyStatus] = await callApi("/cloud/v1/device/getLastWeekEnergy", "post", { ...common, method: "getLastWeekEnergy", homeTimeZone: manager.timeZone, uuid: outlet.uuid }, headers, manager)
  return { watts, energy_today_kwh: finiteReading(result(history, historyStatus, "outlet energy history").energyConsumptionOfToday) }
}

export class PowerMonitor {
  private manager: VeSync | null = null
  private outlets: Outlet[] = []
  private state: PowerState
  private lastAttempt = 0
  private inFlight: Promise<PowerState> | null = null
  private energyFailed = false

  constructor(
    private readonly config: { username: string; password: string; timeZone: string; countryCode: string; refreshMs: number },
    /** The selected outlet (settings.outlet_id), read on every refresh. */
    private readonly selected: () => string | null,
  ) {
    this.state = { configured: !!(config.username && config.password), outlet: null, watts: null, energy_today_kwh: null, updated_at: null, devices: [], error: null }
  }

  /** The last reading; refreshes it first when it is due. */
  async read(force = false): Promise<PowerState> {
    if (!this.state.configured) return { ...this.state, error: "VeSync isn't configured: set VESYNC_USERNAME and VESYNC_PASSWORD in .env." }
    if (this.inFlight) return this.inFlight
    if (!force && Date.now() - this.lastAttempt < this.config.refreshMs) return this.state
    this.lastAttempt = Date.now()
    this.inFlight = this.refresh().finally(() => (this.inFlight = null))
    return this.inFlight
  }

  /** Logs in and lists the supported outlets on the account. */
  async discover(): Promise<HostOutlet[]> {
    if (!this.state.configured) throw new Error("VeSync isn't configured: set VESYNC_USERNAME and VESYNC_PASSWORD in .env.")
    this.manager ??= new VeSync(this.config.username, this.config.password, this.config.timeZone, {
      debug: true,
      redact: true,
      countryCode: this.config.countryCode,
      customLogger: {
        // tsvesync reports a failed energy request only in its debug log, then returns a fallback value.
        debug: (message: string) => {
          if (message.includes("Failed to update energy data:")) this.energyFailed = true
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    })
    this.manager.restoreClientIdentity({ appId: VESYNC_APP_ID, terminalId: terminalId() })
    if (!(await this.manager.login())) throw new Error("VeSync login failed: check the account and its region.")
    // false also for an account that sees no devices (a shared home whose invite isn't accepted yet).
    if (!(await this.manager.getDevices())) throw new Error("VeSync lists no devices on this account (if the outlet is shared with it, accept the invite in the VeSync app).")
    this.outlets = ((this.manager.devices ?? []) as Outlet[]).filter((d) => ENERGY_OUTLETS.has(d.deviceType) && typeof d.getEnergyUsage === "function")
    const devices = this.outlets.map((d) => ({ id: d.cid, name: d.deviceName, model: d.deviceType }))
    this.state = { ...this.state, devices }
    return devices
  }

  private async refresh(): Promise<PowerState> {
    try {
      if (!this.manager || !this.outlets.length) await this.discover()
      if (!this.outlets.length) throw new Error("No supported VeSync energy-monitoring outlet was found.")
      const id = this.selected()
      const outlet = this.outlets.find((d) => d.cid === id) ?? (!id && this.outlets.length === 1 ? this.outlets[0] : null)
      if (!outlet) throw new Error(id ? "The selected outlet isn't among the discovered ones." : "Several outlets found: pick one in Settings.")
      this.energyFailed = false
      let watts: number | null
      let today: number | null
      if (outlet.deviceType === "ESW15-USA") {
        ;({ watts, energy_today_kwh: today } = await readEsw15(this.manager!, outlet))
      } else {
        const energy = await outlet.getEnergyUsage!()
        if (this.energyFailed) throw new Error("VeSync didn't return a successful energy response; the library's fallback value was discarded.")
        watts = finiteReading(energy.power)
        today = finiteReading(energy.energy_today)
      }
      if (watts === null && today === null) throw new Error(`${outlet.deviceType} returned no usable power or daily energy.`)
      this.state = { ...this.state, outlet: { id: outlet.cid, name: outlet.deviceName, model: outlet.deviceType }, watts, energy_today_kwh: today, updated_at: new Date(), error: null }
    } catch (e) {
      this.state = { ...this.state, outlet: null, watts: null, energy_today_kwh: null, error: e instanceof Error ? e.message : "VeSync update failed." }
    }
    return this.state
  }
}
