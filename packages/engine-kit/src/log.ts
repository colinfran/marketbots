import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"

/**
 * Structured JSON logging to stdout (Docker's json-file driver rotates it) and, optionally, to
 * day files that outlive the container (`dailyLogFiles`). Two layers keep secrets out of logs:
 * keys that look sensitive are masked, and every registered secret value is replaced wherever it
 * appears in a string (e.g. inside an error message or a URL).
 */

export type LogLevel = "debug" | "info" | "warn" | "error"
export type Fields = Record<string, unknown>

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const SENSITIVE_KEY = /(secret|password|passphrase|token|signature|api[-_]?key|authorization|private|seed|cookie)/i

let secrets: string[] = []

/** Registers secret values to scrub. Longest first, so a secret containing another is fully masked. */
export const registerSecrets = (values: string[]) => {
  secrets = [...new Set([...secrets, ...values.filter((v) => v.length >= 8)])].sort((a, b) => b.length - a.length)
}

export const scrub = (text: string): string => {
  let out = text
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join("[REDACTED]")
  // Credentials embedded in connection strings: scheme://user:pass@host
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^:/@\s]+):([^@/\s]+)@/gi, "$1$2:[REDACTED]@")
}

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 6) return "[depth]"
  if (typeof value === "string") return scrub(value)
  if (value instanceof Error) return { name: value.name, message: scrub(value.message), stack: value.stack ? scrub(value.stack) : undefined }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[REDACTED]" : sanitize(v, depth + 1)]),
    )
  }
  return value
}

export type Logger = {
  debug: (msg: string, fields?: Fields) => void
  info: (msg: string, fields?: Fields) => void
  warn: (msg: string, fields?: Fields) => void
  error: (msg: string, fields?: Fields) => void
  child: (fields: Fields) => Logger
}

export const toStdout = (line: string) => void process.stdout.write(`${line}\n`)

export const createLogger = (level: LogLevel = "info", base: Fields = {}, write: (line: string) => void = toStdout): Logger => {
  const min = LEVELS[level]
  const emit = (lvl: LogLevel, msg: string, fields?: Fields) => {
    if (LEVELS[lvl] < min) return
    const record = { ts: new Date().toISOString(), level: lvl, msg: scrub(msg), ...(sanitize({ ...base, ...fields }) as Fields) }
    write(JSON.stringify(record))
  }
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, write),
  }
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
}

export const errorMessage = (error: unknown) => scrub(error instanceof Error ? error.message : String(error))

export type LogFileOptions = {
  /** Day files older than this many days are deleted (default 90). */
  retentionDays?: number
  /** A day's file stops growing past this size (default 25 MB), so a runaway loop can't fill the disk. */
  maxBytes?: number
  now?: () => Date
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.log$/
const DAY_MS = 86_400_000

/**
 * Appends every line to one file per UTC day in `dir` (`2026-10-27.log`). In compose `dir` is a
 * host folder, so the history outlives the container: a deploy replaces the container and its
 * Docker log, and the new engine carries on in the same day's file. Each line is appended
 * synchronously and the file closed again (engines log a few lines a minute), so the lines right
 * before an exit are kept and no file stays open. Old files are pruned at the start of each day. A
 * folder that can't be written never stops the engine: the problem is printed once to stdout, and
 * the next day tries again.
 */
export const dailyLogFiles = (dir: string, { retentionDays = 90, maxBytes = 25 * 1024 * 1024, now = () => new Date() }: LogFileOptions = {}) => {
  let day = ""
  let path = ""
  let size = 0
  let broken = false
  let warned = false
  const notice = (msg: string, fields: Fields = {}) => JSON.stringify({ ts: now().toISOString(), level: "warn", msg, ...fields })

  const startDay = (today: string) => {
    day = today
    path = join(dir, `${today}.log`)
    broken = false
    mkdirSync(dir, { recursive: true })
    size = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    warned = false
    const oldest = new Date(Date.parse(today) - retentionDays * DAY_MS).toISOString().slice(0, 10)
    try {
      for (const name of readdirSync(dir)) if (DAY_FILE.test(name) && name.slice(0, 10) < oldest) unlinkSync(join(dir, name))
    } catch {
      // Pruning is best effort; today's file is what matters.
    }
  }

  return (line: string) => {
    const today = now().toISOString().slice(0, 10)
    try {
      if (today !== day) startDay(today)
      if (broken || size >= maxBytes) return
      const full = size + Buffer.byteLength(line) + 1 > maxBytes
      const text = `${full ? notice("log file full; the rest of today's lines are only in Docker's log", { max_bytes: maxBytes }) : line}\n`
      appendFileSync(path, text)
      size = full ? maxBytes : size + Buffer.byteLength(text)
    } catch (error) {
      broken = true
      if (!warned) toStdout(notice("log file not writable; logging to stdout only", { dir, error: errorMessage(error) }))
      warned = true
    }
  }
}
