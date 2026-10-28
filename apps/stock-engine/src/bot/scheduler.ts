import type { Phase, Settings } from "@mb/stock-core/settings"
import { minutesBetween } from "@mb/stock-core/time"
import type { Collections } from "../db/mongo"
import type { Session } from "./session"

/**
 * Decides which phase (if any) is due right now. The engine asks every 30 seconds; this works out
 * the rest from the market calendar and the cycle history, so holidays, early closes and missed
 * cycles are handled automatically.
 *
 *   premarket   up to 90 min before the open (or as a catch-up if it never ran)
 *   intraday    every trade_interval_minutes from open + 10 min until the closing window
 *   close       once, 25 → 3 minutes before the bell
 *   postmarket  once, from 10 minutes after the bell
 */

export type PhasePlan = { phase: Phase | null; reason: string }

/** A failed intraday cycle is retried this soon, this many times, before waiting a full interval. */
const RETRY_DELAY_MINUTES = 4
const INTRADAY_RETRIES = 2

/** A skipped cycle (e.g. the AI is disabled) counts as done: retrying it soon wouldn't help. */
const isDone = (status: string) => status === "succeeded" || status === "skipped"

export const planPhase = async (col: Pick<Collections, "cycles">, settings: Settings, session: Session, now: Date = new Date()): Promise<PhasePlan> => {
  if (!session.is_trading_day || !session.open || !session.close) {
    return { phase: null, reason: "Market is closed today (weekend or holiday)." }
  }
  const s = settings.schedule
  // Core book reviews run in the cycle slot (as "intraday" cycles) but are no phase of the trading day.
  const today = await col.cycles.find({ trading_day: session.day, kind: { $ne: "core" } }, { projection: { phase: 1, status: 1, started_at: 1 } }).toArray()
  const canRun = (phase: Phase) => {
    const attempts = today.filter((r) => r.phase === phase)
    return !attempts.some((r) => isDone(r.status)) && !attempts.some((r) => r.status === "running") && attempts.length < s.max_phase_attempts
  }

  const toOpen = minutesBetween(now, session.open)
  const toClose = minutesBetween(now, session.close)

  if (toOpen > 0) {
    if (toOpen > s.premarket_lead_minutes) return { phase: null, reason: `Premarket briefing starts ${s.premarket_lead_minutes} min before the open.` }
    return canRun("premarket")
      ? { phase: "premarket", reason: "Premarket briefing." }
      : { phase: null, reason: "Briefing done; waiting for the open." }
  }

  if (toClose > 0) {
    // The closing cycle beats a late briefing: locking in the day matters more than a game plan.
    if (toClose <= s.close_window_minutes) {
      return toClose > 3 && canRun("close")
        ? { phase: "close", reason: "Closing cycle." }
        : { phase: null, reason: "Closing cycle done; waiting for the bell." }
    }
    if (canRun("premarket")) return { phase: "premarket", reason: "No briefing yet today; catching up before trading." }
    if (-toOpen < s.open_buffer_minutes) return { phase: null, reason: "Letting the opening auction settle." }
    // Half a minute of slack: the scheduler runs every 30 seconds.
    const interval = s.trade_interval_minutes - 0.5
    const intraday = today.filter((r) => r.phase === "intraday").sort((a, b) => b.started_at.getTime() - a.started_at.getTime())
    if (intraday[0]?.status === "running") return { phase: null, reason: "An intraday cycle is running." }
    const lastSuccess = intraday.find((r) => isDone(r.status))
    const sinceSuccess = lastSuccess ? minutesBetween(lastSuccess.started_at, now) : Infinity
    if (sinceSuccess < interval) return { phase: null, reason: `Next intraday cycle in ~${Math.ceil(interval - sinceSuccess)} min.` }

    // A cycle is owed. If the last attempt failed, retry after a short delay, up to
    // INTRADAY_RETRIES times, before falling back to the normal cadence.
    const last = intraday[0]
    if (!last) return { phase: "intraday", reason: "Intraday trading cycle." }
    const failedSinceSuccess = intraday.filter((r) => !isDone(r.status) && (!lastSuccess || r.started_at > lastSuccess.started_at)).length
    const lastFailed = last.status === "failed" || last.status === "timed_out"
    const wait = lastFailed && failedSinceSuccess <= INTRADAY_RETRIES ? RETRY_DELAY_MINUTES : interval
    const sinceLast = minutesBetween(last.started_at, now)
    if (sinceLast >= wait) return { phase: "intraday", reason: lastFailed ? "Retrying the failed intraday cycle." : "Intraday trading cycle." }
    return { phase: null, reason: `Next intraday ${lastFailed ? "retry" : "cycle"} in ~${Math.ceil(wait - sinceLast)} min.` }
  }

  const afterClose = -toClose
  if (afterClose >= s.postmarket_delay_minutes && afterClose < 6 * 60 && canRun("postmarket")) {
    return { phase: "postmarket", reason: "Postmarket review." }
  }
  return { phase: null, reason: afterClose < s.postmarket_delay_minutes ? "Waiting to run the postmarket review." : "Trading day complete." }
}
