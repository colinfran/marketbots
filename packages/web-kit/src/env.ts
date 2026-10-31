import "server-only"

/**
 * Server-side environment for a dashboard (Vercel), under the variable names both bots use.
 * Nothing here is ever sent to the browser: the only value a browser sees is the public engine
 * stream URL, handed out with each token. Each app binds its own default database name; the owner's
 * address and the email settings have no defaults and come only from the environment.
 */

const read = (name: string) => {
  const v = process.env[name]?.trim()
  return v ? v : null
}

export const dashboardEnv = ({ dbName }: { dbName: string }) => ({
  mongoUri: () => read("MONGODB_URI"),
  mongoDb: () => read("MONGODB_DB_NAME") ?? dbName,
  /** The host agent's API (Admin → Server), the same machine for both dashboards: e.g. https://engine.cryptomarketbot.app/host. */
  hostApiUrl: () => read("HOST_API_URL"),
  /** Sent with every call to the host agent's API; never to the browser. */
  hostApiSecret: () => read("HOST_API_SECRET"),
  /** Signs owner session cookies (32+ chars). Better Auth reads it itself; this only checks it's set. */
  betterAuthSecret: () => read("BETTER_AUTH_SECRET"),
  /** The only address that can sign in. Nobody else gets a sign-in link or an account. Without it, nobody can sign in. */
  ownerEmail: () => read("OWNER_EMAIL"),
  /** useSend delivers the sign-in emails; all three are needed to send one. */
  usesendApiKey: () => read("USESEND_API_KEY"),
  usesendBaseUrl: () => read("USESEND_BASE_URL"),
  usesendFrom: () => read("USESEND_FROM_EMAIL"),
  /** Shared with the engine; signs the short-lived stream tokens. */
  streamTokenSecret: () => read("STREAM_TOKEN_SECRET"),
  /** Public WebSocket URL of the engine behind your reverse proxy, e.g. wss://engine.example.com/v1/stream */
  engineStreamUrl: () => read("ENGINE_STREAM_URL"),
  /** Public URL of the dashboard; sign-in links point here. Defaults to the Vercel production domain. */
  siteUrl: () => read("SITE_URL") ?? (read("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${read("VERCEL_PROJECT_PRODUCTION_URL")}` : null),
  /** Optional: unhandled server errors on the dashboard are posted here. */
  discordWebhookUrl: () => read("DISCORD_WEBHOOK_URL"),
  /** Optional, all four or none: Azure Monitor's count of the database's storage (Admin → System; @mb/web-kit/azure). */
  azureTenantId: () => read("AZURE_TENANT_ID"),
  azureClientId: () => read("AZURE_CLIENT_ID"),
  azureClientSecret: () => read("AZURE_CLIENT_SECRET"),
  azureDocumentDbResourceId: () => read("AZURE_DOCUMENTDB_RESOURCE_ID"),
})

export type DashboardEnv = ReturnType<typeof dashboardEnv>
