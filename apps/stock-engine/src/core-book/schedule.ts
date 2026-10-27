import type { Settings, Weekday } from "@mb/stock-core/settings"
import { addDays, marketTime, minutesBetween } from "@mb/stock-core/time"
import { isSessionOpen, type Session } from "../bot/session"
import type { Collections } from "../db/mongo"

/**
 * When the core book's weekly review runs: on `core.review_weekday`, from `core.review_time_et`,
 * inside the regular session (after the opening buffer, before the closing window). A slot that
 * can't run (a holiday, an early close, the engine down, a failed or skipped attempt) runs at the
 * same time on the next trading day, until the week's review is done; at most one attempt a day.
 * A week runs from one review weekday to the next. The owner's "Run core review now" counts as
 * the week's review; dry runs don't count.
 */

const WEEKDAY_INDEX: Record<Weekday, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5 }

/** 0 = Sunday, for a New York calendar day. */
const dayOfWeek = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay()

/** The day this week's review belongs to: the latest review weekday on or before `day`. */
export const reviewSlotDay = (day: string, weekday: Weekday) => addDays(day, -((dayOfWeek(day) - WEEKDAY_INDEX[weekday] + 7) % 7))

export type CoreSchedule = { due: boolean; reason: string }

export const coreReviewDue = async (col: Pick<Collections, "coreReviews">, settings: Settings, session: Session, now = new Date()): Promise<CoreSchedule> => {
  const c = settings.core
  const s = settings.schedule
  if (!c.enabled) return { due: false, reason: "The core book is off." }
  if (!isSessionOpen(session, now)) return { due: false, reason: "The market is closed." }
  if (-minutesBetween(now, session.open!) < s.open_buffer_minutes || minutesBetween(now, session.close!) <= s.close_window_minutes) return { due: false, reason: "Outside the review window." }
  if (now < marketTime(session.day, c.review_time_et)) return { due: false, reason: `The core review runs at ${c.review_time_et} ET.` }
  const slot = reviewSlotDay(session.day, c.review_weekday)
  const week = await col.coreReviews.find({ kind: "weekly", dry_run: false, created_at: { $gte: marketTime(slot, "00:00") } }, { projection: { status: 1, trading_day: 1 } }).toArray()
  if (week.some((r) => r.status === "done" || r.status === "running")) return { due: false, reason: "This week's core review is done." }
  if (week.some((r) => r.trading_day === session.day)) return { due: false, reason: "Today's core review attempt didn't finish; the next trading day tries again." }
  return { due: true, reason: slot === session.day ? "Weekly core review." : `Weekly core review (catching up on ${slot}).` }
}
