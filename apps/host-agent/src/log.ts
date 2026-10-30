import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * One JSON line per entry, on stdout (info) or stderr (warn, error), and, once `logToFile` is
 * called, appended to `<dir>/agent.log` too: the scheduled task runs the agent with no console.
 * The file rolls over to agent.log.1 at 10 MB.
 */

type Fields = Record<string, unknown>

const MAX_BYTES = 10 * 1024 ** 2

let file: string | null = null

/** Also writes every entry to `<dir>/agent.log`. */
export const logToFile = (dir: string) => {
  mkdirSync(dir, { recursive: true })
  file = join(dir, "agent.log")
}

const write = (level: "info" | "warn" | "error", msg: string, fields?: Fields) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })
  if (level === "info") console.log(line)
  else console.error(line)
  if (!file) return
  try {
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.1`)
    appendFileSync(file, `${line}\n`)
  } catch {
    // A full or locked disk must not stop the agent (or the fans).
  }
}

export const log = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
}

export type Log = typeof log

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
