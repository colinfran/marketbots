import "server-only"
import { randomUUID } from "node:crypto"
import type { AuditDoc } from "@mb/core/db"
import { hostCommandSchema, isHostRange, type HostCommandView, type HostHistoryView, type HostRange, type HostStatusView } from "@mb/core/host"
import type { Collection } from "mongodb"
import { connection, NextResponse } from "next/server"
import { errorMessage } from "./alerts"
import type { Viewer } from "./auth"
import type { SubmitResult } from "./commands"
import type { DashboardEnv } from "./env"

/**
 * Admin → Server (docs/SERVER.md §11), the same in both dashboards: the host agent's latest
 * reading, its charts and the owner's commands, from the agent's own API on the server
 * (HOST_API_URL, behind Caddy). Only the dashboard's server calls it, with the shared secret
 * (HOST_API_SECRET), and only while the page is open: nothing about the machine is in the bots'
 * database. A command's request is audited in the bot's audit log. Owner only: the page lists the
 * machine's volumes and devices.
 */

/** How long a call to the agent may take (the page polls every 2 seconds). */
const TIMEOUT_MS = 5_000

export const createHost = ({ env, audit, fetchFn = fetch }: { env: Pick<DashboardEnv, "hostApiUrl" | "hostApiSecret">; audit: () => Promise<Collection<AuditDoc>>; fetchFn?: typeof fetch }) => {
  /** A call to the agent's API; throws when it isn't configured or doesn't answer in time. */
  const call = async (path: string, init: RequestInit = {}) => {
    const url = env.hostApiUrl()
    const secret = env.hostApiSecret()
    if (!url || !secret) throw new Error("HOST_API_URL and HOST_API_SECRET aren't set")
    return fetchFn(`${url.replace(/\/+$/, "")}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    })
  }

  /** The latest reading; null when the agent can't be reached (the page then shows it offline). */
  const getHostStatus = async (): Promise<HostStatusView | null> => {
    await connection()
    const res = await call("/status").catch(() => null)
    return res?.ok ? ((await res.json()) as HostStatusView | null) : null
  }

  /** A range's chart points; null when the agent can't be reached. */
  const getHostHistory = async (range: HostRange): Promise<HostHistoryView | null> => {
    await connection()
    const res = await call(`/history?range=${range}`).catch(() => null)
    return res?.ok ? ((await res.json()) as HostHistoryView) : null
  }

  /** Sends a command to the agent (which validates it again and runs it at once), then audits the request. */
  const submitHostCommand = async (input: unknown, actor: string): Promise<SubmitResult> => {
    const parsed = hostCommandSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ") }
    const command = parsed.data
    const id = randomUUID()
    const res = await call("/commands", { method: "POST", body: JSON.stringify({ id, actor, command }) }).catch((e: unknown) => errorMessage(e))
    if (typeof res === "string" || !res.ok) {
      const reason = typeof res === "string" ? res : (((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
      return { ok: false, error: `The server's host agent didn't take it: ${reason}` }
    }
    await (await audit()).insertOne({ _id: randomUUID(), at: new Date(), actor, action: "host_command.requested", target: id, details: { type: command.type, command } })
    return { ok: true, id }
  }

  /** What the page polls of a command; null if the agent doesn't know it or can't be reached. */
  const getHostCommand = async (id: string): Promise<HostCommandView | null> => {
    const res = await call(`/commands/${encodeURIComponent(id)}`).catch(() => null)
    return res?.ok ? ((await res.json()) as HostCommandView) : null
  }

  return { getHostStatus, getHostHistory, submitHostCommand, getHostCommand }
}

type Gate = { getViewer: () => Promise<Viewer> }

const NO_STORE = { headers: { "cache-control": "no-store" } }

const UNREACHABLE = "The server's host agent can't be reached."

/** GET /api/host/status (owner only): the latest reading, polled by the page every 2 seconds. */
export const hostStatusRoute =
  ({ getViewer, getHostStatus }: Gate & { getHostStatus: () => Promise<HostStatusView | null> }) =>
  async () => {
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    return NextResponse.json(await getHostStatus(), NO_STORE)
  }

/** GET /api/host/history?range=1h (owner only): a range's chart points. */
export const hostHistoryRoute =
  ({ getViewer, getHostHistory }: Gate & { getHostHistory: (range: HostRange) => Promise<HostHistoryView | null> }) =>
  async (request: Request) => {
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const range = new URL(request.url).searchParams.get("range")
    if (!isHostRange(range)) return NextResponse.json({ error: "unknown range" }, { status: 400 })
    const history = await getHostHistory(range)
    return history ? NextResponse.json(history, NO_STORE) : NextResponse.json({ error: UNREACHABLE }, { status: 502 })
  }

/** POST /api/host/commands (owner only): send a fan, settings or outlet command to the host agent. */
export const hostCommandsRoute =
  ({ getViewer, sameOrigin, submitHostCommand }: Gate & { sameOrigin: () => Promise<boolean>; submitHostCommand: (input: unknown, actor: string) => Promise<SubmitResult> }) =>
  async (request: Request) => {
    if (!(await sameOrigin())) return NextResponse.json({ error: "bad origin" }, { status: 403 })
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const result = await submitHostCommand(await request.json().catch(() => null), "owner")
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
    return NextResponse.json({ id: result.id }, { status: 202 })
  }

/** GET /api/host/commands/<id> (owner only): a command's status, polled by the page until the agent has answered it. */
export const hostCommandRoute =
  ({ getViewer, getHostCommand }: Gate & { getHostCommand: (id: string) => Promise<HostCommandView | null> }) =>
  async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
    if (!(await getViewer()).owner) return NextResponse.json({ error: "Owner login required." }, { status: 401 })
    const doc = await getHostCommand((await params).id)
    return doc ? NextResponse.json(doc, NO_STORE) : NextResponse.json({ error: "not found" }, { status: 404 })
  }
