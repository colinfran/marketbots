import { randomUUID } from "node:crypto"
import type { AuditDoc, CommandDoc } from "@mb/core/db"
import type { BaseEventDataMap } from "@mb/core/events"
import type { Collection } from "mongodb"
import type { z } from "zod"
import type { EmitMeta } from "./bus"
import { errorMessage, type Logger } from "./log"
import { every } from "./util/async"

/**
 * Executes dashboard commands from the `commands` collection, oldest first, one at a time.
 * Commands are re-validated here with the bot's command schema (the engine never trusts the web
 * app's validation alone).
 *
 * Safety-reducing commands (pause, kill switch, close position) always run, however late. Commands
 * that increase risk (the bot's `expiring` set: resume, releasing the kill switch, running a
 * cycle…) expire after 10 minutes, so a command queued while the engine was down doesn't fire
 * unexpectedly hours later.
 */

const EXPIRY_MS = 10 * 60_000

export type CommandHandler<C extends { type: string }> = (command: C, doc: CommandDoc<C>) => Promise<string>

type CommandEvents = Pick<BaseEventDataMap<string, string, string>, "command.received" | "command.completed" | "command.failed">

/** The part of the event bus the processor uses: the command events every bot has. */
export type CommandEventSink = { emit<T extends keyof CommandEvents>(type: T, data: CommandEvents[T], meta: EmitMeta): unknown }

/** What the processor needs from the bot: its command schema and which commands expire. */
export type CommandBinding<C extends { type: string }> = {
  schema: z.ZodType<C>
  expiring: ReadonlySet<C["type"]>
}

export class CommandProcessor<C extends { type: string }> {
  private stop: (() => void) | null = null

  constructor(
    private readonly col: { commands: Collection<CommandDoc<C>>; audit: Collection<AuditDoc> },
    private readonly bus: CommandEventSink,
    private readonly log: Logger,
    private readonly handle: CommandHandler<C>,
    private readonly bot: CommandBinding<C>,
  ) {}

  start() {
    this.stop = every(1_000, () => this.drain(), (e) => this.log.warn("command poll failed", { error: errorMessage(e) }), { immediate: true })
  }

  shutdown() {
    this.stop?.()
  }

  /** Processes every pending command. Exposed for tests. */
  async drain() {
    for (let i = 0; i < 20; i++) {
      const doc = await this.col.commands.findOneAndUpdate(
        { status: "pending" },
        { $set: { status: "processing", processed_at: new Date() } },
        { sort: { created_at: 1 }, returnDocument: "after" },
      )
      if (!doc) return
      await this.process(doc)
    }
  }

  private async finish(doc: CommandDoc<C>, status: CommandDoc<C>["status"], result: string | null, error: string | null) {
    await this.col.commands.updateOne({ _id: doc._id }, { $set: { status, result, error, processed_at: new Date() } })
    await this.col.audit.insertOne({
      _id: randomUUID(),
      at: new Date(),
      actor: "engine",
      action: `command.${status}`,
      target: doc._id,
      details: { type: doc.type, requested_by: doc.created_by, result, error },
    })
  }

  private async process(doc: CommandDoc<C>) {
    this.bus.emit("command.received", { command_id: doc._id, type: doc.type }, { summary: `Command received: ${doc.type}`, visibility: "owner" })
    const parsed = this.bot.schema.safeParse(doc.command)
    if (!parsed.success) {
      const error = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      await this.finish(doc, "rejected", null, error)
      this.bus.emit("command.failed", { command_id: doc._id, type: doc.type, error }, { summary: `Command rejected: ${doc.type}`, level: "warn", visibility: "owner" })
      return
    }
    const command = parsed.data
    if (this.bot.expiring.has(command.type) && Date.now() - doc.created_at.getTime() > EXPIRY_MS) {
      const error = "command expired (queued more than 10 minutes ago); send it again"
      await this.finish(doc, "rejected", null, error)
      this.bus.emit("command.failed", { command_id: doc._id, type: doc.type, error }, { summary: `Command expired: ${doc.type}`, level: "warn", visibility: "owner" })
      return
    }
    try {
      const result = await this.handle(command, doc)
      await this.finish(doc, "done", result, null)
      this.bus.emit("command.completed", { command_id: doc._id, type: doc.type, result }, { summary: `${doc.type}: ${result}`, visibility: "owner" })
    } catch (error) {
      const message = errorMessage(error).slice(0, 500)
      await this.finish(doc, "failed", null, message)
      this.bus.emit("command.failed", { command_id: doc._id, type: doc.type, error: message }, { summary: `Command failed: ${doc.type}`, level: "warn", visibility: "owner" })
    }
  }
}
