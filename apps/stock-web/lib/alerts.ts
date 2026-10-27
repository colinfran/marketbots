import "server-only"
import { env } from "./env"
import { site } from "./site"

/**
 * Unhandled dashboard errors go to the same Discord channel as the engine's alerts
 * (DISCORD_WEBHOOK_URL), at most once per 15 minutes per error on each server instance.
 * Never throws.
 */

const DEDUPE_MS = 15 * 60_000
const recent = new Map<string, number>()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const sendAlert = async ({ title, message, fields = {}, path, key }: { title: string; message: string; fields?: Record<string, string | undefined>; path?: string; key?: string }) => {
  console.error(`[alert] ${title}: ${message}`)
  const webhook = env.discordWebhookUrl()
  if (!webhook) return
  const dedupe = key ?? `${title}|${message}`
  const last = recent.get(dedupe)
  if (last && Date.now() - last < DEDUPE_MS) return
  recent.set(dedupe, Date.now())
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `${site.name} dashboard`,
        allowed_mentions: { parse: [] },
        embeds: [
          {
            title: clip(`🚨 ${title}`, 256),
            description: clip(message, 3_500),
            color: 0xdc2626,
            url: path ? `${site.url}${path}` : undefined,
            fields: Object.entries(fields)
              .filter(([, v]) => v)
              .map(([name, value]) => ({ name, value: clip(String(value), 1_000), inline: true })),
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (error) {
    console.error("[alert] Discord webhook failed:", errorMessage(error))
  }
}
