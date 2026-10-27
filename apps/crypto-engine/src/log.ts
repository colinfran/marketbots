/**
 * Structured JSON logging to stdout (Docker's json-file driver rotates it). Two layers keep
 * secrets out of logs: keys that look sensitive are masked, and every registered secret value is
 * replaced wherever it appears in a string (e.g. inside an error message or a URL).
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

export const createLogger = (level: LogLevel = "info", base: Fields = {}, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Logger => {
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
