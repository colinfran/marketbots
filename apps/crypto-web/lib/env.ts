import "server-only"
import { dashboardEnv } from "@mb/web-kit/env"

/**
 * Server-side environment for the dashboard (Vercel), with CryptoMarketBot's defaults (@mb/web-kit/env).
 * Nothing here is ever sent to the browser.
 */
export const env = dashboardEnv({ dbName: "cryptomarketbot", appName: "CryptoMarketBot" })
