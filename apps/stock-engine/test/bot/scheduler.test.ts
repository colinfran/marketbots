import type { CycleDoc } from "@mb/stock-core/db"
import { DEFAULT_SETTINGS, mergeSettings, type Phase, type Settings } from "@mb/stock-core/settings"
import { describe, expect, it } from "vitest"
import { planPhase as planWith } from "../../src/bot/scheduler"
import { useTestDb } from "../helpers/db"
import { afterOpen, beforeClose, CLOSE, closedSession, cycleDoc, session } from "../helpers/factories"

const db = useTestDb()
const planPhase = (s: Parameters<typeof planWith>[2], now: Date, settings: Settings = DEFAULT_SETTINGS) => planWith(db.col, settings, s, now)
const plan = (now: Date) => planPhase(session(), now)

const seed = async (...cycles: Partial<CycleDoc>[]) => {
  await db.col.cycles.insertMany(cycles.map((r) => cycleDoc(r)))
}

/** A cycle of `phase` that started `minutes` after the open. */
const at = (phase: Phase, minutes: number, status: CycleDoc["status"] = "succeeded"): Partial<CycleDoc> => ({ phase, status, started_at: afterOpen(minutes) })
const briefed = () => seed(at("premarket", -60))

describe("non-trading days", () => {
  it("does nothing on weekends and holidays", async () => {
    expect(await planPhase(closedSession(), afterOpen(60))).toEqual({ phase: null, reason: "Market is closed today (weekend or holiday)." })
    expect(await planPhase(session({ open: null }), afterOpen(60))).toMatchObject({ phase: null })
  })
})

describe("premarket", () => {
  it("waits until 90 minutes before the open", async () => {
    expect(await plan(afterOpen(-91))).toEqual({ phase: null, reason: "Premarket briefing starts 90 min before the open." })
    expect(await plan(afterOpen(-90))).toEqual({ phase: "premarket", reason: "Premarket briefing." })
    expect(await plan(afterOpen(-1))).toMatchObject({ phase: "premarket" })
  })

  it("runs once", async () => {
    await briefed()
    expect(await plan(afterOpen(-30))).toEqual({ phase: null, reason: "Briefing done; waiting for the open." })
  })

  it("retries a failed briefing up to 3 attempts", async () => {
    await seed(at("premarket", -80, "failed"), at("premarket", -75, "timed_out"))
    expect(await plan(afterOpen(-70))).toMatchObject({ phase: "premarket" })
    await seed(at("premarket", -70, "failed"))
    expect(await plan(afterOpen(-60))).toMatchObject({ phase: null })
  })

  it("catches up on a missed briefing after the open", async () => {
    expect(await plan(afterOpen(60))).toEqual({ phase: "premarket", reason: "No briefing yet today; catching up before trading." })
  })

  it("moves on to trading once the briefing has failed 3 times", async () => {
    await seed(at("premarket", -80, "failed"), at("premarket", -70, "failed"), at("premarket", -60, "failed"))
    expect(await plan(afterOpen(15))).toEqual({ phase: "intraday", reason: "Intraday trading cycle." })
  })

  it("ignores runs from other days", async () => {
    await seed({ ...at("premarket", -60), trading_day: "2026-10-23" })
    expect(await plan(afterOpen(-30))).toMatchObject({ phase: "premarket" })
  })
})

