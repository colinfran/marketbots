import { randomUUID } from "node:crypto"
import type { AiCallDoc } from "@mb/core/db"
import type { Collection } from "mongodb"

/**
 * The AI call log: every model call is recorded in `ai_calls` (task, model, tokens, time, outcome)
 * on the bot's day, and the heartbeat shows how many ran today. Calls run on our own model server,
 * so nothing is billed and nothing caps them (until 2026-10-28 a daily dollar budget did).
 */
export class AiCallLog {
  private cache: { day: string; calls: number; at: number } | null = null

  constructor(
    private readonly col: { aiCalls: Collection<AiCallDoc> },
    /** The bot's day a moment falls in, e.g. "2026-10-25" (crypto: UTC; stock: the New York trading day). */
    private readonly day: (date: Date) => string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Today's calls, recounted at most once a minute. */
  async today(): Promise<{ day: string; calls: number }> {
    const day = this.day(this.now())
    if (!this.cache || this.cache.day !== day || Date.now() - this.cache.at > 60_000) {
      this.cache = { day, calls: await this.col.aiCalls.countDocuments({ day }), at: Date.now() }
    }
    return { day, calls: this.cache.calls }
  }

  async record(call: Omit<AiCallDoc, "_id" | "day" | "at">) {
    const at = this.now()
    const doc: AiCallDoc = { _id: randomUUID(), at, day: this.day(at), ...call }
    await this.col.aiCalls.insertOne(doc)
    if (this.cache?.day === doc.day) this.cache.calls += 1
  }
}
