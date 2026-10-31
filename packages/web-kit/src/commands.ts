import "server-only"
import { randomUUID } from "node:crypto"
import type { BaseCommand } from "@mb/core/commands"
import type { AuditDoc, CommandDoc, CommandStatus, SettingsDoc } from "@mb/core/db"
import type { EventVisibility } from "@mb/core/events"
import type { SignedRequest, StreamTokenPayload } from "@mb/core/stream-token"
import type { Collection, Document } from "mongodb"
import { NextResponse } from "next/server"
import type { Viewer } from "./auth"

/**
 * Owner commands: validation and delivery, and the API routes around them. A command is validated
 * here for fast feedback, then sent from the dashboard's server straight to the engine (its
 * POST /v1/commands, signed with the stream secret and the bot's request prefix), which re-validates
 * it and acts at once: no database on the way, so a pause or the kill switch never waits on it.
 * When the engine can't be reached (restarting, say), the command is queued in the `commands`
 * collection instead, under the same id, and the engine runs it from there within 3 seconds of being
 * back. Either way the request goes to the audit log.
 */

/** How long the dashboard waits for the engine before queueing the command instead. */
const ENGINE_TIMEOUT_MS = 5_000

/** What the page polls of a command. */
export type CommandView = { _id: string; type: string; status: CommandStatus; result: string | null; error: string | null }

/** The engine's command endpoints: its stream URL (whose origin serves them), the shared secret, and the bot core's request signer. */
export type EngineLink = {
  streamUrl: () => string | null
  secret: () => string | null
  sign: (secret: string, request: SignedRequest) => Record<string, string>
}

/** The http(s) origin of the engine's stream URL (wss://engine.example.app/v1/stream → https://engine.example.app). */
const engineOrigin = (streamUrl: string | null) => {
  if (!streamUrl) return null
  try {
    const url = new URL(streamUrl)
    return `${url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol}//${url.host}`
  } catch {
    return null
  }
}

/** The parts of a zod schema the dashboard uses. */
type Schema<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }

type CommandCollections<C extends { type: string }, S> = {
  commands: Collection<CommandDoc<C>>
  audit: Collection<AuditDoc>
  settings: Collection<SettingsDoc<S>>
}

export type SubmitResult = { ok: true; id: string } | { ok: false; error: string }

/** Binds the command library to a bot's command union, settings schema and patch check, and its engine. */
export const createCommands = <C extends { type: string }, S>({
  collections,
  commandSchema,
  settingsSchema,
  applySettingsPatch,
  engine,
  fetchFn = fetch,
}: {
  collections: () => Promise<CommandCollections<C, S>>
  commandSchema: Schema<C>
  settingsSchema: Schema<S>
  applySettingsPatch: (base: S, patch: Record<string, unknown>) => { ok: true } | { ok: false; errors: string[] }
  engine: EngineLink
  fetchFn?: typeof fetch
}) => {
  /** A signed call to the engine's command endpoints; null when it isn't set up or doesn't answer in time. */
  const callEngine = async (method: "GET" | "POST", path: string, body = ""): Promise<Response | null> => {
    const origin = engineOrigin(engine.streamUrl())
    const secret = engine.secret()
    if (!origin || !secret) return null
    return fetchFn(`${origin}${path}`, {
      method,
      body: method === "POST" ? body : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      headers: { "content-type": "application/json", ...engine.sign(secret, { method, path, body }) },
    }).catch(() => null)
  }

  /** A command's progress or outcome, as the engine holds it; null if it doesn't (or can't be reached). */
  const getEngineCommand = async (id: string): Promise<CommandView | null> => {
    const res = await callEngine("GET", `/v1/commands/${encodeURIComponent(id)}`)
    return res?.ok ? ((await res.json()) as CommandView) : null
  }

  /** Sends an owner command to the engine, or queues it when the engine can't be reached. Every command is written to the audit log with what was asked. */
  const submitCommand = async (input: unknown, actor: string): Promise<SubmitResult> => {
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") }
    const command = parsed.data
    const shared = command as unknown as BaseCommand
    const { commands, audit, settings } = await collections()
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
    const requested: AuditDoc = { _id: randomUUID(), at: now, actor, action: `command.requested`, target: id, details: { type: command.type, command } }
    const sent = await callEngine("POST", "/v1/commands", JSON.stringify({ id, actor, command }))
    if (sent?.status === 202) {
      // Already acting: a failed audit write mustn't undo that.
      await audit.insertOne(requested).catch((e: unknown) => console.error(`[commands] ${command.type} ${id} sent, audit entry not written:`, e instanceof Error ? e.message : String(e)))
      return { ok: true, id }
    }
    if (sent?.status === 400 || sent?.status === 409) {
      const reason = ((await sent.json().catch(() => null)) as { error?: string } | null)?.error
      return { ok: false, error: `The engine refused it: ${reason ?? `HTTP ${sent.status}`}` }
    }
    // Not reached (or not set up): queued, under the same id so the engine never runs it twice.
    const doc: CommandDoc<C> = { _id: id, type: command.type, command, status: "pending", created_at: now, created_by: actor, processed_at: null, result: null, error: null }
    await commands.insertOne(doc as Parameters<typeof commands.insertOne>[0]).catch((e: { code?: number }) => {
      // Duplicate id: the engine did get it, and recorded it, before its answer was lost.
      if (e.code !== 11000) throw e
    })
    await audit.insertOne(requested)
    return { ok: true, id }
  }

  return { submitCommand, getEngineCommand }
}

type Gate = { getViewer: () => Promise<Viewer> }

/** POST /api/commands (owner only): send a command to the engine (pause, kill switch, settings, …). */
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

/**
 * GET /api/commands/[id] (owner only): a command's status, polled by the UI until the engine has
 * processed it. The engine's own answer first (`engineCommand`), else the queue in the database.
 */
export const commandRoute =
  <D extends Document>({ getViewer, commands, engineCommand }: Gate & { commands: () => Promise<Collection<D>>; engineCommand?: (id: string) => Promise<CommandView | null> }) =>
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const { id } = await params
    const fromEngine = await engineCommand?.(id)
    if (fromEngine) return NextResponse.json(fromEngine, { headers: { "cache-control": "no-store" } })
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
