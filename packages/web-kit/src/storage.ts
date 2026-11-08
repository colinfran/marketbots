import "server-only"
import { DB_STORAGE_ALERT_PCTS, DB_STORAGE_BUDGET_BYTES, type DatabaseStorageView } from "@mb/core/db"
import type { MongoClient } from "mongodb"

const SYSTEM_DATABASES = new Set(["admin", "local", "config"])
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/** A size dbStats reported (a number or a Long), or null. */
const size = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

type Disk = NonNullable<DatabaseStorageView["disk"]>

/**
 * Admin → System's database card: the server's MongoDB (both bots' databases; each dashboard sees
 * the whole server), from `listDatabases` and each database's `dbStats`, which also reports the
 * filesystem the data is on. A failure is shown on the card, never thrown, so the Admin page still
 * renders.
 */
export const databaseStorage = async (client: MongoClient): Promise<DatabaseStorageView> => {
  try {
    const { databases, totalSize } = await client.db("admin").admin().listDatabases()
    const stats = await Promise.all(
      databases
        .map((d) => d.name)
        .filter((name) => !SYSTEM_DATABASES.has(name))
        .map(async (name) => ({ name, stats: await client.db(name).stats() })),
    )
    const sizes = stats.map(({ name, stats: s }) => ({ name, bytes: Number(s.totalSize ?? (s.storageSize ?? 0) + (s.indexSize ?? 0)) }))
    // listDatabases' total also counts the system databases; never less than the bots' own.
    const sum = sizes.reduce((total, d) => total + d.bytes, 0)
    // Every database is on the same filesystem: the first one that reports it will do.
    const disk = stats
      .map(({ stats: s }) => ({ used_bytes: size(s.fsUsedSize), total_bytes: size(s.fsTotalSize) }))
      .find((d): d is Disk => d.used_bytes !== null && d.total_bytes !== null)
    return {
      used_bytes: Math.max(Number(totalSize ?? 0), sum),
      budget_bytes: DB_STORAGE_BUDGET_BYTES,
      databases: sizes.sort((a, b) => b.bytes - a.bytes),
      disk: disk ?? null,
      error: null,
    }
  } catch (error) {
    return { used_bytes: null, budget_bytes: DB_STORAGE_BUDGET_BYTES, databases: [], disk: null, error: message(error) }
  }
}

/** The databases' share of the budget, in percent, or null when they couldn't be read. */
export const budgetPercent = (view: DatabaseStorageView) => (view.used_bytes === null ? null : (view.used_bytes / view.budget_bytes) * 100)

/** The highest alert level (a percentage of the budget) the databases have reached, or null. */
export const storageAlertLevel = (view: DatabaseStorageView): number | null => {
  const pct = budgetPercent(view)
  return pct === null ? null : (DB_STORAGE_ALERT_PCTS.find((level) => pct >= level) ?? null)
}

const formatSize = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`)

type SendAlert = (alert: { title: string; message: string; fields?: Record<string, string | undefined>; path?: string; key?: string }) => Promise<void>

/**
 * The budget's watch, started by each dashboard at server start (instrumentation.ts): a minute after
 * the start, then hourly, it checks the databases against the budget and alerts on the bot's Discord
 * channel when they reach 80% or 90% of it, again on reaching the higher level, and once a day while
 * they stay there. A restart (each dashboard deploy) can repeat that day's alert. An unreadable
 * database alerts nothing: the Admin card shows the error.
 */
export const watchDatabaseStorage = ({ client, sendAlert, now = Date.now }: { client: () => MongoClient; sendAlert: SendAlert; now?: () => number }) => {
  let last: { level: number; at: number } | null = null

  const check = async () => {
    let view: DatabaseStorageView
    try {
      view = await databaseStorage(client())
    } catch {
      return // No MONGODB_URI (local dev without a database).
    }
    const level = storageAlertLevel(view)
    if (level === null) {
      last = null
      return
    }
    if (last && last.level >= level && now() - last.at < DAY) return
    last = { level, at: now() }
    await sendAlert({
      title: `Database storage at ${Math.floor(budgetPercent(view) ?? 0)}% of its budget`,
      message: `Both bots' databases take ${formatSize(view.used_bytes ?? 0)} of their ${formatSize(view.budget_bytes)} budget. Nothing is refused at the budget, but the disk keeps filling: see Admin → System.`,
      fields: Object.fromEntries(view.databases.map((d) => [d.name, formatSize(d.bytes)])),
      path: "/admin",
      key: `storage|${level}`,
    })
  }

  const first = setTimeout(() => void check(), MINUTE)
  const timer = setInterval(() => void check(), HOUR)
  // Never keep the process alive on their own.
  for (const t of [first, timer]) (t as { unref?: () => void }).unref?.()
  return {
    check,
    stop: () => {
      clearTimeout(first)
      clearInterval(timer)
    },
  }
}
