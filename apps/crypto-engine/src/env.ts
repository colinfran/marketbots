import { hostname } from "node:os"
import { z } from "zod"

/**
 * Process environment: infrastructure and secrets only. Trading behavior (risk limits, budgets,
 * schedules) lives in the MongoDB settings document so it can be changed from the dashboard with
 * an audit trail.
 *
 * The engine holds no exchange credentials: market data comes from Kraken's public API and every
 * order executes in a Kraken CLI paper workspace, which needs no keys.
 */

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())))

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ENGINE_INSTANCE: z.string().default(hostname()),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB_NAME: z.string().default("cryptomarketbot"),

  /** Shared with the Vercel app, which mints the short-lived stream tokens. */
  STREAM_TOKEN_SECRET: z.string().min(32, "STREAM_TOKEN_SECRET must be at least 32 characters"),
  STREAM_HOST: z.string().default("0.0.0.0"),
  STREAM_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  /** Comma-separated browser origins allowed to open the stream, e.g. https://crypto.example.com */
  STREAM_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)),
  /** Set when a reverse proxy sits in front, so per-IP limits use X-Forwarded-For. */
  STREAM_TRUST_PROXY: bool(false),
  STREAM_MAX_CLIENTS: z.coerce.number().int().min(1).max(10_000).default(100),

  /** Without it the engine runs but makes no AI calls, so it never opens trades. */
  AI_GATEWAY_API_KEY: optional,

  /** Path to the Kraken CLI binary (installed in the Docker image at /usr/local/bin/kraken). */
  KRAKEN_CLI_PATH: z.string().default("kraken"),
  /** Paper workspace the engine trades in. Its state lives in the CLI's config directory. */
  KRAKEN_WORKSPACE: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "KRAKEN_WORKSPACE must be lowercase letters, digits and dashes")
    .default("cryptomarketbot"),
  KRAKEN_CLI_TIMEOUT_MS: z.coerce.number().int().min(2_000).max(120_000).default(20_000),
  /** Optional folder of Kraken OHLCVT CSV files for longer backtests (e.g. XBTUSD_60.csv). */
  BACKTEST_DATA_DIR: optional,

  DISCORD_WEBHOOK_URL: optional,
  DASHBOARD_URL: optional,

  EVENT_RETENTION_DAYS: z.coerce.number().min(1).max(3650).default(30),

  /** Seed values for the settings document on first boot (the dashboard owns them afterwards). */
  GROK_RESEARCH_MODEL: optional,
  GROK_DECISION_MODEL: optional,

  /** News engine (MASTER_PLAN §3.10). A source whose key is missing stays off; nothing else breaks. */
  /** "Name contact-email", required by the SEC's fair-access policy; also the wire's User-Agent. */
  SEC_USER_AGENT: optional,
  FINNHUB_API_KEY: optional,
  FRED_API_KEY: optional,
  BLS_API_KEY: optional,
  COINGECKO_API_KEY: optional,
  ETHERSCAN_API_KEY: optional,
  COINALYZE_API_KEY: optional,
  /** The headless scraper sidecar (Phase 7), e.g. http://scraper:8790 inside docker compose. Unset: headless sources stay off. */
  SCRAPER_URL: optional,
})

const WIRE_KEYS = ["SEC_USER_AGENT", "FINNHUB_API_KEY", "FRED_API_KEY", "BLS_API_KEY", "COINGECKO_API_KEY", "ETHERSCAN_API_KEY", "COINALYZE_API_KEY", "SCRAPER_URL"] as const

/** The keys the news engine's sources may read. */
export const wireEnv = (env: Env): Record<string, string | undefined> => Object.fromEntries(WIRE_KEYS.map((k) => [k, env[k] ?? undefined]))

export type Env = z.infer<typeof envSchema>

export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => {
  // Trim every value: .env files edited on Windows often end lines with \r.
  const trimmed = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]))
  const parsed = envSchema.safeParse(trimmed)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Invalid engine environment:\n${problems}`)
  }
  return parsed.data
}

/** Every secret value, so the logger can scrub it from any string that would otherwise leak it. */
export const secretValues = (env: Env): string[] =>
  [
    env.STREAM_TOKEN_SECRET,
    env.AI_GATEWAY_API_KEY,
    env.DISCORD_WEBHOOK_URL,
    env.MONGODB_URI,
    env.FINNHUB_API_KEY,
    env.FRED_API_KEY,
    env.BLS_API_KEY,
    env.COINGECKO_API_KEY,
    env.ETHERSCAN_API_KEY,
    env.COINALYZE_API_KEY,
  ].filter(
    (v): v is string => typeof v === "string" && v.length >= 8,
  )
