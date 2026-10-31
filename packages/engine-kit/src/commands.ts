import { randomUUID } from "node:crypto"
import type { AuditDoc, CommandDoc, CommandStatus } from "@mb/core/db"
import type { BaseEventDataMap } from "@mb/core/events"
import type { Collection } from "mongodb"
import type { z } from "zod"
import type { EmitMeta } from "./bus"
import { errorMessage, type Logger } from "./log"
import { every } from "./util/async"

/**
 * Executes the owner's commands, one at a time in the order they arrive. They come two ways:
 *   - straight from the dashboard's server, through the stream server's signed POST /v1/commands
 *     (`submit`): run at once, with no database on the way;
 *   - from the `commands` collection, where the dashboard queues one when it can't reach the engine
 *     (restarting, say): checked every 3 seconds and at startup (`drain`), so a command sent while the
 *     engine was down still runs when it is back.
 * Both re-validate with the bot's command schema (the engine never trusts the web app's validation
 * alone). A queued command whose id already ran directly (the dashboard gave up waiting for the
 * engine's answer) isn't run again. The outcome is kept in memory for the page to poll (`status`),
 * then recorded in the collection and the audit log after, best effort: a slow database never holds a
 * command up, and the engine's own log keeps every one.
 *
 * Safety-reducing commands (pause, kill switch, close position) always run, however late. Commands
 * that increase risk (the bot's `expiring` set: resume, releasing the kill switch, running a
 * cycle…) expire after 10 minutes in the queue, so one queued while the engine was down doesn't fire
 * unexpectedly hours later.
 */

const EXPIRY_MS = 10 * 60_000

/** How often the queue in the database is checked. */
const QUEUE_POLL_MS = 3_000

/** How many outcomes are kept for the page to poll. */
const KEEP_OUTCOMES = 500

export type CommandHandler<C extends { type: string }> = (command: C, doc: CommandDoc<C>) => Promise<string>

type CommandEvents = Pick<BaseEventDataMap<string, string, string>, "command.received" | "command.completed" | "command.failed">

/** The part of the event bus the processor uses: the command events every bot has. */
export type CommandEventSink = { emit<T extends keyof CommandEvents>(type: T, data: CommandEvents[T], meta: EmitMeta): unknown }

/** What the processor needs from the bot: its command schema and which commands expire. */
export type CommandBinding<C extends { type: string }> = {
  schema: z.ZodType<C>
  expiring: ReadonlySet<C["type"]>
}

/** What the page polls of a command. */
export type CommandView = { _id: string; type: string; status: CommandStatus; result: string | null; error: string | null }

export type SubmitOutcome = { ok: true } | { ok: false; status: 400 | 409; error: string }

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ")

export class CommandProcessor<C extends { type: string }> {
  private stop: (() => void) | null = null
  /** Every command runs after the ones before it, whichever way it came. */
  private queue: Promise<void> = Promise.resolve()
  private readonly outcomes = new Map<string, CommandView>()

  constructor(
    private readonly col: { commands: Collection<CommandDoc<C>>; audit: Collection<AuditDoc> },
    private readonly bus: CommandEventSink,
    private readonly log: Logger,
    private readonly handle: CommandHandler<C>,
    private readonly bot: CommandBinding<C>,
  ) {}

  start() {
    this.stop = every(QUEUE_POLL_MS, () => this.drain(), (e) => this.log.warn("command poll failed", { error: errorMessage(e) }), { immediate: true })
  }

  shutdown() {
    this.stop?.()
  }

  /** A command from the dashboard's server: validated now, then run after the ones before it. */
  submit(id: string, input: unknown, actor: string, now = new Date()): SubmitOutcome {
    if (this.outcomes.has(id)) return { ok: false, status: 409, error: "a command with this id exists" }
    const parsed = this.bot.schema.safeParse(input)
    if (!parsed.success) return { ok: false, status: 400, error: issues(parsed.error) }
    const doc: CommandDoc<C> = { _id: id, type: parsed.data.type, command: parsed.data, status: "pending", created_at: now, created_by: actor, processed_at: null, result: null, error: null }
    this.keep(doc._id, doc.type, "pending", null, null)
    void this.enqueue(() => this.process(doc, "direct"))
    return { ok: true }
  }

  /** A command's progress or outcome, while it is kept here; null otherwise (look in the collection). */
  status(id: string): CommandView | null {
    return this.outcomes.get(id) ?? null
  }

  /** Resolves once every command queued so far has run. */
  idle(): Promise<void> {
    return this.queue
  }

  /** Runs every command waiting in the collection, oldest first. Exposed for tests. */
  async drain() {
    for (let i = 0; i < 20; i++) {
      const doc = await this.col.commands.findOneAndUpdate(
        { status: "pending" },
        { $set: { status: "processing", processed_at: new Date() } },
        { sort: { created_at: 1 }, returnDocument: "after" },
      )
      if (!doc) return
      await this.enqueue(() => this.process(doc, "queued"))
    }
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

  private async process(doc: CommandDoc<C>, via: "direct" | "queued") {
    const ran = via === "queued" ? this.outcomes.get(doc._id) : undefined
    if (ran && ran.status !== "pending" && ran.status !== "processing") {
      // Sent straight here first: record that outcome rather than run it twice.
      await this.record(doc, via, ran.status, ran.result, ran.error)
      return
    }
    this.keep(doc._id, doc.type, "processing", null, null)
    this.bus.emit("command.received", { command_id: doc._id, type: doc.type }, { summary: `Command received: ${doc.type}`, visibility: "owner" })
    const parsed = this.bot.schema.safeParse(doc.command)
    if (!parsed.success) return this.finish(doc, via, "rejected", null, issues(parsed.error), `Command rejected: ${doc.type}`)
    const command = parsed.data
    if (via === "queued" && this.bot.expiring.has(command.type) && Date.now() - doc.created_at.getTime() > EXPIRY_MS) {
      return this.finish(doc, via, "rejected", null, "command expired (queued more than 10 minutes ago); send it again", `Command expired: ${doc.type}`)
    }
    try {
      const result = await this.handle(command, doc)
      await this.finish(doc, via, "done", result, null, `${doc.type}: ${result}`)
    } catch (error) {
      await this.finish(doc, via, "failed", null, errorMessage(error).slice(0, 500), `Command failed: ${doc.type}`)
    }
  }

  private async finish(doc: CommandDoc<C>, via: "direct" | "queued", status: CommandStatus, result: string | null, error: string | null, summary: string) {
    this.keep(doc._id, doc.type, status, result, error)
    this.log.info("command finished", { id: doc._id, type: doc.type, via, status, result, error })
    if (status === "done") this.bus.emit("command.completed", { command_id: doc._id, type: doc.type, result: result ?? "" }, { summary, visibility: "owner" })
    else this.bus.emit("command.failed", { command_id: doc._id, type: doc.type, error: error ?? "" }, { summary, level: "warn", visibility: "owner" })
    await this.record(doc, via, status, result, error)
  }

  /** The command's record and its audit entry; failures are logged, not thrown. */
  private async record(doc: CommandDoc<C>, via: "direct" | "queued", status: CommandStatus, result: string | null, error: string | null) {
    try {
      const done = { status, result, error, processed_at: new Date() }
      if (via === "queued") await this.col.commands.updateOne({ _id: doc._id }, { $set: done })
      else await this.col.commands.replaceOne({ _id: doc._id }, { ...doc, ...done }, { upsert: true })
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
