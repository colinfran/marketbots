import type { AlpacaCalendarDay } from "@mb/stock-core/alpaca"
import { marketDay, marketTime } from "@mb/stock-core/time"
import type { Alpaca } from "../alpaca/client"

/** Today's regular session from Alpaca's market calendar (handles holidays and early closes). */
export type Session = {
  day: string
  is_trading_day: boolean
  open: Date | null
  close: Date | null
  open_et: string | null
  close_et: string | null
  early_close: boolean
}

const CALENDAR_TTL_MS = 12 * 3_600_000
const calendarCache = new Map<string, { at: number; days: AlpacaCalendarDay[] }>()

/** The market calendar rarely changes, so it's kept in memory for 12 hours. */
export const getCalendar = async (alpaca: Pick<Alpaca, "getCalendar">, start: string, end: string): Promise<AlpacaCalendarDay[]> => {
  const key = `${start}:${end}`
  const hit = calendarCache.get(key)
  if (hit && Date.now() - hit.at < CALENDAR_TTL_MS) return hit.days
  try {
    const days = await alpaca.getCalendar(start, end)
    calendarCache.set(key, { at: Date.now(), days })
    return days
  } catch (error) {
    // A stale calendar beats none while Alpaca is briefly unreachable.
    if (hit) return hit.days
    throw error
  }
}

/** Forgets cached calendars (tests). */
export const clearCalendarCache = () => calendarCache.clear()

export const getSession = async (alpaca: Pick<Alpaca, "getCalendar">, now: Date = new Date()): Promise<Session> => {
  const day = marketDay(now)
  const calendar = await getCalendar(alpaca, day, day)
  const today = calendar.find((c) => c.date === day)
  if (!today) {
    return { day, is_trading_day: false, open: null, close: null, open_et: null, close_et: null, early_close: false }
  }
  return {
    day,
    is_trading_day: true,
    open: marketTime(day, today.open),
    close: marketTime(day, today.close),
    open_et: today.open,
    close_et: today.close,
    early_close: today.close !== "16:00",
  }
}

export const isSessionOpen = (session: Session, now: Date = new Date()) => !!session.open && !!session.close && session.open <= now && now < session.close
