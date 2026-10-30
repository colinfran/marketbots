import { DEFAULT_HOST_SETTINGS, type HostCommandDoc } from "@mb/core/host"
import { describe, expect, it, vi } from "vitest"
import { drainCommands, type CommandTargets } from "../src/commands"
import type { HostStore } from "../src/store"

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0)
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

const doc = (command: unknown, ageMs = 1_000): HostCommandDoc =>
  ({
    _id: `c${Math.random()}`,
    type: (command as { type: string }).type,
    command,
    status: "processing",
    created_at: new Date(NOW - ageMs),
    created_by: "owner",
    processed_at: null,
    result: null,
    error: null,
  }) as HostCommandDoc

/** A queue of commands and the outcomes written back. */
const fakeStore = (docs: HostCommandDoc[]) => {
  const outcomes: { type: string; status: string; result: string | null; error: string | null }[] = []
  const store: Pick<HostStore, "nextCommand" | "finish"> = {
    nextCommand: async () => {
      const d = docs.shift()
      return d ? { db: {} as never, doc: d } : null
    },
    finish: async (_db, d, status, result, error) => {
      outcomes.push({ type: d.type, status, result, error })
    },
  }
  return { store, outcomes }
}

const targets = (over: Partial<CommandTargets> = {}): CommandTargets => ({
  fans: { update: async (s) => ({ control: "agent", mode: s.mode, manual_pct: s.manual_pct, target_pct: s.manual_pct, temperature_c: 40, fans: [{ id: "a", name: "Fan #1", rpm: 900 }], error: null }) },
  settings: { save: async (s) => s },
  power: { discover: async () => [{ id: "cid", name: "Server", model: "ESW15-USA" }] },
  onSettings: () => undefined,
  ...over,
})

describe("drainCommands", () => {
  it("answers each command with what it did", async () => {
    const onSettings = vi.fn()
    const { store, outcomes } = fakeStore([
      doc({ type: "fans.set", mode: "manual", manual_pct: 70 }),
      doc({ type: "settings.update", settings: { ...DEFAULT_HOST_SETTINGS, price_per_kwh: 0.45 } }),
      doc({ type: "outlets.discover" }),
    ])
    await drainCommands(store, targets({ onSettings }), quiet, () => NOW)
    expect(outcomes).toEqual([
      { type: "fans.set", status: "done", result: "Manual speed 70% is set on 1 fan. Saved for restarts; the RPMs can take a few seconds to follow.", error: null },
      { type: "settings.update", status: "done", result: "Settings saved.", error: null },
      { type: "outlets.discover", status: "done", result: "Found 1: Server (ESW15-USA).", error: null },
    ])
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ price_per_kwh: 0.45 }))
  })

  it("rejects an invalid command, and one that waited too long", async () => {
    const update = vi.fn()
    const { store, outcomes } = fakeStore([doc({ type: "fans.set", mode: "manual", manual_pct: 10 }), doc({ type: "fans.set", mode: "manual", manual_pct: 70 }, 3 * 60_000)])
    await drainCommands(store, targets({ fans: { update } }), quiet, () => NOW)
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"])
    expect(outcomes[0].error).toMatch(/manual_pct/)
    expect(outcomes[1].error).toMatch(/Expired/)
    expect(update).not.toHaveBeenCalled()
  })

  it("reports a failure", async () => {
    const { store, outcomes } = fakeStore([doc({ type: "fans.set", mode: "curve", manual_pct: 70 })])
    await drainCommands(store, targets({ fans: { update: async () => Promise.reject(new Error("No connected motherboard fans with RPM feedback.")) } }), quiet, () => NOW)
    expect(outcomes).toEqual([{ type: "fans.set", status: "failed", result: null, error: "No connected motherboard fans with RPM feedback." }])
  })
})
