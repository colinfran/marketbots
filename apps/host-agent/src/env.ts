import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

/**
 * The agent's configuration: the repo's `.env` (template `.env.example`), loaded by Node's
 * `--env-file` (docs/SERVER.md §11.1). It reads the SHARED section's HOST_API_SECRET and the HOST
 * section; the bots' variables in the file are ignored. Secrets: the API secret and the VeSync login.
 */

/** apps/host-agent: the bundle runs from dist/, the sources from src/. */
export const AGENT_DIR = fileURLToPath(new URL("..", import.meta.url))

const schema = z.object({
  /** The API's port on 127.0.0.1; Caddy publishes it at /host on each engine domain. */
  HOST_API_PORT: z.coerce.number().int().min(1).max(65_535).default(8789),
  /** Sent by the dashboards' servers with every request (SHARED). Empty: the API is off and Admin → Server can't reach the agent. */
  HOST_API_SECRET: z
    .string()
    .default("")
    .refine((v) => v === "" || v.length >= 32, "HOST_API_SECRET: 32+ characters"),
  /** Settings, fan settings, the readings' SQLite file and logs. */
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
  if (!parsed.success) throw new Error(`.env: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`)
  const env = parsed.data
  return { ...env, LHM_CONNECTION_FILE: env.LHM_CONNECTION_FILE || join(env.HOST_DATA_DIR, "lhm.json") }
}
