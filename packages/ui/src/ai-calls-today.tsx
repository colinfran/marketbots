"use client"

import { useSyncExternalStore } from "react"
import { countLocalDay } from "./lib/local-day"

/** Recount once a minute, so the number turns over at the viewer's midnight with the page open. */
const subscribe = (onTick: () => void) => {
  const timer = setInterval(onTick, 60_000)
  return () => clearInterval(timer)
}

/**
 * AI calls since midnight in the viewer's time zone, counted in the browser from the call times the
 * page read (each bot's engine counts its own day: crypto UTC, stock New York's). The server render
 * shows a dash until the page hydrates; the page's refreshes bring new calls.
 */
export function AiCallsToday({ times }: { times: number[] }) {
  const count = useSyncExternalStore(
    subscribe,
    () => countLocalDay(times, Date.now()),
    () => null,
  )
  return <span title="Since midnight in your time zone">{count ?? "—"}</span>
}
