import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { realVolume } from "../src/collector"
import { Hwmon } from "../src/hwmon"
import { cpuSensors, diskRates, motherboardFans } from "../src/lhm"

/** A fake sysfs/proc laid out like the server's (i5-11400, NCT6798D: no pwm3, fans on headers 1, 2 and 5). */
let root: string
const put = (path: string, value: string | number) => {
  const file = join(root, path)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, `${value}\n`)
}
const get = (path: string) => readFileSync(join(root, path), "utf8").trim()
const diskstats = (readSectors: number, writeSectors: number) =>
  put("proc/diskstats", [
    `259       0 nvme0n1 1000 0 ${readSectors} 0 2000 0 ${writeSectors} 0 0 0 0`,
    `259       1 nvme0n1p1 10 0 99999 0 20 0 99999 0 0 0 0`,
  ].join("\n"))

const board = () => new Hwmon(join(root, "state.json"), { hwmon: join(root, "hwmon"), cpu: join(root, "cpu"), diskstats: join(root, "proc/diskstats") })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hwmon-"))
  put("hwmon/hwmon0/name", "acpitz")
  put("hwmon/hwmon0/temp1_input", 27800)
  put("hwmon/hwmon3/name", "coretemp")
  put("hwmon/hwmon3/temp1_label", "Package id 0")
  put("hwmon/hwmon3/temp1_input", 36000)
  put("hwmon/hwmon3/temp2_label", "Core 0")
  put("hwmon/hwmon3/temp2_input", 34000)
  put("hwmon/hwmon4/name", "nct6798")
  for (const [n, rpm] of [[1, 775], [2, 735], [3, 0], [5, 657]]) put(`hwmon/hwmon4/fan${n}_input`, rpm)
  for (const n of [1, 2, 4, 5]) {
    put(`hwmon/hwmon4/pwm${n}`, 82)
    put(`hwmon/hwmon4/pwm${n}_enable`, 5)
  }
  put("cpu/cpu0/cpufreq/scaling_cur_freq", 4_000_000)
  put("cpu/cpu1/cpufreq/scaling_cur_freq", 3_000_000)
  diskstats(1000, 2000)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("Hwmon sensors", () => {
  it("reads the CPU package temperature and clocks as LibreHardwareMonitor did", async () => {
    const cpu = cpuSensors(await board().sensors())
    expect(cpu.temperature_c).toBe(36)
    expect(cpu.clock_mhz).toBe(3500)
    expect(cpu.power_w).toBeNull()
  })

  it("names the fan headers with LHM's ids, so the fan settings saved on Windows still match", async () => {
    const fans = motherboardFans(await board().sensors())
    expect(fans.map((f) => f.id)).toEqual(["/lpc/nct6798d/0/control/0", "/lpc/nct6798d/0/control/1", "/lpc/nct6798d/0/control/3", "/lpc/nct6798d/0/control/4"])
    expect(fans.find((f) => f.id.endsWith("/4"))).toMatchObject({ name: "Fan #5", pct: 32.2, rpm: 657 })
    expect(fans.find((f) => f.id.endsWith("/3"))?.rpm).toBeNull() // header 4 has no fan input
  })

  it("reports whole drives' rates from the second reading on", async () => {
    const b = board()
    expect(diskRates(await b.sensors())).toEqual({ read_bps: null, write_bps: null })
    await new Promise((r) => setTimeout(r, 20))
    diskstats(1000 + 2048, 2000)
    const rates = diskRates(await b.sensors())
    expect(rates.read_bps).toBeGreaterThan(0)
    expect(rates.write_bps).toBe(0)
  })

  it("fails clearly with no sensor drivers", async () => {
    rmSync(join(root, "hwmon"), { recursive: true })
    await expect(board().sensors()).rejects.toThrow(/nct6775/)
  })
})

describe("Hwmon fan control", () => {
  it("takes a header in manual mode and hands it back to the mode it had", async () => {
    const b = board()
    await b.setControl("/lpc/nct6798d/0/control/0", 60)
    expect(get("hwmon/hwmon4/pwm1_enable")).toBe("1")
    expect(get("hwmon/hwmon4/pwm1")).toBe("153")
    expect(JSON.parse(get("state.json"))).toEqual({ "nct6798/pwm1": 5 })
    // A second write keeps the saved mode (the header is already manual).
    await b.setControl("/lpc/nct6798d/0/control/0", 100)
    expect(get("hwmon/hwmon4/pwm1")).toBe("255")
    expect(JSON.parse(get("state.json"))).toEqual({ "nct6798/pwm1": 5 })
    // The watchdog is another process: a new instance hands it back from the saved mode.
    await board().setControl("/lpc/nct6798d/0/control/0", null)
    expect(get("hwmon/hwmon4/pwm1_enable")).toBe("5")
    expect(JSON.parse(get("state.json"))).toEqual({})
  })

  it("saves every header's mode when the controller sets them in parallel", async () => {
    const b = board()
    await Promise.all([0, 1, 4].map((n) => b.setControl(`/lpc/nct6798d/0/control/${n}`, 70)))
    expect(JSON.parse(get("state.json"))).toEqual({ "nct6798/pwm1": 5, "nct6798/pwm2": 5, "nct6798/pwm5": 5 })
    expect([1, 2, 5].map((n) => get(`hwmon/hwmon4/pwm${n}`))).toEqual(["179", "179", "179"])
    await Promise.all([0, 1, 4].map((n) => b.setControl(`/lpc/nct6798d/0/control/${n}`, null)))
    expect([1, 2, 5].map((n) => get(`hwmon/hwmon4/pwm${n}_enable`))).toEqual(["5", "5", "5"])
    expect(JSON.parse(get("state.json"))).toEqual({})
  })

  it("leaves a header it never took alone, and falls back to SmartFan for a manual one with no saved mode", async () => {
    await board().setControl("/lpc/nct6798d/0/control/4", null)
    expect(get("hwmon/hwmon4/pwm5_enable")).toBe("5")
    put("hwmon/hwmon4/pwm5_enable", 1)
    await board().setControl("/lpc/nct6798d/0/control/4", null)
    expect(get("hwmon/hwmon4/pwm5_enable")).toBe("5")
  })

  it("refuses bad ids, speeds below 40% and headers without PWM", async () => {
    await expect(board().setControl("/lpc/nct6798d/0/fan/0", 60)).rejects.toThrow(/Invalid/)
    await expect(board().setControl("/lpc/nct6798d/0/control/0", 30)).rejects.toThrow(/40–100/)
    await expect(board().setControl("/lpc/nct6798d/0/control/2", 60)).rejects.toThrow(/no PWM/)
    expect(get("hwmon/hwmon4/pwm1_enable")).toBe("5")
  })
})

describe("realVolume", () => {
  it("keeps disks and drops Linux's virtual filesystems", () => {
    expect(realVolume({ type: "ext4", mount: "/" })).toBe(true)
    expect(realVolume({ type: "exfat", mount: "/run/media/colin/5tbStorage" })).toBe(true)
    expect(realVolume({ type: "NTFS", mount: "C:\\" })).toBe(true)
    for (const v of [{ type: "squashfs", mount: "/snap/core/1" }, { type: "tmpfs", mount: "/run" }, { type: "overlay", mount: "/var/lib/docker/x" }, { type: "fuse.OrcaDesktop.AppImage", mount: "/tmp/.mount_Orca" }, { type: "vfat", mount: "/boot/efi" }]) {
      expect(realVolume(v)).toBe(false)
    }
  })
})
