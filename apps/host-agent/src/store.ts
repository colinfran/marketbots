import { DatabaseSync } from "node:sqlite"
import type { CommandStatus } from "@mb/core/db"
import {
  HOST_MINUTE_KEEP_MS,
  HOST_RANGES,
  HOST_RAW_KEEP_MS,
  type EnergyPeriod,
  type HostCommand,
  type HostCommandDoc,
  type HostCommandView,
  type HostHistoryView,
  type HostRange,
  type HostSampleDoc,
  type HostSampleGpu,
  type HostStatusDoc,
} from "@mb/core/host"
import { chartPoints } from "./samples"

/**
 * What the agent keeps, all on the server (docs/SERVER.md §11): the latest reading in memory, and
 * in a SQLite file the chart samples (one per reading for a little over an hour, minute averages for
 * 30 days) and the owner's commands with their outcomes (30 days). Expired rows are deleted once a
 * minute. The agent's API (api.ts) serves it to the dashboards.
 */

const DAY_MS = 86_400_000

/** How long a command and its outcome are kept. */
const COMMAND_KEEP_MS = 30 * DAY_MS

/** The most samples a range drawn as recorded returns. */
const MAX_RAW_POINTS = 5_000

const PRUNE_MS = 60_000

export type EnergyTotals = { today_recorded_kwh: number | null; last_24h: EnergyPeriod; last_7d: EnergyPeriod; last_30d: EnergyPeriod }

type SampleRow = { t: number; cpu: number | null; cpu_temp: number | null; memory: number | null; watts: number | null; gpus: string }
type CommandRow = { id: string; type: HostCommand["type"]; status: CommandStatus; result: string | null; error: string | null }

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS samples (
    id TEXT PRIMARY KEY,
    res TEXT NOT NULL,
    t INTEGER NOT NULL,
    cpu REAL,
    cpu_temp REAL,
    memory REAL,
    watts REAL,
    gpus TEXT NOT NULL,
    wh REAL,
    covered_ms INTEGER NOT NULL,
    outlet_id TEXT
  );
  CREATE INDEX IF NOT EXISTS samples_res_t ON samples (res, t);
  CREATE INDEX IF NOT EXISTS samples_energy ON samples (res, outlet_id, t);
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    command TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL,
    processed_at INTEGER,
    result TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS commands_created_at ON commands (created_at);
`

const ENERGY_WINDOWS = ["today", "last_24h", "last_7d", "last_30d"] as const

export class HostStore {
  private readonly db: DatabaseSync
  private status: HostStatusDoc | null = null
  private prunedAt = 0

  /** `file`: the SQLite file (created if missing), or ":memory:". */
  constructor(file: string) {
    this.db = new DatabaseSync(file)
    // WAL: the history import can write while the agent runs.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")
    this.db.exec(SCHEMA)
  }

  /** The latest reading and any finished samples. */
  write(status: HostStatusDoc, samples: HostSampleDoc[]) {
    this.status = status
    this.writeSamples(samples)
    this.prune(status.at.getTime())
  }

  /** Samples: replacing any with the same bucket, or with `keep`, only where there is none (the history import). */
  writeSamples(samples: HostSampleDoc[], { keep = false } = {}) {
    if (!samples.length) return
    const insert = this.db.prepare(
      `INSERT OR ${keep ? "IGNORE" : "REPLACE"} INTO samples (id, res, t, cpu, cpu_temp, memory, watts, gpus, wh, covered_ms, outlet_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.transaction(() => {
      for (const s of samples) insert.run(s._id, s.res, s.t.getTime(), s.cpu, s.cpu_temp, s.memory, s.watts, JSON.stringify(s.gpus), s.wh, s.covered_ms, s.outlet_id)
    })
  }

  /** The latest reading, or null before the first. */
  latest(): HostStatusDoc | null {
    return this.status
  }

  /** A range's chart points up to `now`. */
  history(range: HostRange, now: number): HostHistoryView {
    const r = HOST_RANGES[range]
    const rows = this.db
      .prepare("SELECT t, cpu, cpu_temp, memory, watts, gpus FROM samples WHERE res = ? AND t >= ? ORDER BY t LIMIT ?")
      .all(r.res, now - r.ms, r.bin_s === 0 ? MAX_RAW_POINTS : -1) as SampleRow[]
    return chartPoints(
      range,
      rows.map((row) => ({ ...row, gpus: JSON.parse(row.gpus) as HostSampleGpu[] })),
    )
  }

  /** Recorded use of one outlet from the minute samples: since `dayStart`, and over the last 24 hours, 7 and 30 days. */
  energy(outlet: string, now: number, dayStart: number): EnergyTotals {
    const windows: Record<(typeof ENERGY_WINDOWS)[number], number> = { today: now - dayStart, last_24h: DAY_MS, last_7d: 7 * DAY_MS, last_30d: 30 * DAY_MS }
    // TOTAL: 0 for no rows; a minute without energy (wh null) counts its coverage only.
    const sums = ENERGY_WINDOWS.map((n) => `TOTAL(CASE WHEN t >= ? THEN wh END) AS ${n}_wh, TOTAL(CASE WHEN t >= ? THEN covered_ms END) AS ${n}_ms`).join(", ")
    const row = this.db
      .prepare(`SELECT ${sums} FROM samples WHERE res = '1m' AND outlet_id = ? AND t >= ?`)
      .get(...ENERGY_WINDOWS.flatMap((n) => [now - windows[n], now - windows[n]]), outlet, now - 30 * DAY_MS) as Record<string, number>
    const period = (name: (typeof ENERGY_WINDOWS)[number]): EnergyPeriod => {
      const ms = row[`${name}_ms`]
      return { kwh: ms ? row[`${name}_wh`] / 1000 : null, recorded_ms: ms, window_ms: windows[name] }
    }
    return { today_recorded_kwh: period("today").kwh, last_24h: period("last_24h"), last_7d: period("last_7d"), last_30d: period("last_30d") }
  }

  /** A new command, pending; false if its id is taken. */
  addCommand(doc: HostCommandDoc): boolean {
    const added = this.db
      .prepare("INSERT OR IGNORE INTO commands (id, type, command, created_at, created_by, status, processed_at, result, error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)")
      .run(doc._id, doc.type, JSON.stringify(doc.command), doc.created_at.getTime(), doc.created_by, doc.status)
    return added.changes > 0
  }

  /** A command's progress or outcome. */
  setCommand(id: string, status: CommandStatus, result: string | null, error: string | null, at = Date.now()) {
    this.db.prepare("UPDATE commands SET status = ?, result = ?, error = ?, processed_at = ? WHERE id = ?").run(status, result, error, at, id)
  }

  /** What the page polls of a command. */
  command(id: string): HostCommandView | null {
    const row = this.db.prepare("SELECT id, type, status, result, error FROM commands WHERE id = ?").get(id) as CommandRow | undefined
    return row ? { _id: row.id, type: row.type, status: row.status, result: row.result, error: row.error } : null
  }

  /** Deletes expired samples and commands, at most once a minute. */
  prune(now: number) {
    if (now - this.prunedAt < PRUNE_MS) return
    this.prunedAt = now
    this.db.prepare("DELETE FROM samples WHERE (res = 'raw' AND t < ?) OR (res = '1m' AND t < ?)").run(now - HOST_RAW_KEEP_MS, now - HOST_MINUTE_KEEP_MS)
    this.db.prepare("DELETE FROM commands WHERE created_at < ?").run(now - COMMAND_KEEP_MS)
  }

  close() {
    this.db.close()
  }

  private transaction(work: () => void) {
    this.db.exec("BEGIN")
    try {
      work()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}
