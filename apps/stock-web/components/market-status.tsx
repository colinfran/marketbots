"use client"

import { CircleIcon } from "lucide-react"
import { useSyncExternalStore } from "react"
import { formatDateTime, formatTime } from "@mb/stock-core/time"

const TICK_MS = 15_000

const subscribe = (onTick: () => void) => {
  const timer = setInterval(onTick, TICK_MS)
  return () => clearInterval(timer)
}
const currentTick = () => Math.floor(Date.now() / TICK_MS)

/**
 * Market open/closed from the session times and the viewer's clock, so it flips at the bell even
 * though the rest of the page comes from a cached render. The server render uses `renderedAt`.
 */
export function MarketStatus({ open, close, nextOpen, renderedAt }: { open: Date | null; close: Date | null; nextOpen: Date; renderedAt: Date }) {
  const tick = useSyncExternalStore(subscribe, currentTick, () => Math.floor(renderedAt.getTime() / TICK_MS))
  const now = new Date(tick * TICK_MS)
  const isOpen = !!open && !!close && open <= now && now < close
  const opensAt = open && now < open ? open : nextOpen

  return (
    <>
      <span className="inline-flex items-center gap-1.5 font-medium">
        <CircleIcon className={isOpen ? "fill-gain text-gain size-2.5" : "fill-muted-foreground text-muted-foreground size-2.5"} />
        Market {isOpen ? "open" : "closed"}
      </span>
      <span className="text-muted-foreground">{isOpen ? `Closes ${formatTime(close!)}` : `Opens ${formatDateTime(opensAt)}`}</span>
    </>
  )
}
