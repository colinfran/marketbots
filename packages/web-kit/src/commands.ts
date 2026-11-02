import "server-only"
import { randomUUID } from "node:crypto"
import type { BaseCommand } from "@mb/core/commands"
import type { AuditDoc, CommandStatus, SettingsDoc } from "@mb/core/db"
import type { EventVisibility } from "@mb/core/events"
import type { StreamTokenPayload } from "@mb/core/stream-token"
import type { Collection, Document } from "mongodb"
import { NextResponse } from "next/server"
import type { Viewer } from "./auth"
import { callEngine, type EngineLink } from "./engine-link"

/**
 * Owner commands: validation and delivery, and the API routes around them. A command is validated
 * here for fast feedback, then sent from the dashboard's server straight to the engine (its
 * POST /v1/commands, signed with the stream secret and the bot's request prefix), which re-validates
 * it and acts at once: no database on the way, so a pause or the kill switch never waits on it.
 * Nothing is queued: when the engine can't be reached (restarting, say), the owner is told so and
 * sends the command again once it is back. Every command the engine took goes to the audit log.
 */

/** How long the dashboard waits for the engine's answer. */
const ENGINE_TIMEOUT_MS = 5_000

/** What the page polls of a command. */
export type CommandView = { _id: string; type: string; status: CommandStatus; result: string | null; error: string | null }

/** The parts of a zod schema the dashboard uses. */
type Schema<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }

type CommandCollections<S> = {
  audit: Collection<AuditDoc>
  settings: Collection<SettingsDoc<S>>
}

export type SubmitResult = { ok: true; id: string } | { ok: false; error: string }

/** What the owner is told when a command got no answer from the engine. */
const MISSED = {
  unconfigured: "This dashboard can't reach the engine: ENGINE_STREAM_URL and STREAM_TOKEN_SECRET must both be set. Nothing was sent.",
  unreachable: "The engine can't be reached (restarting or offline). Nothing was sent: try again once it's back.",
  timeout: "The engine didn't answer within 5 seconds, so it may have run the command. Check the activity feed before sending it again.",
} as const

/** Binds the command library to a bot's command union, settings schema and patch check, and its engine. */
export const createCommands = <C extends { type: string }, S>({
  collections,
  commandSchema,
  settingsSchema,
  applySettingsPatch,
  engine,
  fetchFn = fetch,
}: {
  collections: () => Promise<CommandCollections<S>>
  commandSchema: Schema<C>
  settingsSchema: Schema<S>
  applySettingsPatch: (base: S, patch: Record<string, unknown>) => { ok: true } | { ok: false; errors: string[] }
  engine: EngineLink
  fetchFn?: typeof fetch
}) => {
  const call = (method: "GET" | "POST", path: string, body = "") => callEngine(engine, { method, path, body, timeoutMs: ENGINE_TIMEOUT_MS, fetchFn })

  /** A command's progress or outcome, as the engine holds it; null if it doesn't (or can't be reached). */
  const getEngineCommand = async (id: string): Promise<CommandView | null> => {
    const res = await call("GET", `/v1/commands/${encodeURIComponent(id)}`)
    return typeof res !== "string" && res.ok ? ((await res.json()) as CommandView) : null
  }

  /** Sends an owner command to the engine. Every command it takes is written to the audit log with what was asked. */
  const submitCommand = async (input: unknown, actor: string): Promise<SubmitResult> => {
    const parsed = commandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") }
    const command = parsed.data
    const shared = command as unknown as BaseCommand
    const { audit, settings } = await collections()
    if (shared.type === "settings.update") {
      // Same validation the engine applies, so a bad form never reaches it.
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
    const sent = await call("POST", "/v1/commands", JSON.stringify({ id, actor, command }))
    if (typeof sent === "string") return { ok: false, error: MISSED[sent] }
    if (sent.status === 202) {
      // Already acting: a failed audit write mustn't undo that.
      await audit.insertOne(requested).catch((e: unknown) => console.error(`[commands] ${command.type} ${id} sent, audit entry not written:`, e instanceof Error ? e.message : String(e)))
      return { ok: true, id }
    }
    const reason = ((await sent.json().catch(() => null)) as { error?: string } | null)?.error
    if (sent.status === 400 || sent.status === 409) return { ok: false, error: `The engine refused it: ${reason ?? `HTTP ${sent.status}`}` }
    return { ok: false, error: `The engine couldn't take it (HTTP ${sent.status}${reason ? `: ${reason}` : ""}). Nothing was run.` }
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
 * processed it. The engine's own answer first (`engineCommand`), else the record it saved in the
 * database (the engine restarted since, or no longer keeps it).
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
