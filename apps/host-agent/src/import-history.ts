import { access, readFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { HOST_MINUTE_KEEP_MS, hostSettingsSchema, type HostSampleDoc } from "@mb/core/host"
import { loadEnv } from "./env"
import { errorMessage, log } from "./log"
import { MinuteSamples } from "./samples"
import { SettingsFile } from "./settings"
import { HostStore } from "./store"

/**
 * One-off (docs/SERVER.md §11): imports the Jellyfin System Monitor's history into the agent's minute
 * samples (store.ts), so the 30-day charts and energy totals start full. It reads the
 * old monitor's SQLite file (2-second readings) and its settings.json, both copied out of its Docker
 * volume:
 *
 *   pnpm --filter @mb/host-agent import-history <dir with history.sqlite and settings.json> [--replace]
 *
 * Readings older than 30 days are skipped (they would expire at once). A minute the agent already
 * recorded is kept as it is; with --replace, an earlier import's minutes are rewritten too (only
 * safe while the old history ends before the agent's first reading). The old monitor's readings from
 * before it listed every card carry the first card alone (`gpu`, without its UUID): it is matched to
 * its UUID by model from the later readings. The old settings (price, currency, outlet, interval)
 * become the agent's only if it has none yet.
 */

type Row = {
  timestamp: number
  segment: string
  cpu: number | null
  cpuTemperature: number | null
  memory: number | null
  watts: number | null
  outletDeviceId: string | null
  gpus: string | null
  gpu: number | null
  gpuTemperature: number | null
  gpuModel: string | null
}

type OldGpu = { id?: string; model?: string; utilization?: number | null; temperatureC?: number | null }

async function main() {
  const dir = process.argv[2]
  if (!dir) throw new Error("usage: import-history <folder with history.sqlite and settings.json> [--replace]")
  const replace = process.argv.includes("--replace")
  const env = loadEnv()

  const settings = new SettingsFile(join(env.HOST_DATA_DIR, "settings.json"))
  const hasSettings = await access(join(env.HOST_DATA_DIR, "settings.json")).then(
    () => true,
    () => false,
  )
  if (!hasSettings) {
    const old = await readFile(join(dir, "settings.json"), "utf8").then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      () => null,
    )
    if (old) {
      const next = hostSettingsSchema.parse({
        interval_ms: old.pollIntervalMs,
        price_per_kwh: old.electricityPricePerKwh,
        currency: old.currency,
        outlet_id: typeof old.vesyncOutletDeviceId === "string" && old.vesyncOutletDeviceId ? old.vesyncOutletDeviceId : null,
      })
      await settings.save(next)
      log.info("settings imported", { price_per_kwh: next.price_per_kwh, currency: next.currency, interval_ms: next.interval_ms, outlet: !!next.outlet_id })
    }
  }

  const store = new HostStore(join(env.HOST_DATA_DIR, "host.sqlite"))
  const sqlite = new DatabaseSync(join(dir, "history.sqlite"), { readOnly: true })
  // Each card's UUID by model, from the newest reading that lists every card.
  const newest = sqlite.prepare("SELECT json_extract(snapshot, '$.gpus') AS gpus FROM samples WHERE json_extract(snapshot, '$.gpus') IS NOT NULL ORDER BY timestamp DESC LIMIT 1").get() as
    | { gpus: string }
    | undefined
  const idByModel = new Map(((newest ? JSON.parse(newest.gpus) : []) as OldGpu[]).filter((g) => g.id && g.model).map((g) => [g.model!, g.id!]))
  const rows = sqlite
    .prepare(
      `SELECT timestamp, segment, cpu, cpuTemperature, memory, watts, outletDeviceId, json_extract(snapshot, '$.gpus') AS gpus,
              gpu, gpuTemperature, json_extract(snapshot, '$.gpu.model') AS gpuModel
       FROM samples WHERE timestamp >= ? ORDER BY timestamp`,
    )
    .iterate(Date.now() - HOST_MINUTE_KEEP_MS) as Iterable<Row>

  const minutes = new MinuteSamples()
  let batch: HostSampleDoc[] = []
  let segment: string | null = null
  let readings = 0
  let written = 0
  const flush = () => {
    store.writeSamples(batch, { keep: !replace })
    written += batch.length
    batch = []
  }
  for (const r of rows) {
    const listed = r.gpus ? (JSON.parse(r.gpus) as OldGpu[]) : r.gpuModel && idByModel.has(r.gpuModel) ? [{ id: idByModel.get(r.gpuModel), model: r.gpuModel, utilization: r.gpu, temperatureC: r.gpuTemperature }] : []
    const gpus = listed.filter((g) => g.id && g.model).map((g) => ({ id: g.id!, model: g.model!, util: g.utilization ?? null, temp: g.temperatureC ?? null }))
    batch.push(...minutes.add({ t: r.timestamp, cpu: r.cpu, cpu_temp: r.cpuTemperature, memory: r.memory, watts: r.watts, outlet_id: r.outletDeviceId, gpus }, { gap: r.segment !== segment }))
    segment = r.segment
    if (++readings % 50_000 === 0) log.info("importing", { readings, minutes: written + batch.length })
    if (batch.length >= 1_000) flush()
  }
  batch.push(...minutes.flush())
  flush()
  sqlite.close()
  store.close()
  log.info("history imported", { readings, minutes: written })
}

main().catch((e) => {
  log.error("history import failed", { error: errorMessage(e) })
  process.exit(1)
})
