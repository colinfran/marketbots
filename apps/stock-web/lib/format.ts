/**
 * Display formatting, shared by server and client components. Times show in the owner's time zone
 * (NEXT_PUBLIC_DISPLAY_TIMEZONE, Pacific), like crypto's dashboard. Market hours (the session's open,
 * close and next open) also give New York time, the market's own, in parentheses:
 * "6:30 AM (9:30 AM ET)". Trading days stay New York dates (@mb/stock-core/time marketDay).
 */

import { MARKET_TZ } from "@mb/stock-core/time"
import { zonedFormat } from "@mb/ui/lib/format"

export { ago, duration, num, pct, titleCase, tone, until, usd } from "@mb/ui/lib/format"

export const qty = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(4))

export const price = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : `$${value.toFixed(2)}`)

const WIRE_SOURCE_LABEL: Record<string, string> = { alpaca_news: "Benzinga via Alpaca" }

/** Who published a news-engine item: Benzinga headlines reach us through Alpaca, so both get the credit. */
export const wireSource = (source: string, domain?: string | null) => WIRE_SOURCE_LABEL[source] ?? domain ?? source

export const TIME_ZONE = process.env.NEXT_PUBLIC_DISPLAY_TIMEZONE || "America/Los_Angeles"

/** "10:30:15 AM" (live feeds) and "Oct 26, 10:30 AM", in the owner's time zone. */
export const { time, dateTime } = zonedFormat(TIME_ZONE)

type When = Date | string | number

const clockFormat = (timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
const localClock = clockFormat(TIME_ZONE)
const nyClock = clockFormat(MARKET_TZ)
const localDayClock = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

/** "9:16 PM" in the owner's time zone. */
export const clock = (value: When) => localClock.format(new Date(value))

/** "Nov 20, 6:30 AM" in the owner's time zone. */
export const dayClock = (value: When) => localDayClock.format(new Date(value))

/** A market time: "1:00 PM (4:00 PM ET)". */
export const sessionTime = (value: When) => `${clock(value)} (${nyClock.format(new Date(value))} ET)`

/** A market date and time: "Nov 20, 6:30 AM (9:30 AM ET)". */
export const sessionDayTime = (value: When) => `${dayClock(value)} (${nyClock.format(new Date(value))} ET)`

/** A session: "Nov 20, 6:30 AM – 1:00 PM (9:30 AM – 4:00 PM ET)". */
export const sessionHours = (open: When, close: When) =>
  `${dayClock(open)} – ${clock(close)} (${nyClock.format(new Date(open))} – ${nyClock.format(new Date(close))} ET)`

/** Where a decision's reasoning lives: the agent's episode (decisions from before the agent keep only their own rationale). */
export const decisionHref = (d: { agent_episode_id?: string | null }) => (d.agent_episode_id ? `/agent/${d.agent_episode_id}` : null)
