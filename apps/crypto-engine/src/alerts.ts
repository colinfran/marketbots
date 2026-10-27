import { randomUUID } from "node:crypto"
import type { NotificationDoc } from "@mb/crypto-core/db"
import type { EventBus } from "./bus/event-bus"
import type { Collections } from "./db/mongo"
import { errorMessage, scrub, type Logger } from "./log"

/**
 * Notifications: always stored for the dashboard and streamed as an `alert` event; optionally
 * posted to Discord (DISCORD_WEBHOOK_URL), the same channel stockmarketbot uses. Identical alerts
 * are sent at most once per 15 minutes. Never throws: alerting must not break trading.
 *
 * Success messages (a purchase went through) go to Discord only: the fill is already stored and
 * streamed, so there's nothing to add to the dashboard.
 */

const DEDUPE_MS = 15 * 60_000
const COLORS: Record<NotificationDoc["level"], number> = { info: 0x2563eb, warning: 0xf59e0b, error: 0xdc2626, critical: 0x7f1d1d }
const SUCCESS_COLOR = 0x16a34a

export type AlertFields = Record<string, string | number | null | undefined>

type Embed = { title: string; description: string; color: number; path?: string; fields?: AlertFields }

export class Alerts {
  private readonly recent = new Map<string, number>()

  constructor(
    private readonly col: Pick<Collections, "notifications">,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly webhook: string | null,
    private readonly dashboardUrl: string | null,
  ) {}

  async send(level: NotificationDoc["level"], title: string, message: string, { path, key }: { path?: string; key?: string } = {}) {
    const cleanMessage = scrub(message).slice(0, 2_000)
    if (this.isDuplicate(key ?? `${title}|${cleanMessage}`)) return

    this.bus.emit("alert", { level, title, message: cleanMessage }, { summary: title, level: level === "info" ? "info" : level === "warning" ? "warn" : "error" })
    try {
      const now = new Date()
      await this.col.notifications.insertOne({ _id: randomUUID(), at: now, level, title, message: cleanMessage, expires_at: new Date(now.getTime() + 90 * 86_400_000) })
    } catch (error) {
      this.log.warn("storing notification failed", { error: errorMessage(error) })
    }
    if (level === "info") return
    await this.post({ title, description: cleanMessage, color: COLORS[level], path })
  }

  /** A green Discord message, e.g. for a filled buy. `key` (the order id) stops repeats. */
  async success(title: string, message: string, { path, key, fields }: { path?: string; key?: string; fields?: AlertFields } = {}) {
    const cleanMessage = scrub(message).slice(0, 2_000)
    if (this.isDuplicate(key ?? `${title}|${cleanMessage}`)) return
    await this.post({ title: `✅ ${title}`, description: cleanMessage, color: SUCCESS_COLOR, path, fields })
  }

  private isDuplicate(key: string) {
    const last = this.recent.get(key)
    if (last && Date.now() - last < DEDUPE_MS) return true
    this.recent.set(key, Date.now())
    return false
  }

  private async post({ title, description, color, path, fields = {} }: Embed) {
    if (!this.webhook) return
    try {
      const res = await fetch(this.webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "CryptoMarketBot",
          allowed_mentions: { parse: [] },
          embeds: [
            {
              title: title.slice(0, 256),
              description: description.slice(0, 3_500),
              color,
              url: this.dashboardUrl && path ? `${this.dashboardUrl.replace(/\/$/, "")}${path}` : undefined,
              fields: Object.entries(fields)
                .filter(([, value]) => value !== null && value !== undefined && value !== "")
                .slice(0, 20)
                .map(([name, value]) => ({ name: name.slice(0, 256), value: scrub(String(value)).slice(0, 1_000), inline: String(value).length < 40 })),
              timestamp: new Date().toISOString(),
            },
          ],
        }),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) this.log.warn("discord webhook rejected alert", { status: res.status })
    } catch (error) {
      this.log.warn("discord alert failed", { error: errorMessage(error) })
    }
  }
}
