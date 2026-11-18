"use client"

import { useSyncExternalStore } from "react"
import { countLocalDay } from "./lib/local-day"

/** Recount once a minute, so the number turns over at the viewer's midnight with the page open. */
const subscribe = (onTick: () => void) => {
  const timer = setInterval(onTick, 60_000)
  return () => clearInterval(timer)
}

/**
 * A "today" count in the viewer's own day (AI calls, agent episodes, news triggers): how many of
 * `times` (ms, the last 26 hours the page read) fall after midnight in the browser's time zone. The
 * engines count the bot's day (crypto UTC, stock New York's), which a viewer elsewhere would see turn
 * over at an odd hour. The server render shows a dash until the page hydrates; the page's refreshes
 * bring new times.
 */
export function LocalDayCount({ times }: { times: number[] }) {
  const count = useSyncExternalStore(
    subscribe,
    () => countLocalDay(times, Date.now()),
    () => null,
  )
  return <span title="Since midnight in your time zone">{count ?? "—"}</span>
}
