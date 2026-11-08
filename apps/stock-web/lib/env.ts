import "server-only"
import { dashboardEnv } from "@mb/web-kit/env"

/**
 * Server-side environment for the dashboard (its container on the server), with StockMarketBot's database name (@mb/web-kit/env).
 * Nothing here is ever sent to the browser.
 */
export const env = dashboardEnv({ dbName: "stockmarketbot" })
