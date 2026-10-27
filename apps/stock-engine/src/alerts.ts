import { randomUUID } from "node:crypto"
import type { NotificationDoc } from "@mb/stock-core/db"
import type { EventBus } from "./bus/event-bus"
import type { Collections } from "./db/mongo"
import { errorMessage, scrub, type Logger } from "./log"

/**
 * Notifications: always stored for the dashboard and streamed as an `alert` event; warnings and
 * errors are also posted to Discord (DISCORD_WEBHOOK_URL) with a link back to the relevant page.
 * Identical alerts are sent at most once per 15 minutes. Never throws: alerting must not break
 * trading.
 *
 * Success messages (a purchase went through) go to Discord only: the fill is already stored and
 * streamed, so there's nothing to add to the dashboard.
 */

export type AlertLevel = NotificationDoc["level"]

export type AlertOptions = {
  /** Path on the dashboard (e.g. "/journal/2026-10-26") to link the alert to. */
  path?: string
  /** Dedupe key; defaults to title + message. */
  key?: string
  fields?: Record<string, string | number | null | undefined>
}

const DEDUPE_MS = 15 * 60_000
const COLORS: Record<AlertLevel, number> = { info: 0x2563eb, warning: 0xf59e0b, error: 0xdc2626, critical: 0x7f1d1d }
const ICONS: Record<AlertLevel, string> = { info: "ℹ️", warning: "⚠️", error: "🚨", critical: "🛑" }
const SUCCESS_COLOR = 0x16a34a

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

type Embed = { title: string; description: string; color: number; path?: string; fields?: AlertOptions["fields"] }

export class Alerts {
  private readonly recent = new Map<string, number>()

  constructor(
    private readonly col: Pick<Collections, "notifications">,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly webhook: string | null,
    private readonly dashboardUrl: string | null,
  ) {}

  async send(level: AlertLevel, title: string, message: string, { path, key, fields }: AlertOptions = {}) {
    const cleanMessage = scrub(message).slice(0, 2_000)
    if (this.isDuplicate(key ?? `${title}|${cleanMessage}`)) return
    this.log[level === "info" ? "info" : level === "warning" ? "warn" : "error"](`alert: ${title}`, { message: cleanMessage })

    this.bus.emit("alert", { level, title, message: cleanMessage }, { summary: title, level: level === "info" ? "info" : level === "warning" ? "warn" : "error" })
    try {
      const now = new Date()
      await this.col.notifications.insertOne({ _id: randomUUID(), at: now, level, title, message: cleanMessage, expires_at: new Date(now.getTime() + 90 * 86_400_000) })
    } catch (error) {
      this.log.warn("storing notification failed", { error: errorMessage(error) })
    }
    if (level === "info") return
    await this.post({ title: `${ICONS[level]} ${title}`, description: cleanMessage, color: COLORS[level], path, fields })
  }

  /** A green Discord message, e.g. for a filled buy. `key` (the order id) stops repeats. */
  async success(title: string, message: string, { path, key, fields }: AlertOptions = {}) {
    const cleanMessage = scrub(message).slice(0, 2_000)
    if (this.isDuplicate(key ?? `${title}|${cleanMessage}`)) return
    this.log.info(`success: ${title}`, { message: cleanMessage })
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
    const payload = JSON.stringify({
      username: "StockMarketBot",
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: clip(title, 256),
          description: clip(description, 3_500),
          color,
          url: this.dashboardUrl && path ? `${this.dashboardUrl.replace(/\/$/, "")}${path}` : undefined,
          fields: Object.entries(fields)
            .filter(([, value]) => value !== null && value !== undefined && value !== "")
            .slice(0, 20)
            .map(([name, value]) => ({ name: clip(name, 256), value: clip(scrub(String(value)), 1_000), inline: String(value).length < 40 })),
          timestamp: new Date().toISOString(),
        },
      ],
    })
    // One retry for rate limits and server errors.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(this.webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: AbortSignal.timeout(5_000) })
        if (res.ok) return
        if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
          await new Promise((r) => setTimeout(r, 1_000))
          continue
        }
        this.log.warn("discord webhook rejected alert", { status: res.status })
        return
      } catch (error) {
        if (attempt >= 2) this.log.warn("discord alert failed", { error: errorMessage(error) })
      }
    }
  }
}
