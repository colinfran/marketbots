import type { HistoryJobStatus } from "@mb/core/db"
import { errorMessage } from "@mb/engine-kit/log"
import type { Sql } from "./sql"

/** A job's saved progress and when it was last saved, or null if it never ran. */
export const loadJob = async <T>(sql: Sql, name: string): Promise<{ state: T; updated_at: Date } | null> =>
  (await sql.query<{ state: T; updated_at: Date }>("select state, updated_at from jobs where name = $1", [name])).rows[0] ?? null

export const saveJob = async (sql: Sql, name: string, state: unknown, now = new Date()) => {
  await sql.query("insert into jobs (name, state, updated_at) values ($1, $2::jsonb, $3) on conflict (name) do update set state = excluded.state, updated_at = excluded.updated_at", [name, JSON.stringify(state), now])
}

/**
 * A long-running job (a backfill, a nightly refresh). Each `step` does a bounded piece of work,
 * saves its own progress with saveJob, and says whether it's done, so a restart resumes where it
 * stopped and other work runs between steps.
 */
export type HistoryJob = {
  name: string
  /** Not done and nothing to do yet (waiting on another job): `waitMs` defers the next step. */
  step: (sql: Sql) => Promise<{ done: boolean; progress: string; waitMs?: number }>
  /** Once done, how long until it runs again (null: never, until the engine restarts). */
  repeatMs: number | null
}

/** After a failed step, the job waits this long before trying again. */
const RETRY_MS = 5 * 60_000
/** A pause between steps, so jobs never hold the database or the event loop for long. */
const PAUSE_MS = 250

/** Runs jobs one step at a time, one job at a time, in the order they were added. */
export class JobRunner {
  private readonly jobs: { job: HistoryJob; status: HistoryJobStatus; nextAt: number }[] = []
  private running = false
  private stopped = false

  add(job: HistoryJob) {
    this.jobs.push({ job, status: { name: job.name, state: "waiting", progress: "", updated_at: null, error: null }, nextAt: 0 })
  }

  status(): HistoryJobStatus[] {
    return this.jobs.map((j) => ({ ...j.status }))
  }

  stop() {
    this.stopped = true
  }

  /** Steps every due job until none is due; returns at once if a pass is already running. */
  async pass(sql: Sql, now: () => number = Date.now) {
    if (this.running || this.stopped) return
    this.running = true
    try {
      for (;;) {
        const due = this.jobs.find((j) => j.nextAt <= now())
        if (!due || this.stopped) return
        due.status.state = "running"
        try {
          const r = await due.job.step(sql)
          due.status = { name: due.job.name, state: r.done ? "done" : "running", progress: r.progress, updated_at: new Date(now()), error: null }
          if (r.done) due.nextAt = due.job.repeatMs === null ? Number.POSITIVE_INFINITY : now() + due.job.repeatMs
          else if (r.waitMs) {
            due.nextAt = now() + r.waitMs
            due.status.state = "waiting"
          }
        } catch (error) {
          due.status = { ...due.status, state: "failed", updated_at: new Date(now()), error: errorMessage(error) }
          due.nextAt = now() + RETRY_MS
        }
        await new Promise((r) => setTimeout(r, PAUSE_MS))
      }
    } finally {
      this.running = false
    }
  }
}
