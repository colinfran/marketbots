import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { expect } from "vitest"

/**
 * Contract snapshots (MARKETBOTS_PLAN §2 rule 2, task 2.5): today's behavior, committed under
 * contracts/stock/. A test compares what the code produces now with the committed file and fails
 * on any difference. `UPDATE_CONTRACTS=1 pnpm --filter @mb/stock-engine test` rewrites them.
 */

export const CONTRACTS_DIR = resolve(__dirname, "../../../../contracts/stock")
export const UPDATE = process.env.UPDATE_CONTRACTS === "1"

/** JSON-safe copy: Dates as ISO strings, Maps as objects (or entry lists), Sets as arrays, non-finite numbers as strings. */
export const plain = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : String(value)
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined
  if (typeof value === "bigint") return `${value}n`
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date"
  if (value instanceof RegExp) return value.toString()
  if (value instanceof Map) {
    const entries = [...value.entries()]
    return entries.every(([k]) => typeof k === "string") ? Object.fromEntries(entries.map(([k, v]) => [k, plain(v)])) : entries.map(([k, v]) => [plain(k), plain(v)])
  }
  if (value instanceof Set) return [...value].map(plain)
  if (ArrayBuffer.isView(value)) return `<${value.constructor.name} ${value.byteLength} bytes>`
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : plain(v)))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const p = plain(v)
    if (p !== undefined) out[k] = p
  }
  return out
}

/** Stable JSON text: 2-space indent, LF, trailing newline, key order as produced. */
export const toJson = (value: unknown) => `${JSON.stringify(plain(value), null, 2)}\n`

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null)

/** Compares `content` with contracts/stock/<file>, or rewrites the file with UPDATE_CONTRACTS=1. */
export const matchContract = (file: string, content: string) => {
  const path = join(CONTRACTS_DIR, file)
  const current = read(path)
  if (UPDATE) {
    if (current !== content) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
    return
  }
  if (current === null) throw new Error(`Missing contract snapshot contracts/stock/${file}. Generate it with UPDATE_CONTRACTS=1 pnpm --filter @mb/stock-engine test`)
  expect(
    content,
    `contracts/stock/${file} changed. A contract diff means a behavior change: revert it, or move it to Phase 9 with a reason and regenerate with UPDATE_CONTRACTS=1 (MARKETBOTS_PLAN §2 rule 2).`,
  ).toBe(current)
}

export const matchJson = (file: string, value: unknown) => matchContract(file, toJson(value))

/** Files under contracts/stock/<dir> (one level) that no test produced: removed with UPDATE_CONTRACTS=1, a failure otherwise. */
export const checkNoOrphans = (dir: string, produced: Iterable<string>) => {
  const path = join(CONTRACTS_DIR, dir)
  const wanted = new Set(produced)
  const present = existsSync(path) ? readdirSync(path) : []
  const orphans = present.filter((f) => !wanted.has(f))
  if (UPDATE) {
    for (const f of orphans) rmSync(join(path, f))
    return
  }
  expect(orphans, `contracts/stock/${dir} has snapshots nothing produces any more`).toEqual([])
}
