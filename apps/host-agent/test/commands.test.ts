import { DEFAULT_HOST_SETTINGS, type FanSettings, type HostFans } from "@mb/core/host"
import { describe, expect, it, vi } from "vitest"
import { HostCommands, type CommandTargets } from "../src/commands"
import { HostStore } from "../src/store"

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

const fansAt = (s: FanSettings): HostFans => ({ control: "agent", mode: s.mode, manual_pct: s.manual_pct, target_pct: s.manual_pct, temperature_c: 40, fans: [{ id: "a", name: "Fan #1", rpm: 900 }], error: null })

const targets = (over: Partial<CommandTargets> = {}): CommandTargets => ({
  fans: { update: async (s) => fansAt(s) },
  settings: { save: async (s) => s },
  power: { discover: async () => [{ id: "cid", name: "Server", model: "ESW15-USA" }] },
  onSettings: () => undefined,
  ...over,
})

const setup = (over: Partial<CommandTargets> = {}) => {
  const store = new HostStore(":memory:")
  return { store, commands: new HostCommands(store, targets(over), quiet) }
}

describe("HostCommands", () => {
  it("records each command as pending, runs it, and keeps what it did", async () => {
    const onSettings = vi.fn()
    const { store, commands } = setup({ onSettings })
    expect(commands.submit("c1", { type: "fans.set", mode: "manual", manual_pct: 70 }, "owner")).toBe(true)
    commands.submit("c2", { type: "settings.update", settings: { ...DEFAULT_HOST_SETTINGS, price_per_kwh: 0.45 } }, "owner")
    commands.submit("c3", { type: "outlets.discover" }, "owner")
    expect(store.command("c3")).toMatchObject({ status: "pending" })
    await commands.idle()
    expect(["c1", "c2", "c3"].map((id) => store.command(id))).toEqual([
      { _id: "c1", type: "fans.set", status: "done", result: "Manual speed 70% is set on 1 fan. Saved for restarts; the RPMs can take a few seconds to follow.", error: null },
      { _id: "c2", type: "settings.update", status: "done", result: "Settings saved.", error: null },
      { _id: "c3", type: "outlets.discover", status: "done", result: "Found 1: Server (ESW15-USA).", error: null },
    ])
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ price_per_kwh: 0.45 }))
  })

  it("runs them one after another, never two at once", async () => {
    const order: string[] = []
    let release = () => undefined as void
    const held = new Promise<void>((r) => (release = r))
    const update = async (s: FanSettings) => {
      order.push(`start ${s.manual_pct}`)
      if (s.manual_pct === 70) await held
      order.push(`end ${s.manual_pct}`)
      return fansAt(s)
    }
    const { commands } = setup({ fans: { update } })
    commands.submit("a", { type: "fans.set", mode: "manual", manual_pct: 70 }, "owner")
    commands.submit("b", { type: "fans.set", mode: "manual", manual_pct: 80 }, "owner")
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(["start 70"])
    release()
    await commands.idle()
    expect(order).toEqual(["start 70", "end 70", "start 80", "end 80"])
  })

  it("refuses an id already taken, and reports a failure", async () => {
    const { store, commands } = setup({ fans: { update: async () => Promise.reject(new Error("No connected motherboard fans with RPM feedback.")) } })
    expect(commands.submit("c1", { type: "fans.set", mode: "curve", manual_pct: 70 }, "owner")).toBe(true)
    expect(commands.submit("c1", { type: "outlets.discover" }, "owner")).toBe(false)
    await commands.idle()
    expect(store.command("c1")).toEqual({ _id: "c1", type: "fans.set", status: "failed", result: null, error: "No connected motherboard fans with RPM feedback." })
  })
})
