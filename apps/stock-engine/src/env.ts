import { hostname } from "node:os"
import { z } from "zod"

/**
 * Process environment: infrastructure and secrets only. Trading behavior (risk limits, options
 * rules, budgets, schedules) lives in the MongoDB settings document so it can be changed from the
 * dashboard with an audit trail.
 *
 * The Alpaca keys are for a PAPER account: the client only ever talks to Alpaca's paper endpoint.
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
  MONGODB_DB_NAME: z.string().default("stockmarketbot"),

  ALPACA_API_KEY: z.string().min(1, "ALPACA_API_KEY is required (paper account)"),
  ALPACA_SECRET_KEY: z.string().min(1, "ALPACA_SECRET_KEY is required (paper account)"),
  /** Alpaca's free market data feed. "sip" needs a paid data plan. */
  ALPACA_DATA_FEED: z.enum(["iex", "sip"]).default("iex"),

  /** Shared with the Vercel app, which mints the short-lived stream tokens. */
  STREAM_TOKEN_SECRET: z.string().min(32, "STREAM_TOKEN_SECRET must be at least 32 characters"),
  STREAM_HOST: z.string().default("0.0.0.0"),
  STREAM_PORT: z.coerce.number().int().min(1).max(65_535).default(8788),
  /** Comma-separated browser origins allowed to open the stream, e.g. https://stockmarketbot.app */
  STREAM_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)),
  /** Set when a reverse proxy sits in front, so per-IP limits use X-Forwarded-For. */
  STREAM_TRUST_PROXY: bool(false),
  STREAM_MAX_CLIENTS: z.coerce.number().int().min(1).max(10_000).default(100),

  /** Without it the engine runs and protects positions but makes no AI calls, so it never opens trades. */
  AI_GATEWAY_API_KEY: optional,

  DISCORD_WEBHOOK_URL: optional,
  DASHBOARD_URL: optional,

  EVENT_RETENTION_DAYS: z.coerce.number().min(1).max(3650).default(30),

  /** Seed values for the settings document on first boot (the dashboard owns them afterwards). */
  GROK_RESEARCH_MODEL: optional,
  GROK_DECISION_MODEL: optional,
  STARTING_CAPITAL: z.coerce.number().min(100).max(10_000_000).optional(),

  /** News engine (MASTER_PLAN §3.10). A source whose key is missing stays off; nothing else breaks. */
  /** "Name contact-email", required by the SEC's fair-access policy; also the wire's User-Agent. */
  SEC_USER_AGENT: optional,
  FINNHUB_API_KEY: optional,
  FRED_API_KEY: optional,
  BLS_API_KEY: optional,
  OPENFDA_API_KEY: optional,
  MASSIVE_API_KEY: optional,
  EIA_API_KEY: optional,
  /** The headless scraper sidecar (Phase 7), e.g. http://scraper:8790 inside docker compose. Unset: headless sources stay off. */
  SCRAPER_URL: optional,
})

export type Env = z.infer<typeof envSchema>

const WIRE_KEYS = ["SEC_USER_AGENT", "FINNHUB_API_KEY", "FRED_API_KEY", "BLS_API_KEY", "OPENFDA_API_KEY", "MASSIVE_API_KEY", "EIA_API_KEY", "SCRAPER_URL"] as const

/** The keys the news engine's sources may read. */
export const wireEnv = (env: Env): Record<string, string | undefined> => Object.fromEntries(WIRE_KEYS.map((k) => [k, env[k] ?? undefined]))

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
    env.ALPACA_API_KEY,
    env.ALPACA_SECRET_KEY,
    env.FINNHUB_API_KEY,
    env.FRED_API_KEY,
    env.BLS_API_KEY,
    env.OPENFDA_API_KEY,
    env.MASSIVE_API_KEY,
    env.EIA_API_KEY,
  ].filter(
    (v): v is string => typeof v === "string" && v.length >= 8,
  )
