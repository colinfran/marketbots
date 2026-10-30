import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { curvePct, FanController, type Guard } from "../src/fans"
import type { Board, Sensor } from "../src/lhm"

const H0 = "/lpc/nct6798d/0/control/0"
const H1 = "/lpc/nct6798d/0/control/1"
const H2 = "/lpc/nct6798d/0/control/2"

/** A motherboard: two spinning fans, an empty header, a CPU temperature; records every write. */
class FakeBoard implements Board {
  temp: number | null = 50
  rpm = new Map<string, number>([
    [H0, 1200],
    [H1, 1100],
    [H2, 0],
  ])
  writes: [string, number | null][] = []

  async sensors(): Promise<Sensor[]> {
    const fans = [...this.rpm].flatMap(([id, rpm], i): Sensor[] => [
      { id, hardwareId: "/lpc/nct6798d/0", name: `Fan #${i + 1}`, type: "Control", value: 100 },
      { id: id.replace("/control/", "/fan/"), hardwareId: "/lpc/nct6798d/0", name: `Fan #${i + 1}`, type: "Fan", value: rpm },
    ])
    const cpu: Sensor[] = this.temp === null ? [] : [{ id: "/intelcpu/0/temperature/8", hardwareId: "/intelcpu/0", name: "CPU Package", type: "Temperature", value: this.temp }]
    return [...fans, ...cpu]
  }

  async setControl(id: string, pct: number | null) {
    this.writes.push([id, pct])
  }

  /** The last speed written to each header. */
  last() {
    return Object.fromEntries(this.writes.map(([id, pct]) => [id, pct]))
  }
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

let dir: string
let board: FakeBoard
let guarded: string[][]
const guard: Guard = async (ids) => {
  guarded.push(ids)
}

const controller = (control = true, g: Guard | undefined = guard) => new FanController({ board, file: join(dir, "fan-settings.json"), control, guard: g, log: quiet })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fans-"))
  board = new FakeBoard()
  guarded = []
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("curvePct", () => {
  it("follows the curve between its points, rounding up", () => {
    expect(curvePct(20)).toBe(40)
    expect(curvePct(30)).toBe(40)
    expect(curvePct(50)).toBe(55)
    expect(curvePct(75)).toBe(85)
    expect(curvePct(84.9)).toBe(100)
  })

  it("is 100% at the protection temperature or without one", () => {
    expect(curvePct(85)).toBe(100)
    expect(curvePct(null)).toBe(100)
  })
})

describe("FanController", () => {
  it("leaves the BIOS in control until a setting is saved, and lists only connected fans", async () => {
    const fans = controller()
    await fans.start()
    await fans.stop()
    expect(board.writes).toEqual([])
    const snap = fans.snapshot()
    expect(snap).toMatchObject({ control: "agent", mode: "bios", target_pct: null, temperature_c: 50, error: null })
    expect(snap.fans.map((f) => f.id)).toEqual([H0, H1])
  })

  it("applies a manual speed to every spinning fan, after the watchdog acknowledged, and saves it", async () => {
    const fans = controller()
    await fans.start()
    const snap = await fans.update({ mode: "manual", manual_pct: 70 })
    expect(board.last()).toEqual({ [H0]: 70, [H1]: 70 })
    expect(guarded.at(-1)?.sort()).toEqual([H0, H1])
    expect(snap).toMatchObject({ mode: "manual", manual_pct: 70, target_pct: 70 })
    expect(JSON.parse(await readFile(join(dir, "fan-settings.json"), "utf8"))).toEqual({ mode: "manual", manual_pct: 70, channel_ids: [H0, H1] })
    await fans.stop()
  })

  it("comes down the curve 5 points a tick, and goes up at once", async () => {
    const fans = controller()
    await fans.start()
    await fans.update({ mode: "manual", manual_pct: 70 })
    await fans.update({ mode: "curve", manual_pct: 70 })
    expect(board.last()[H0]).toBe(65)
    await fans.tick()
    expect(board.last()[H0]).toBe(60)
    await fans.tick()
    expect(board.last()[H0]).toBe(55)
    await fans.tick()
    expect(board.last()[H0]).toBe(55)
    board.temp = 75
    await fans.tick()
    expect(board.last()[H0]).toBe(85)
    await fans.stop()
  })

  it("runs every fan at 100% without a CPU temperature, or when a controlled fan stops reporting RPM", async () => {
    const fans = controller()
    await fans.start()
    await fans.update({ mode: "manual", manual_pct: 50 })
    board.temp = null
    await fans.tick()
    expect(board.last()).toEqual({ [H0]: 100, [H1]: 100 })
    expect(fans.snapshot().error).toMatch(/Cooling protection/)
    board.temp = 50
    await fans.tick()
    expect(board.last()[H0]).toBe(95)
    board.rpm.set(H1, 0)
    await fans.tick()
    expect(board.last()).toEqual({ [H0]: 100, [H1]: 100 })
    await fans.stop()
  })

  it("hands every fan back to the BIOS", async () => {
    const fans = controller()
    await fans.start()
    await fans.update({ mode: "manual", manual_pct: 60 })
    const snap = await fans.update({ mode: "bios", manual_pct: 60 })
    expect(board.last()).toEqual({ [H0]: null, [H1]: null })
    expect(snap).toMatchObject({ mode: "bios", target_pct: null })
    await fans.stop()
  })

  it("restores the saved setting after a restart", async () => {
    const first = controller()
    await first.start()
    await first.update({ mode: "manual", manual_pct: 80 })
    await first.stop()
    board.writes = []
    const second = controller()
    await second.start()
    expect(board.last()).toEqual({ [H0]: 80, [H1]: 80 })
    expect(second.snapshot()).toMatchObject({ mode: "manual", manual_pct: 80 })
    await second.stop()
    // stop() released them.
    expect(board.last()).toEqual({ [H0]: null, [H1]: null })
  })

  it("doesn't write without the watchdog's acknowledgement, and releases what it holds", async () => {
    const fans = controller()
    await fans.start()
    await fans.update({ mode: "manual", manual_pct: 60 })
    guarded = []
    const failing = controller(true, async () => {
      throw new Error("The fan watchdog is unavailable.")
    })
    await expect(failing.start()).rejects.toThrow(/watchdog is unavailable/)
    await fans.stop()
  })

  it("only reads the fans with control off", async () => {
    const fans = controller(false, undefined)
    await fans.start()
    await expect(fans.update({ mode: "manual", manual_pct: 60 })).rejects.toThrow(/FAN_CONTROL=off/)
    expect(board.writes).toEqual([])
    expect(fans.snapshot()).toMatchObject({ control: "off", mode: null, temperature_c: 50 })
    expect(fans.snapshot().fans).toHaveLength(2)
    await fans.stop()
  })

  it("refuses a speed setting with no fan reporting RPM", async () => {
    board.rpm = new Map([[H0, 0]])
    const fans = controller()
    await fans.start()
    await expect(fans.update({ mode: "manual", manual_pct: 60 })).rejects.toThrow(/No connected motherboard fans/)
    await fans.stop()
  })
})
