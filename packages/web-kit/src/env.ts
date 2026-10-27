import "server-only"

/**
 * Server-side environment for a dashboard (Vercel), under the variable names both bots use.
 * Nothing here is ever sent to the browser: the only value a browser sees is the public engine
 * stream URL, handed out with each token. Each app binds its own defaults (database name, sender).
 */

const read = (name: string) => {
  const v = process.env[name]?.trim()
  return v ? v : null
}

export const dashboardEnv = ({ dbName, appName }: { dbName: string; appName: string }) => ({
  mongoUri: () => read("MONGODB_URI"),
  mongoDb: () => read("MONGODB_DB_NAME") ?? dbName,
  /** Signs owner session cookies (32+ chars). Better Auth reads it itself; this only checks it's set. */
  betterAuthSecret: () => read("BETTER_AUTH_SECRET"),
  /** The only address that can sign in. Nobody else gets a sign-in link or an account. */
  ownerEmail: () => read("OWNER_EMAIL") ?? "colin.franceschini@gmail.com",
  /** useSend delivers the sign-in emails. */
  usesendApiKey: () => read("USESEND_API_KEY"),
  usesendBaseUrl: () => read("USESEND_BASE_URL") ?? "https://franceschini.email",
  usesendFrom: () => read("USESEND_FROM_EMAIL") ?? `${appName} <no-reply@colinfran.com>`,
  /** Shared with the engine; signs the short-lived stream tokens. */
  streamTokenSecret: () => read("STREAM_TOKEN_SECRET"),
  /** Public WebSocket URL of the engine behind your reverse proxy, e.g. wss://engine.example.com/v1/stream */
  engineStreamUrl: () => read("ENGINE_STREAM_URL"),
  /** Public URL of the dashboard; sign-in links point here. Defaults to the Vercel production domain. */
  siteUrl: () => read("SITE_URL") ?? (read("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${read("VERCEL_PROJECT_PRODUCTION_URL")}` : null),
  /** Optional: unhandled server errors on the dashboard are posted here. */
  discordWebhookUrl: () => read("DISCORD_WEBHOOK_URL"),
})

export type DashboardEnv = ReturnType<typeof dashboardEnv>
