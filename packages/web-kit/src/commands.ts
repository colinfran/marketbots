import "server-only"
import { randomUUID } from "node:crypto"
import type { BaseCommand } from "@mb/core/commands"
import type { AuditDoc, CommandDoc, SeedRunDoc, SettingsDoc } from "@mb/core/db"
import type { EventVisibility } from "@mb/core/events"
import type { StreamTokenPayload } from "@mb/core/stream-token"
import type { Collection, Document } from "mongodb"
import { NextResponse } from "next/server"
import type { Viewer } from "./auth"

/**
 * Owner commands: validation and queueing, and the API routes around them. A command is validated
 * here for fast feedback, written to the `commands` collection with an audit entry, and
 * re-validated by the engine before it acts.
 */

/** The parts of a zod schema the dashboard uses. */
type Schema<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }

type CommandCollections<C extends { type: string }, S> = {
  commands: Collection<CommandDoc<C>>
  audit: Collection<AuditDoc>
  settings: Collection<SettingsDoc<S>>
  seedRuns: Collection<SeedRunDoc>
}

export type SubmitResult = { ok: true; id: string } | { ok: false; error: string }

/** Binds the command library to a bot's command union, settings schema and patch check. */
export const createCommands = <C extends { type: string }, S>({
  collections,
  commandSchema,
  settingsSchema,
  applySettingsPatch,
}: {
  collections: () => Promise<CommandCollections<C, S>>
  commandSchema: Schema<C>
  settingsSchema: Schema<S>
  applySettingsPatch: (base: S, patch: Record<string, unknown>) => { ok: true } | { ok: false; errors: string[] }
}) => {
  /** Queues an owner command for the engine. Every command is written to the audit log with what was asked. */
  const submitCommand = async (input: unknown, actor: string): Promise<SubmitResult> => {
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") }
    const command = parsed.data
    const shared = command as unknown as BaseCommand
    const { commands, audit, settings, seedRuns } = await collections()
    if (shared.type === "seed.schedule") {
      // The engine enforces these too; checking here gives the form an immediate answer.
      const active = await seedRuns.findOne({ status: { $in: ["scheduled", "running"] } })
      if (active) return { ok: false, error: `a seed is already ${active.status}; cancel it first` }
      if (!shared.force && (await seedRuns.findOne({ status: "done" }))) return { ok: false, error: 'a seed already ran; tick "force a new seed" to run another' }
    }
    if (shared.type === "settings.update") {
      // Same validation the engine applies, so a bad form never reaches the queue.
      const current = await settings.findOne({ _id: "current" })
      if (!current) return { ok: false, error: "settings not initialized yet (start the engine once)" }
      const base = settingsSchema.safeParse(current.settings)
      if (!base.success) return { ok: false, error: "stored settings are invalid; check the engine logs" }
      const check = applySettingsPatch(base.data, shared.patch)
      if (!check.ok) return { ok: false, error: check.errors.join("; ") }
    }
    const id = randomUUID()
    const now = new Date()
    const doc: CommandDoc<C> = { _id: id, type: command.type, command, status: "pending", created_at: now, created_by: actor, processed_at: null, result: null, error: null }
    await commands.insertOne(doc as Parameters<typeof commands.insertOne>[0])
    await audit.insertOne({ _id: randomUUID(), at: now, actor, action: `command.requested`, target: id, details: { type: command.type, command } })
    return { ok: true, id }
  }

  return { submitCommand }
}

type Gate = { getViewer: () => Promise<Viewer> }

/** POST /api/commands (owner only): queue a command for the engine (pause, kill switch, settings, …). */
export const commandsRoute =
  ({ getViewer, sameOrigin, submitCommand }: Gate & { sameOrigin: () => Promise<boolean>; submitCommand: (input: unknown, actor: string) => Promise<SubmitResult> }) =>
  async (request: Request) => {
    if (!(await sameOrigin())) return NextResponse.json({ error: "bad origin" }, { status: 403 })
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const body = await request.json().catch(() => null)
    const result = await submitCommand(body, "owner")
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ id: result.id }, { status: 202 })
  }

/** GET /api/commands/[id] (owner only): a queued command's status, polled by the UI until the engine has processed it. */
export const commandRoute =
  <D extends Document>({ getViewer, commands }: Gate & { commands: () => Promise<Collection<D>> }) =>
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const { id } = await params
    const collection = (await commands()) as unknown as Collection<{ _id: string } & Document>
    const doc = await collection.findOne({ _id: id }, { projection: { status: 1, result: 1, error: 1, type: 1 } })
    if (!doc) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json(doc, { headers: { "cache-control": "no-store" } })
  }

/**
 * GET /api/stream-token: a 60-second token for the engine's WebSocket stream, owner scope with a
 * valid owner session and public scope otherwise. The browser sends it as its first frame after
 * connecting. `sign` is the bot core's signer, bound to its HMAC prefix (`cmb-stream.` / `smb-stream.`).
 */
export const streamTokenRoute =
  ({
    getViewer,
    env,
    sign,
  }: Gate & {
    env: { engineStreamUrl: () => string | null; streamTokenSecret: () => string | null }
    sign: (scope: EventVisibility, secret: string) => { token: string; payload: StreamTokenPayload }
  }) =>
  async () => {
    const url = env.engineStreamUrl()
    const secret = env.streamTokenSecret()
    if (!url || !secret) return NextResponse.json({ url: null, token: null, scope: null }, { headers: { "cache-control": "no-store" } })
    const viewer = await getViewer()
    const scope = viewer.owner ? "owner" : "public"
    const { token, payload } = sign(scope, secret)
    return NextResponse.json({ url, token, scope, expires_at: payload.exp * 1000 }, { headers: { "cache-control": "no-store" } })
  }
