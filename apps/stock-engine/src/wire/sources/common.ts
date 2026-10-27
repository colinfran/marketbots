import { marketClock, marketDay } from "@mb/stock-core/time"

/**
 * Small helpers shared by the stock wave-2 sources: the ones both bots use (@mb/wire/sources/common:
 * which symbols a source covers, number and date formats, the browser User-Agent), and New York's
 * wall clock.
 */

export {
  BROWSER_HEADERS,
  count,
  dayStart,
  isMissing,
  isoDay,
  median,
  nextWeekdays,
  num,
  previousWeekdays,
  settleAll,
  shortDay,
  signed,
  tracked,
  usd,
  usDate,
  watched,
} from "@mb/wire/sources/common"

/** Weekday (0 Sunday … 6 Saturday) and wall-clock minutes in New York. */
export const etNow = (now: Date) => {
  const day = marketDay(now)
  const [h, m] = marketClock(now).split(":").map(Number)
  return { day, weekday: new Date(`${day}T12:00:00Z`).getUTCDay(), minutes: h * 60 + m }
}
