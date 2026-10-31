import { join } from "node:path"
import { HOST_MINUTE_KEEP_MS, HOST_RAW_KEEP_MS, type HostSampleDoc } from "@mb/core/host"
import { MongoClient } from "mongodb"
import { loadEnv } from "./env"
import { errorMessage, log } from "./log"
import { HostStore } from "./store"

/**
 * One-off (docs/SERVER.md §11, 2026-10-31): copies the chart samples the agent used to write into the
 * bots' cluster (database `serverstats`) into its local store, so the 30-day charts and energy totals
 * carry on. A sample already kept locally stays as it is. Reads MONGODB_URI (SHARED):
 *
 *   pnpm --filter @mb/host-agent migrate-serverstats
 */

async function main() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error("MONGODB_URI is required")
  const env = loadEnv()
  const store = new HostStore(join(env.HOST_DATA_DIR, "host.sqlite"))
  const client = new MongoClient(uri, { appName: "marketbots-host-migrate", maxPoolSize: 2 })
  const now = Date.now()
  const cursor = client
    .db("serverstats")
    .collection<HostSampleDoc>("host_samples")
    .find({ $or: [{ res: "1m", t: { $gte: new Date(now - HOST_MINUTE_KEEP_MS) } }, { res: "raw", t: { $gte: new Date(now - HOST_RAW_KEEP_MS) } }] })
  const copied = { raw: 0, "1m": 0 }
  let batch: HostSampleDoc[] = []
  const flush = () => {
    store.writeSamples(batch, { keep: true })
    for (const s of batch) copied[s.res]++
    batch = []
  }
  for await (const { _id, res, t, cpu, cpu_temp, memory, watts, gpus, wh, covered_ms, outlet_id } of cursor) {
    batch.push({ _id, res, t, cpu, cpu_temp, memory, watts, gpus, wh, covered_ms, outlet_id })
    if (batch.length >= 1_000) flush()
  }
  flush()
  await client.close()
  store.close()
  log.info("serverstats copied", { minute_samples: copied["1m"], raw_samples: copied.raw })
}

main().catch((e) => {
  log.error("serverstats copy failed", { error: errorMessage(e) })
  process.exit(1)
})
