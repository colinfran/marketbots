import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { HOST_DB } from "@mb/core/host"
import { z } from "zod"

/**
 * The agent's configuration: `.env.host` at the repo root (template `.env.host.example`), loaded by
 * Node's `--env-file` (docs/SERVER.md §11). Secrets: the MongoDB URI and the VeSync login.
 */

/** apps/host-agent: the bundle runs from dist/, the sources from src/. */
export const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url))

const schema = z.object({
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  /** The databases the agent writes into and takes commands from, comma-separated: its own (HOST_DB), which both dashboards read. */
  HOST_DATABASES: z
    .string()
    .default(HOST_DB)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().regex(/^[\w-]+$/)).min(1)),
  /** Settings, fan settings and logs. */
  HOST_DATA_DIR: z.string().default(join(AGENT_DIR, "data")),
  /** LibreHardwareMonitor's connection file (port and login), written by scripts/install-sensors.ps1. */
  LHM_CONNECTION_FILE: z.string().default(""),
  /** on: the agent sets the motherboard fans; off: it only reads them. Never on while another app controls the fans. */
  FAN_CONTROL: z.enum(["on", "off"]).default("off"),
  VESYNC_USERNAME: z.string().default(""),
  VESYNC_PASSWORD: z.string().default(""),
  VESYNC_TIMEZONE: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  VESYNC_COUNTRY_CODE: z.string().default("US"),
  VESYNC_REFRESH_MS: z.coerce.number().int().min(15_000).max(3_600_000).default(60_000),
})

export type Env = z.infer<typeof schema> & { LHM_CONNECTION_FILE: string }

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  const parsed = schema.safeParse(source)
  if (!parsed.success) throw new Error(`.env.host: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
  const env = parsed.data
  return { ...env, LHM_CONNECTION_FILE: env.LHM_CONNECTION_FILE || join(env.HOST_DATA_DIR, "lhm.json") }
}
