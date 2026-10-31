import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { DEFAULT_HOST_SETTINGS, sampleId, type HostSampleDoc, type HostStatusDoc } from "@mb/core/host"
import { afterEach, describe, expect, it } from "vitest"
import { HostStore } from "../src/store"

const S = 1_000
const M = 60 * S
const H = 60 * M
const D = 24 * H
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0)

/** A sample `ago` ms before NOW. */
const sample = (res: HostSampleDoc["res"], ago: number, over: Partial<HostSampleDoc> = {}): HostSampleDoc => ({
  _id: sampleId(res, NOW - ago),
  res,
  t: new Date(NOW - ago),
  cpu: 10,
  cpu_temp: 40,
  memory: 50,
  watts: 100,
  gpus: [{ id: "GPU-a", model: "RTX 3070", util: 20, temp: 50 }],
  wh: res === "1m" ? 1.5 : null,
  covered_ms: res === "1m" ? M : 0,
  outlet_id: "o",
  ...over,
})

const status = (at: number) => ({ _id: "current", at: new Date(at), settings: DEFAULT_HOST_SETTINGS }) as unknown as HostStatusDoc

const files: string[] = []
afterEach(() => {
  for (const f of files.splice(0)) for (const suffix of ["", "-wal", "-shm"]) rmSync(f + suffix, { force: true })
})

describe("HostStore", () => {
  it("keeps the latest reading, and the samples, replacing a rewritten bucket unless told to keep it", () => {
    const store = new HostStore(":memory:")
    expect(store.latest()).toBeNull()
    store.write(status(NOW), [sample("raw", 0)])
    expect(store.latest()).toEqual(status(NOW))
    store.writeSamples([sample("raw", 0, { cpu: 90 })])
    expect(store.history("5m", NOW).points.map((p) => p.cpu)).toEqual([90])
    store.writeSamples([sample("raw", 0, { cpu: 5 })], { keep: true })
    expect(store.history("5m", NOW)).toEqual({ range: "5m", points: [{ t: NOW, cpu: 90, cpu_temp: 40, memory: 50, watts: 100, gpus: { "GPU-a": { util: 20, temp: 50 } } }], gpus: [{ id: "GPU-a", model: "RTX 3070" }] })
  })

  it("averages a range's samples into its bins, past missing values", () => {
    const store = new HostStore(":memory:")
    // The hour view bins raw samples by 10 s.
    store.writeSamples([
      sample("raw", 9 * S, { cpu: 10, gpus: [{ id: "GPU-a", model: "RTX 3070", util: null, temp: 50 }] }),
      sample("raw", 8 * S, { cpu: null, gpus: [{ id: "GPU-a", model: "RTX 3070", util: 40, temp: 60 }] }),
      sample("raw", 7 * S, { cpu: 30, gpus: [] }),
      sample("raw", 11 * S, { cpu: 50 }),
      sample("raw", 2 * H, { cpu: 99 }),
    ])
    expect(store.history("1h", NOW).points.map(({ t, cpu, gpus }) => ({ t, cpu, gpus }))).toEqual([
      { t: NOW - 20 * S, cpu: 50, gpus: { "GPU-a": { util: 20, temp: 50 } } },
      { t: NOW - 10 * S, cpu: 20, gpus: { "GPU-a": { util: 40, temp: 55 } } },
    ])
  })

  it("sums the outlet's recorded energy per window, a minute without energy counting its coverage", () => {
    const store = new HostStore(":memory:")
    store.writeSamples([
      sample("1m", H, { wh: 10 }),
      sample("1m", 13 * H, { wh: 20 }),
      sample("1m", 2 * D, { wh: 30 }),
      sample("1m", 10 * D, { wh: 40 }),
      sample("1m", 5 * M, { wh: null, covered_ms: 30 * S }),
      sample("1m", 2 * H, { wh: 99, outlet_id: "other" }),
      sample("1m", 31 * D, { wh: 99 }),
      sample("raw", M, { wh: 99 }),
    ])
    expect(store.energy("o", NOW, NOW - 12 * H)).toEqual({
      today_recorded_kwh: 0.01,
      last_24h: { kwh: 0.03, recorded_ms: 2 * M + 30 * S, window_ms: D },
      last_7d: { kwh: 0.06, recorded_ms: 3 * M + 30 * S, window_ms: 7 * D },
      last_30d: { kwh: 0.1, recorded_ms: 4 * M + 30 * S, window_ms: 30 * D },
    })
    expect(store.energy("none", NOW, NOW - 12 * H).last_24h).toEqual({ kwh: null, recorded_ms: 0, window_ms: D })
  })

  it("deletes minute samples and commands after 30 days and raw samples after the hour, once a minute", () => {
    const file = join(tmpdir(), `host-store-${randomUUID()}.sqlite`)
    files.push(file)
    const store = new HostStore(file)
    store.writeSamples([sample("raw", 66 * M), sample("raw", M), sample("1m", 30 * D + M), sample("1m", 29 * D)])
    store.addCommand({ _id: "old", type: "outlets.discover", command: { type: "outlets.discover" }, status: "done", created_at: new Date(NOW - 31 * D), created_by: "owner", processed_at: null, result: null, error: null })
    store.addCommand({ _id: "new", type: "outlets.discover", command: { type: "outlets.discover" }, status: "done", created_at: new Date(NOW - D), created_by: "owner", processed_at: null, result: null, error: null })
    const reader = new DatabaseSync(file, { readOnly: true })
    const ids = () => (reader.prepare("SELECT id FROM samples ORDER BY t").all() as { id: string }[]).map((r) => r.id)
    store.prune(NOW)
    expect(ids()).toEqual([sampleId("1m", NOW - 29 * D), sampleId("raw", NOW - M)])
    expect([store.command("old"), store.command("new")?._id]).toEqual([null, "new"])
    // Once a minute: a sample a pass 30 s later would delete waits for the next one.
    const late = sample("raw", 65 * M - 15 * S)
    store.writeSamples([late])
    store.prune(NOW + 30 * S)
    expect(ids()).toContain(late._id)
    store.prune(NOW + M)
    expect(ids()).not.toContain(late._id)
    reader.close()
    store.close()
  })

  it("keeps a command with its outcome, and refuses an id twice", () => {
    const store = new HostStore(":memory:")
    const doc = { _id: "c1", type: "fans.set" as const, command: { type: "fans.set" as const, mode: "manual" as const, manual_pct: 70 }, status: "pending" as const, created_at: new Date(NOW), created_by: "owner", processed_at: null, result: null, error: null }
    expect(store.addCommand(doc)).toBe(true)
    expect(store.addCommand(doc)).toBe(false)
    expect(store.command("c1")).toEqual({ _id: "c1", type: "fans.set", status: "pending", result: null, error: null })
    store.setCommand("c1", "done", "Manual speed 70% is set on 3 fans.", null)
    expect(store.command("c1")).toEqual({ _id: "c1", type: "fans.set", status: "done", result: "Manual speed 70% is set on 3 fans.", error: null })
    expect(store.command("missing")).toBeNull()
  })
})
