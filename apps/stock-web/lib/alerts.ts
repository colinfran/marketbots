import "server-only"
import { alerts } from "@mb/web-kit/alerts"
import { env } from "./env"
import { site } from "./site"

/** Unhandled dashboard errors, posted to DISCORD_WEBHOOK_URL when it's set (@mb/web-kit/alerts). */
export const { errorMessage, sendAlert } = alerts({ site, webhookUrl: env.discordWebhookUrl })
