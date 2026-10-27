import type { CoreReviewDoc } from "@mb/stock-core/db"
import { DEFAULT_SETTINGS, mergeSettings, type Settings, type SettingsPatch } from "@mb/stock-core/settings"
import { marketTime } from "@mb/stock-core/time"
import { describe, expect, it } from "vitest"
import { coreReviewDue, reviewSlotDay } from "../../src/core-book/schedule"
import { useTestDb } from "../helpers/db"
import { session } from "../helpers/factories"

const db = useTestDb()
const settings = (patch: SettingsPatch = {}) => mergeSettings(mergeSettings(DEFAULT_SETTINGS, { core: { enabled: true } }) as Settings, patch) as Settings

/** A NY session on `day` (09:30–16:00 ET, or an early close). */
const on = (day: string, close = "16:00") => session({ day, open: marketTime(day, "09:30"), close: marketTime(day, close), close_et: close, early_close: close !== "16:00" })
const at = (day: string, time: string) => marketTime(day, time)

const reviewDoc = (o: Partial<CoreReviewDoc>): CoreReviewDoc => ({
  _id: `r-${Math.random()}`,
  cycle_id: "c",
  kind: "weekly",
  trigger: "schedule",
  symbol: null,
  dry_run: false,
  status: "done",
  trading_day: "2026-10-26",
  created_at: at("2026-10-26", "10:15"),
  finished_at: null,
  book_before: null,
  book_after: null,
  adopted: [],
  ranking: null,
  context: null,
  research: null,
  output: null,
  decisions: [],
  summary: null,
  watch: [],
  model: null,
  cost_usd: 0,
  error: null,
  settings_version: 1,
  ...o,
})

const due = (s: Settings, day: string, time: string, close?: string) => coreReviewDue(db.col, s, on(day, close), at(day, time))

describe("reviewSlotDay", () => {
  it("is the latest review weekday on or before the day", () => {
    expect(reviewSlotDay("2026-10-26", "mon")).toBe("2026-10-26") // Monday
    expect(reviewSlotDay("2026-10-29", "mon")).toBe("2026-10-26") // Thursday
    expect(reviewSlotDay("2026-10-26", "fri")).toBe("2026-10-23") // Monday → last Friday
    expect(reviewSlotDay("2026-10-30", "wed")).toBe("2026-10-28")
  })
})

describe("coreReviewDue", () => {
  it("runs on the review weekday from the review time, inside the regular session", async () => {
    expect(await due(settings(), "2026-10-26", "10:14")).toEqual({ due: false, reason: "The core review runs at 10:15 ET." })
    expect(await due(settings(), "2026-10-26", "10:15")).toEqual({ due: true, reason: "Weekly core review." })
    expect(await due(settings(), "2026-10-26", "15:40")).toEqual({ due: false, reason: "Outside the review window." })
    expect(await due(settings({ core: { enabled: false } }), "2026-10-26", "10:30")).toMatchObject({ due: false, reason: "The core book is off." })
    expect(await coreReviewDue(db.col, settings(), { ...on("2026-10-26"), is_trading_day: false, open: null, close: null }, at("2026-10-26", "10:30"))).toMatchObject({ due: false })
  })

  it("runs once a week", async () => {
    await db.col.coreReviews.insertOne(reviewDoc({ status: "done" }))
    expect(await due(settings(), "2026-10-26", "11:00")).toMatchObject({ due: false, reason: "This week's core review is done." })
    expect(await due(settings(), "2026-10-29", "11:00")).toMatchObject({ due: false })
    // The next Monday is a new week.
    expect(await due(settings(), "2026-11-02", "10:15")).toEqual({ due: true, reason: "Weekly core review." })
  })

  it("catches up on a missed slot the next trading day, one attempt a day", async () => {
    // Monday was a holiday (no attempt): Tuesday at the review time.
    expect(await due(settings(), "2026-10-27", "10:15")).toEqual({ due: true, reason: "Weekly core review (catching up on 2026-10-26)." })
    await db.col.coreReviews.insertOne(reviewDoc({ status: "failed", trading_day: "2026-10-27", created_at: at("2026-10-27", "10:15") }))
    expect(await due(settings(), "2026-10-27", "13:00")).toMatchObject({ due: false, reason: "Today's core review attempt didn't finish; the next trading day tries again." })
    expect(await due(settings(), "2026-10-28", "10:15")).toMatchObject({ due: true })
  })

  it("doesn't count dry runs or single-holding reviews, and waits while one runs", async () => {
    await db.col.coreReviews.insertMany([reviewDoc({ dry_run: true }), reviewDoc({ kind: "holding" })])
    expect(await due(settings(), "2026-10-26", "10:30")).toMatchObject({ due: true })
    await db.col.coreReviews.insertOne(reviewDoc({ status: "running" }))
    expect(await due(settings(), "2026-10-26", "10:30")).toMatchObject({ due: false, reason: "This week's core review is done." })
  })

  it("moves to the next day when an early close leaves no room after the review time", async () => {
    // Friday after Thanksgiving closes at 13:00: 12:45 is inside the closing window.
    const late = settings({ core: { review_weekday: "fri", review_time_et: "12:45" } })
    expect(await due(late, "2026-11-27", "12:45", "13:00")).toMatchObject({ due: false, reason: "Outside the review window." })
    expect(await due(late, "2026-11-30", "12:45")).toEqual({ due: true, reason: "Weekly core review (catching up on 2026-11-27)." })
  })
})
