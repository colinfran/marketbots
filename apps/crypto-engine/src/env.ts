import { envFields, optional, parseEnv } from "@mb/engine-kit/env"
import { z } from "zod"

/**
 * Process environment: infrastructure and secrets only. Trading behavior (risk limits, budgets,
 * schedules) lives in the MongoDB settings document so it can be changed from the dashboard with
 * an audit trail. The variables both engines read come from @mb/engine-kit/env.
 *
 * The engine holds no exchange credentials: market data comes from Kraken's public API and every
 * order executes in a Kraken CLI paper workspace, which needs no keys.
 */

const base = envFields({ dbName: "cryptomarketbot", streamPort: 8787 })

const envSchema = z.object({
  NODE_ENV: base.NODE_ENV,
  LOG_LEVEL: base.LOG_LEVEL,
  ENGINE_INSTANCE: base.ENGINE_INSTANCE,

  MONGODB_URI: base.MONGODB_URI,
  MONGODB_DB_NAME: base.MONGODB_DB_NAME,

  STREAM_TOKEN_SECRET: base.STREAM_TOKEN_SECRET,
  STREAM_HOST: base.STREAM_HOST,
  STREAM_PORT: base.STREAM_PORT,
  STREAM_ALLOWED_ORIGINS: base.STREAM_ALLOWED_ORIGINS,
  STREAM_TRUST_PROXY: base.STREAM_TRUST_PROXY,
  STREAM_MAX_CLIENTS: base.STREAM_MAX_CLIENTS,

  AI_GATEWAY_API_KEY: base.AI_GATEWAY_API_KEY,

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

  DISCORD_WEBHOOK_URL: base.DISCORD_WEBHOOK_URL,
  DASHBOARD_URL: base.DASHBOARD_URL,

  EVENT_RETENTION_DAYS: base.EVENT_RETENTION_DAYS,

  GROK_RESEARCH_MODEL: base.GROK_RESEARCH_MODEL,
  GROK_DECISION_MODEL: base.GROK_DECISION_MODEL,

  SEC_USER_AGENT: base.SEC_USER_AGENT,
  FINNHUB_API_KEY: base.FINNHUB_API_KEY,
  FRED_API_KEY: base.FRED_API_KEY,
  BLS_API_KEY: base.BLS_API_KEY,
  COINGECKO_API_KEY: optional,
  ETHERSCAN_API_KEY: optional,
  COINALYZE_API_KEY: optional,
  SCRAPER_URL: base.SCRAPER_URL,
})

const WIRE_KEYS = ["SEC_USER_AGENT", "FINNHUB_API_KEY", "FRED_API_KEY", "BLS_API_KEY", "COINGECKO_API_KEY", "ETHERSCAN_API_KEY", "COINALYZE_API_KEY", "SCRAPER_URL"] as const

/** The keys the news engine's sources may read. */
export const wireEnv = (env: Env): Record<string, string | undefined> => Object.fromEntries(WIRE_KEYS.map((k) => [k, env[k] ?? undefined]))

export type Env = z.infer<typeof envSchema>

/** Parses the environment; every problem is listed in one readable error. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => parseEnv(envSchema, source)

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