describe("intraday", () => {
  it("lets the opening auction settle for 10 minutes", async () => {
    await briefed()
    expect(await plan(afterOpen(0))).toEqual({ phase: null, reason: "Letting the opening auction settle." })
    expect(await plan(afterOpen(9.9))).toMatchObject({ phase: null })
    expect(await plan(afterOpen(10))).toEqual({ phase: "intraday", reason: "Intraday trading cycle." })
  })

  it("runs every 30 minutes, with 30 seconds of slack for the scheduler's tick", async () => {
    await briefed()
    await seed(at("intraday", 10))
    expect(await plan(afterOpen(30))).toEqual({ phase: null, reason: "Next intraday cycle in ~10 min." })
    expect(await plan(afterOpen(39.4))).toMatchObject({ phase: null })
    expect(await plan(afterOpen(39.5))).toEqual({ phase: "intraday", reason: "Intraday trading cycle." })
  })

  it("ignores core book reviews, which run in the cycle slot but are no phase of the day", async () => {
    await briefed()
    await seed(at("intraday", 10), { ...at("intraday", 35), kind: "core" }, { ...at("intraday", 38, "running"), kind: "core" })
    expect(await plan(afterOpen(39.5))).toEqual({ phase: "intraday", reason: "Intraday trading cycle." })
  })

  it("measures from the latest successful cycle", async () => {
    await briefed()
    await seed(at("intraday", 10), at("intraday", 40), at("intraday", 70))
    expect(await plan(afterOpen(90))).toEqual({ phase: null, reason: "Next intraday cycle in ~10 min." })
  })

  it("retries a failed cycle after 4 minutes", async () => {
    await briefed()
    await seed(at("intraday", 10), at("intraday", 40, "failed"))
    expect(await plan(afterOpen(43))).toEqual({ phase: null, reason: "Next intraday retry in ~1 min." })
    expect(await plan(afterOpen(44))).toEqual({ phase: "intraday", reason: "Retrying the failed intraday cycle." })
  })

  it("treats a timed-out cycle as failed", async () => {
    await briefed()
    await seed(at("intraday", 10), at("intraday", 40, "timed_out"))
    expect(await plan(afterOpen(44))).toMatchObject({ phase: "intraday", reason: "Retrying the failed intraday cycle." })
  })

  it("retries the first cycle of the day when it fails", async () => {
    await briefed()
    await seed(at("intraday", 10, "failed"))
    expect(await plan(afterOpen(14))).toMatchObject({ phase: "intraday", reason: "Retrying the failed intraday cycle." })
  })

  it("falls back to the normal cadence after 2 quick retries", async () => {
    await briefed()
    await seed(at("intraday", 10), at("intraday", 40, "failed"), at("intraday", 44, "failed"))
    expect(await plan(afterOpen(48))).toMatchObject({ phase: "intraday" }) // 2nd retry

    await seed(at("intraday", 48, "failed"))
    expect(await plan(afterOpen(52))).toEqual({ phase: null, reason: "Next intraday retry in ~26 min." })
    expect(await plan(afterOpen(77.5))).toMatchObject({ phase: "intraday", reason: "Retrying the failed intraday cycle." })
  })

  it("only counts failures since the last success", async () => {
    await briefed()
    await seed(at("intraday", 10, "failed"), at("intraday", 14, "failed"), at("intraday", 18, "failed"), at("intraday", 22), at("intraday", 52, "failed"))
    expect(await plan(afterOpen(56))).toMatchObject({ phase: "intraday", reason: "Retrying the failed intraday cycle." })
  })

  it("never starts a cycle while one is still running", async () => {
    await briefed()
    await seed(at("intraday", 10), at("intraday", 38, "running"))
    expect(await plan(afterOpen(70))).toEqual({ phase: null, reason: "An intraday cycle is running." })
  })

  it("counts a skipped cycle (e.g. AI budget exhausted) as done", async () => {
    await briefed()
    await seed(at("intraday", 10, "skipped"))
    expect(await plan(afterOpen(14))).toMatchObject({ phase: null, reason: "Next intraday cycle in ~26 min." })
  })

  it("uses the trade interval from settings", async () => {
    const settings = mergeSettings(DEFAULT_SETTINGS, { schedule: { trade_interval_minutes: 15 } }) as Settings
    await briefed()
    await seed(at("intraday", 10))
    expect(await planPhase(session(), afterOpen(22), settings)).toMatchObject({ phase: null, reason: "Next intraday cycle in ~3 min." })
    expect(await planPhase(session(), afterOpen(24.5), settings)).toMatchObject({ phase: "intraday" })
  })
})

describe("close", () => {
  it("runs once in the window from 25 to 3 minutes before the bell", async () => {
    await briefed()
    await seed(at("intraday", 340))
    expect(await plan(beforeClose(25.5))).toMatchObject({ phase: null })
    expect(await plan(beforeClose(25))).toEqual({ phase: "close", reason: "Closing cycle." })
    expect(await plan(beforeClose(3.5))).toEqual({ phase: "close", reason: "Closing cycle." })
    expect(await plan(beforeClose(3))).toEqual({ phase: null, reason: "Closing cycle done; waiting for the bell." })
  })

  it("takes priority over a due intraday cycle", async () => {
    await briefed()
    await seed(at("intraday", 300))
    expect(await plan(beforeClose(20))).toMatchObject({ phase: "close" })
  })

  it("doesn't repeat after success, and stops after 3 failures", async () => {
    await briefed()
    await seed(at("close", 366))
    expect(await plan(beforeClose(15))).toEqual({ phase: null, reason: "Closing cycle done; waiting for the bell." })

    await db.col.cycles.deleteMany({ phase: "close" })
    await seed(at("close", 366, "failed"), at("close", 370, "failed"))
    expect(await plan(beforeClose(15))).toMatchObject({ phase: "close" })
    await seed(at("close", 375, "failed"))
    expect(await plan(beforeClose(10))).toMatchObject({ phase: null })
  })

  it("runs the closing cycle instead of catching up a missed briefing", async () => {
    expect(await plan(beforeClose(26))).toMatchObject({ phase: "premarket" })
    expect(await plan(beforeClose(25))).toEqual({ phase: "close", reason: "Closing cycle." })
    expect(await plan(beforeClose(2))).toEqual({ phase: null, reason: "Closing cycle done; waiting for the bell." })
  })
})

describe("postmarket", () => {
  const afterClose = (minutes: number) => new Date(CLOSE.getTime() + minutes * 60_000)

  it("waits 10 minutes after the bell, then reviews the day once", async () => {
    expect(await plan(afterClose(0))).toEqual({ phase: null, reason: "Waiting to run the postmarket review." })
    expect(await plan(afterClose(9))).toMatchObject({ phase: null, reason: "Waiting to run the postmarket review." })
    expect(await plan(afterClose(10))).toEqual({ phase: "postmarket", reason: "Postmarket review." })
    await seed({ phase: "postmarket", status: "succeeded", started_at: afterClose(10) })
    expect(await plan(afterClose(20))).toEqual({ phase: null, reason: "Trading day complete." })
  })

  it("gives up 6 hours after the close", async () => {
    expect(await plan(afterClose(359))).toMatchObject({ phase: "postmarket" })
    expect(await plan(afterClose(360))).toEqual({ phase: null, reason: "Trading day complete." })
  })

  it("stops after 3 failed reviews", async () => {
    await seed(
      { phase: "postmarket", status: "failed", started_at: afterClose(10) },
      { phase: "postmarket", status: "failed", started_at: afterClose(15) },
      { phase: "postmarket", status: "failed", started_at: afterClose(20) },
    )
    expect(await plan(afterClose(25))).toEqual({ phase: null, reason: "Trading day complete." })
  })
})
