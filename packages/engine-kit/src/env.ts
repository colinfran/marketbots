import { hostname } from "node:os"
import { z } from "zod"

/**
 * Process environment: infrastructure and secrets only. Trading behavior (risk limits, budgets,
 * schedules) lives in the bot's MongoDB settings document so it can be changed from the dashboard
 * with an audit trail.
 *
 * `envFields` are the variables both engines read. Each bot builds its schema from them and its own
 * variables, in its own order (the order of the fields is the order problems are listed in).
 */

/** "1", "true", "yes" or "on" (any case) is true; unset or empty is `fallback`. */
export const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())))

/** A trimmed value, or null when unset or blank. */
export const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))

/** The variables both engines read; the database name and stream port default to the bot's own. */
export const envFields = ({ dbName, streamPort }: { dbName: string; streamPort: number }) => ({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** A folder for the log history, one file per UTC day; in compose, logs/<service>/ on the host. Unset: stdout only. */
  LOG_DIR: optional,
  ENGINE_INSTANCE: z.string().default(hostname()),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_DB_NAME: z.string().default(dbName),

  /** Shared with the Vercel app, which mints the short-lived stream tokens. */
  STREAM_TOKEN_SECRET: z.string().min(32, "STREAM_TOKEN_SECRET must be at least 32 characters"),
  STREAM_HOST: z.string().default("0.0.0.0"),
  STREAM_PORT: z.coerce.number().int().min(1).max(65_535).default(streamPort),
  /** Comma-separated browser origins allowed to open the stream: the dashboard's, e.g. https://<bot>.app */
  STREAM_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean)),
  /** Set when a reverse proxy sits in front, so per-IP limits use X-Forwarded-For. */
  STREAM_TRUST_PROXY: bool(false),
  STREAM_MAX_CLIENTS: z.coerce.number().int().min(1).max(10_000).default(100),

  DISCORD_WEBHOOK_URL: optional,
  DASHBOARD_URL: optional,

  EVENT_RETENTION_DAYS: z.coerce.number().min(1).max(3650).default(30),

  /** News engine. A source whose key is missing stays off; nothing else breaks. */
  /** "Name contact-email", required by the SEC's fair-access policy; also the wire's User-Agent. */
  SEC_USER_AGENT: optional,
  FINNHUB_API_KEY: optional,
  FRED_API_KEY: optional,
  BLS_API_KEY: optional,
  /** The headless scraper sidecar, e.g. http://scraper:8790 inside docker compose. Unset: headless sources stay off. */
  SCRAPER_URL: optional,
  /** The local model server (llama.cpp, OpenAI-compatible), e.g. http://llm:8080 inside docker compose. Unset: no AI at all (no summaries, research or decisions; positions stay protected). */
  LLM_URL: optional,
  /** The search service (SearXNG) for local research, e.g. http://search:8080 inside docker compose. Unset: local models can't research. */
  SEARCH_URL: optional,
  /** Tavily's search API, for research's thin searches (in .env.search, shared by both bots). Unset: no Tavily. */
  TAVILY_API_KEY: optional,
  /** The bot's own history database (postgres://…@history:5432/<bot>_history), a secret. Unset: no history is kept. */
  HISTORY_URL: optional,
})

/** A connection URL's password, so the logger can scrub it even where the URL appears in pieces. */
export const urlPassword = (url: string | null | undefined): string | undefined => {
  if (!url) return undefined
  try {
    return decodeURIComponent(new URL(url).password) || undefined
  } catch {
    return undefined
  }
}

/** The shared variables, parsed. */
export type BaseEnv = z.infer<z.ZodObject<ReturnType<typeof envFields>>>

/**
 * Parses the environment with the bot's schema. Every value is trimmed first (.env files edited on
 * Windows often end lines with \r), and every problem is listed in one readable error.
 */
export const parseEnv = <S extends z.ZodType>(schema: S, source: NodeJS.ProcessEnv = process.env): z.output<S> => {
  const trimmed = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]))
  const parsed = schema.safeParse(trimmed)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")
    throw new Error(`Invalid engine environment:\n${problems}`)
  }
  return parsed.data
}
