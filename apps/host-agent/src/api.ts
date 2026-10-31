import { timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { hostCommandSchema, isHostRange } from "@mb/core/host"
import { z } from "zod"
import type { HostCommands } from "./commands"
import { errorMessage, type Log } from "./log"
import type { HostStore } from "./store"

/**
 * The agent's API (docs/SERVER.md §11): what the dashboards' servers call while Admin → Server is
 * open. It listens on 127.0.0.1 only, and Caddy publishes it at /host on each engine domain. Every
 * request carries the shared secret (`Authorization: Bearer <HOST_API_SECRET>`), which only the
 * dashboards' servers hold; the browser never sees it.
 *
 *   GET  /status            the latest reading (null before the first)
 *   GET  /history?range=1h  a range's chart points
 *   POST /commands          { id, actor, command }: validated again, queued, answered 202
 *   GET  /commands/<id>     a command's status and outcome
 */

const MAX_BODY_BYTES = 16 * 1024

const submissionSchema = z.object({ id: z.string().regex(/^[\w-]{1,64}$/), actor: z.string().min(1).max(64), command: z.unknown() })

export type ApiDeps = {
  secret: string
  store: Pick<HostStore, "latest" | "history" | "command">
  commands: Pick<HostCommands, "submit">
  log: Log
  now?: () => number
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

const authorized = (req: IncomingMessage, secret: string) => {
  const given = Buffer.from(req.headers.authorization ?? "")
  const expected = Buffer.from(`Bearer ${secret}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** The request's body, or null past MAX_BODY_BYTES (the rest is read and dropped, so the answer still goes out). */
const readBody = (req: IncomingMessage) =>
  new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "command"}: ${i.message}`).join("; ")

/** The API's server, not yet listening. */
export const createApi = ({ secret, store, commands, log, now = Date.now }: ApiDeps): Server =>
  createServer((req, res) => {
    void (async () => {
      if (!authorized(req, secret)) return send(res, 401, { error: "unauthorized" })
      const url = new URL(req.url ?? "/", "http://host")
      const path = url.pathname.replace(/\/+$/, "") || "/"
      if (req.method === "GET" && path === "/status") return send(res, 200, store.latest())
      if (req.method === "GET" && path === "/history") {
        const range = url.searchParams.get("range")
        if (!isHostRange(range)) return send(res, 400, { error: "unknown range" })
        return send(res, 200, store.history(range, now()))
      }
      if (req.method === "POST" && path === "/commands") {
        const body = await readBody(req)
        if (body === null) return send(res, 413, { error: "request too large" })
        let json: unknown = null
        try {
          json = JSON.parse(body)
        } catch {
          return send(res, 400, { error: "not JSON" })
        }
        const submission = submissionSchema.safeParse(json)
        if (!submission.success) return send(res, 400, { error: issues(submission.error) })
        const command = hostCommandSchema.safeParse(submission.data.command)
        if (!command.success) return send(res, 400, { error: issues(command.error) })
        if (!commands.submit(submission.data.id, command.data, submission.data.actor)) return send(res, 409, { error: "a command with this id exists" })
        return send(res, 202, { id: submission.data.id })
      }
      const commandPath = /^\/commands\/([\w-]{1,64})$/.exec(path)
      if (req.method === "GET" && commandPath) {
        const doc = store.command(commandPath[1])
        return doc ? send(res, 200, doc) : send(res, 404, { error: "not found" })
      }
      send(res, 404, { error: "not found" })
    })().catch((e) => {
      log.warn("api request failed", { path: req.url, error: errorMessage(e) })
      if (!res.headersSent) send(res, 500, { error: "internal error" })
    })
  })

/** Starts the API on 127.0.0.1:`port`. */
export const startApi = (deps: ApiDeps, port: number) =>
  new Promise<Server>((resolve, reject) => {
    const server = createApi(deps)
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      resolve(server)
    })
  })
