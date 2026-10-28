import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { upsertDailyBars } from "../src/bars"
import { JobRunner, loadJob, saveJob, type HistoryJob } from "../src/jobs"
import { migrate } from "../src/migrations"
import { pglite } from "./helpers"

describe("JobRunner", () => {
  let sql: ReturnType<typeof pglite>
  beforeEach(async () => {
    sql = pglite()
    await migrate(sql)
    vi.useFakeTimers({ toFake: ["setTimeout"] })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await sql.close()
  })

  /** A job that needs `steps` steps and counts them in its saved state. */
  const counting = (name: string, steps: number, repeatMs: number | null = null, order: string[] = []): HistoryJob => ({
    name,
    repeatMs,
    step: async (s) => {
      const n = ((await loadJob<{ n: number }>(s, name))?.state.n ?? 0) + 1
      await saveJob(s, name, { n })
      order.push(name)
      return { done: n >= steps, progress: `${n}/${steps}` }
    },
  })

  const pass = async (runner: JobRunner, now: () => number) => {
    const p = runner.pass(sql, now)
    await vi.runAllTimersAsync()
    await p
  }

  it("runs jobs one at a time, in order, each until done, then leaves them", async () => {
    const order: string[] = []
    const runner = new JobRunner()
    runner.add(counting("a", 2, null, order))
    runner.add(counting("b", 1, null, order))
    await pass(runner, () => 1_000)
    expect(order).toEqual(["a", "a", "b"])
    expect(runner.status()).toMatchObject([
      { name: "a", state: "done", progress: "2/2", error: null },
      { name: "b", state: "done", progress: "1/1" },
    ])
    await pass(runner, () => 10_000_000)
    expect(order).toHaveLength(3)
  })

  it("resumes from the saved progress after a restart", async () => {
    await saveJob(sql, "a", { n: 2 })
    const runner = new JobRunner()
    runner.add(counting("a", 3))
    await pass(runner, () => 1_000)
    expect(runner.status()[0]).toMatchObject({ state: "done", progress: "3/3" })
  })

  it("runs a repeating job again once its interval has passed", async () => {
    const order: string[] = []
    const runner = new JobRunner()
    runner.add({ name: "daily", repeatMs: 60_000, step: async () => (order.push("daily"), { done: true, progress: "ok" }) })
    await pass(runner, () => 0)
    await pass(runner, () => 59_999)
    expect(order).toHaveLength(1)
    await pass(runner, () => 60_000)
    expect(order).toHaveLength(2)
  })

  it("parks a failing job for a while and lets the others run", async () => {
    const order: string[] = []
    const runner = new JobRunner()
    runner.add({ name: "broken", repeatMs: null, step: () => Promise.reject(new Error("source down")) })
    runner.add(counting("ok", 1, null, order))
    await pass(runner, () => 0)
    expect(runner.status()).toMatchObject([
      { name: "broken", state: "failed", error: "source down" },
      { name: "ok", state: "done" },
    ])
    await pass(runner, () => 60_000)
    expect(runner.status()[0]!.state).toBe("failed")
  })

  it("defers a waiting job by its waitMs", async () => {
    let calls = 0
    const runner = new JobRunner()
    runner.add({ name: "later", repeatMs: null, step: async () => (calls++, { done: false, progress: "waiting", waitMs: 300_000 }) })
    await pass(runner, () => 0)
    await pass(runner, () => 299_999)
    expect(calls).toBe(1)
    expect(runner.status()[0]!.state).toBe("waiting")
  })
})

describe("upsertDailyBars", () => {
  it("writes daily bars, replacing a repeated day, and skips unusable ones", async () => {
    const sql = pglite()
    await migrate(sql)
    const bar = { symbol: "BTC/USD", open: 1, high: 2, low: 0.5, close: 1.5, volume: 9, source: "kraken-file" }
    expect(await upsertDailyBars(sql, [{ ...bar, day: "2026-10-01" }, { ...bar, day: "2026-10-01", close: 1.7 }, { ...bar, day: "bad" }, { ...bar, day: "2026-10-02", close: 0 }])).toBe(1)
    await upsertDailyBars(sql, [{ ...bar, day: "2026-10-01", close: 1.8, source: "kraken" }])
    const rows = (await sql.query<{ day: Date; close: number; source: string }>("select day, close, source from bars_1d")).rows
    expect(rows).toEqual([{ day: new Date("2026-10-01T00:00:00Z"), close: 1.8, source: "kraken" }])
    await sql.close()
  })
})
