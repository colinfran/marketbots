import { envFields, optional, parseEnv, urlPassword } from "@mb/engine-kit/env"
import { z } from "zod"

/**
 * Process environment: infrastructure and secrets only. Trading behavior (risk limits, options
 * rules, budgets, schedules) lives in the MongoDB settings document so it can be changed from the
 * dashboard with an audit trail. The variables both engines read come from @mb/engine-kit/env.
 *
 * The Alpaca keys are for a PAPER account: the client only ever talks to Alpaca's paper endpoint.
 */

const base = envFields({ dbName: "stockmarketbot", streamPort: 8788 })

const envSchema = z.object({
  NODE_ENV: base.NODE_ENV,
  LOG_LEVEL: base.LOG_LEVEL,
  LOG_DIR: base.LOG_DIR,
  ENGINE_INSTANCE: base.ENGINE_INSTANCE,

  MONGODB_URI: base.MONGODB_URI,
  MONGODB_DB_NAME: base.MONGODB_DB_NAME,

  ALPACA_API_KEY: z.string().min(1, "ALPACA_API_KEY is required (paper account)"),
  ALPACA_SECRET_KEY: z.string().min(1, "ALPACA_SECRET_KEY is required (paper account)"),
  /** Alpaca's free market data feed. "sip" needs a paid data plan. */
  ALPACA_DATA_FEED: z.enum(["iex", "sip"]).default("iex"),

  STREAM_TOKEN_SECRET: base.STREAM_TOKEN_SECRET,
  STREAM_HOST: base.STREAM_HOST,
  STREAM_PORT: base.STREAM_PORT,
  STREAM_ALLOWED_ORIGINS: base.STREAM_ALLOWED_ORIGINS,
  STREAM_TRUST_PROXY: base.STREAM_TRUST_PROXY,
  STREAM_MAX_CLIENTS: base.STREAM_MAX_CLIENTS,

  DISCORD_WEBHOOK_URL: base.DISCORD_WEBHOOK_URL,
  DASHBOARD_URL: base.DASHBOARD_URL,

  EVENT_RETENTION_DAYS: base.EVENT_RETENTION_DAYS,

  /** Seed value for the settings document on first boot (the dashboard owns it afterwards). */
  STARTING_CAPITAL: z.coerce.number().min(100).max(10_000_000).optional(),

  SEC_USER_AGENT: base.SEC_USER_AGENT,
  FINNHUB_API_KEY: base.FINNHUB_API_KEY,
  FRED_API_KEY: base.FRED_API_KEY,
  BLS_API_KEY: base.BLS_API_KEY,
  OPENFDA_API_KEY: optional,
  MASSIVE_API_KEY: optional,
  EIA_API_KEY: optional,
  SCRAPER_URL: base.SCRAPER_URL,
  LLM_URL: base.LLM_URL,
  SEARCH_URL: base.SEARCH_URL,
  TAVILY_API_KEY: base.TAVILY_API_KEY,
  HISTORY_URL: base.HISTORY_URL,
})

export type Env = z.infer<typeof envSchema>

const WIRE_KEYS = ["SEC_USER_AGENT", "FINNHUB_API_KEY", "FRED_API_KEY", "BLS_API_KEY", "OPENFDA_API_KEY", "MASSIVE_API_KEY", "EIA_API_KEY", "SCRAPER_URL", "LLM_URL"] as const

/** The keys the news engine's sources may read. */
export const wireEnv = (env: Env): Record<string, string | undefined> => Object.fromEntries(WIRE_KEYS.map((k) => [k, env[k] ?? undefined]))

/** Parses the environment; every problem is listed in one readable error. */
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => parseEnv(envSchema, source)

/** Every secret value, so the logger can scrub it from any string that would otherwise leak it. */
export const secretValues = (env: Env): string[] =>
  [
    env.STREAM_TOKEN_SECRET,
    env.DISCORD_WEBHOOK_URL,
    env.MONGODB_URI,
    env.HISTORY_URL,
    urlPassword(env.HISTORY_URL),
    env.ALPACA_API_KEY,
    env.ALPACA_SECRET_KEY,
    env.FINNHUB_API_KEY,
    env.FRED_API_KEY,
    env.BLS_API_KEY,
    env.OPENFDA_API_KEY,
    env.MASSIVE_API_KEY,
    env.EIA_API_KEY,
    env.TAVILY_API_KEY,
  ].filter(
    (v): v is string => typeof v === "string" && v.length >= 8,
  )
