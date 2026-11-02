import { randomUUID } from "node:crypto"
import type { AuditDoc, CommandDoc, CommandStatus } from "@mb/core/db"
import type { BaseEventDataMap } from "@mb/core/events"
import type { Collection } from "mongodb"
import type { z } from "zod"
import type { EmitMeta } from "./bus"
import { errorMessage, type Logger } from "./log"

/**
 * Executes the owner's commands, one at a time in the order they arrive. They come straight from
 * the dashboard's server, through the stream server's signed POST /v1/commands (`submit`), and run
 * at once with no database on the way. Each is re-validated with the bot's command schema (the
 * engine never trusts the web app's validation alone). The outcome is kept in memory for the page to
 * poll (`status`), then recorded in the `commands` collection and the audit log after, best effort: a
 * slow database never holds a command up, and the engine's own log keeps every one.
 *
 * Nothing is queued: while the engine can't be reached, the dashboard refuses commands instead.
 * (Until 2026-11-02 it queued them in the collection, which the engine checked every 3 seconds.)
 */

/** How many outcomes are kept for the page to poll. */
const KEEP_OUTCOMES = 500

export type CommandHandler<C extends { type: string }> = (command: C, doc: CommandDoc<C>) => Promise<string>

type CommandEvents = Pick<BaseEventDataMap<string, string, string>, "command.received" | "command.completed" | "command.failed">

/** The part of the event bus the processor uses: the command events every bot has. */
export type CommandEventSink = { emit<T extends keyof CommandEvents>(type: T, data: CommandEvents[T], meta: EmitMeta): unknown }

/** What the processor needs from the bot: its command schema. */
export type CommandBinding<C extends { type: string }> = {
  schema: z.ZodType<C>
}

/** What the page polls of a command. */
export type CommandView = { _id: string; type: string; status: CommandStatus; result: string | null; error: string | null }

export type SubmitOutcome = { ok: true } | { ok: false; status: 400 | 409; error: string }

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ")

export class CommandProcessor<C extends { type: string }> {
  /** Every command runs after the ones before it. */
  private queue: Promise<void> = Promise.resolve()
  private readonly outcomes = new Map<string, CommandView>()

  constructor(
    private readonly col: { commands: Collection<CommandDoc<C>>; audit: Collection<AuditDoc> },
    private readonly bus: CommandEventSink,
    private readonly log: Logger,
    private readonly handle: CommandHandler<C>,
    private readonly bot: CommandBinding<C>,
  ) {}

  /** A command from the dashboard's server: validated now, then run after the ones before it. */
  submit(id: string, input: unknown, actor: string, now = new Date()): SubmitOutcome {
    if (this.outcomes.has(id)) return { ok: false, status: 409, error: "a command with this id exists" }
    const parsed = this.bot.schema.safeParse(input)
    if (!parsed.success) return { ok: false, status: 400, error: issues(parsed.error) }
    const doc: CommandDoc<C> = { _id: id, type: parsed.data.type, command: parsed.data, status: "pending", created_at: now, created_by: actor, processed_at: null, result: null, error: null }
    this.keep(doc._id, doc.type, "pending", null, null)
    void this.enqueue(() => this.process(doc))
    return { ok: true }
  }

  /** A command's progress or outcome, while it is kept here; null otherwise (look in the collection). */
  status(id: string): CommandView | null {
    return this.outcomes.get(id) ?? null
  }

  /** Resolves once every command submitted so far has run. */
  idle(): Promise<void> {
    return this.queue
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.queue.then(work)
    this.queue = run.catch((e) => this.log.error("command processing failed", { error: errorMessage(e) }))
    return this.queue
  }

  private keep(id: string, type: string, status: CommandStatus, result: string | null, error: string | null) {
    this.outcomes.delete(id)
    this.outcomes.set(id, { _id: id, type, status, result, error })
    if (this.outcomes.size > KEEP_OUTCOMES) this.outcomes.delete(this.outcomes.keys().next().value!)
  }

  private async process(doc: CommandDoc<C>) {
    this.keep(doc._id, doc.type, "processing", null, null)
    this.bus.emit("command.received", { command_id: doc._id, type: doc.type }, { summary: `Command received: ${doc.type}`, visibility: "owner" })
    try {
      const result = await this.handle(doc.command, doc)
      await this.finish(doc, "done", result, null, `${doc.type}: ${result}`)
    } catch (error) {
      await this.finish(doc, "failed", null, errorMessage(error).slice(0, 500), `Command failed: ${doc.type}`)
    }
  }

  private async finish(doc: CommandDoc<C>, status: CommandStatus, result: string | null, error: string | null, summary: string) {
    this.keep(doc._id, doc.type, status, result, error)
    this.log.info("command finished", { id: doc._id, type: doc.type, status, result, error })
    if (status === "done") this.bus.emit("command.completed", { command_id: doc._id, type: doc.type, result: result ?? "" }, { summary, visibility: "owner" })
    else this.bus.emit("command.failed", { command_id: doc._id, type: doc.type, error: error ?? "" }, { summary, level: "warn", visibility: "owner" })
    await this.record(doc, status, result, error)
  }

  /** The command's record and its audit entry; failures are logged, not thrown. */
  private async record(doc: CommandDoc<C>, status: CommandStatus, result: string | null, error: string | null) {
    try {
      await this.col.commands.replaceOne({ _id: doc._id }, { ...doc, status, result, error, processed_at: new Date() }, { upsert: true })
      await this.col.audit.insertOne({
        _id: randomUUID(),
        at: new Date(),
        actor: "engine",
        action: `command.${status}`,
        target: doc._id,
        details: { type: doc.type, requested_by: doc.created_by, result, error },
      })
    } catch (e) {
      this.log.warn("command record not saved", { id: doc._id, type: doc.type, status, error: errorMessage(e) })
    }
  }
}
