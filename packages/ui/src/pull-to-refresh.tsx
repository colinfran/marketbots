"use client"

import { cn } from "cn"
import { RefreshCwIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { useInstalledApp } from "./lib/installed-app"

/** How far the indicator travels (px; it moves half as far as the finger) before a release reloads. */
const THRESHOLD = 72
/** It stops here, however far the finger goes. */
const MAX = 112
/** Movement before a touch counts as a pull or as something else. */
const SLOP = 8

/** A touch that starts in a dialog, or in a box scrolled down (pulling scrolls it back up), isn't a pull. */
const claimed = (target: EventTarget | null) => {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollTop > 0 || el.getAttribute("role") === "dialog") return true
  }
  return false
}

type Pull = { distance: number; state: "idle" | "pulling" | "reloading" }

/**
 * Pull down from the top of the page to reload it, in the Home Screen app only: the app has no
 * reload button, and neither iOS nor Android gives an installed app the browser's pull-to-refresh.
 * In a browser tab it renders nothing and leaves the browser's own gesture alone.
 */
export function PullToRefresh() {
  const app = useInstalledApp()
  const [pull, setPull] = useState<Pull>({ distance: 0, state: "idle" })
  useEffect(() => {
    if (!app) return
    const root = document.documentElement
    // No rubber band at the top: the pull moves the indicator, not the page.
    const overscroll = root.style.overscrollBehaviorY
    root.style.overscrollBehaviorY = "none"
    let start: { x: number; y: number } | null = null
    let pulling = false
    let distance = 0
    let reloading = false
    const reset = () => {
      if (pulling) setPull({ distance: 0, state: "idle" })
      start = null
      pulling = false
      distance = 0
    }
    const onStart = (e: TouchEvent) => {
      reset()
      const t = e.touches[0]
      if (!reloading && e.touches.length === 1 && window.scrollY <= 0 && !claimed(e.target)) start = { x: t.clientX, y: t.clientY }
    }
    const onMove = (e: TouchEvent) => {
      if (!start) return
      if (e.touches.length !== 1) return reset()
      const dx = e.touches[0].clientX - start.x
      const dy = e.touches[0].clientY - start.y
      if (!pulling) {
        if (Math.hypot(dx, dy) < SLOP) return
        // Up, sideways, or already taken by something else (a chart's drag): not a pull.
        if (dy <= Math.abs(dx) || e.defaultPrevented || window.scrollY > 0) {
          start = null
          return
        }
        pulling = true
      }
      if (e.cancelable) e.preventDefault()
      distance = Math.min(MAX, Math.max(0, dy) / 2)
      setPull({ distance, state: "pulling" })
    }
    const onEnd = () => {
      if (!pulling || distance < THRESHOLD) return reset()
      reloading = true
      setPull({ distance: THRESHOLD, state: "reloading" })
      window.location.reload()
    }
    window.addEventListener("touchstart", onStart, { passive: true })
    window.addEventListener("touchmove", onMove, { passive: false })
    window.addEventListener("touchend", onEnd)
    window.addEventListener("touchcancel", reset)
    return () => {
      root.style.overscrollBehaviorY = overscroll
      window.removeEventListener("touchstart", onStart)
      window.removeEventListener("touchmove", onMove)
      window.removeEventListener("touchend", onEnd)
      window.removeEventListener("touchcancel", reset)
    }
  }, [app])
  if (!app) return null
  const progress = Math.min(1, pull.distance / THRESHOLD)
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center">
      <div
        className={cn("bg-background flex size-9 items-center justify-center rounded-full border shadow-md", pull.state !== "pulling" && "transition-transform duration-200 ease-out")}
        style={{ transform: `translateY(${pull.distance - 48}px)` }}
      >
        <RefreshCwIcon
          className={cn("size-4", progress < 1 ? "text-muted-foreground" : "text-foreground", pull.state === "reloading" && "motion-safe:animate-spin")}
          style={pull.state === "reloading" ? undefined : { transform: `rotate(${progress * 270}deg)`, opacity: 0.4 + 0.6 * progress }}
        />
      </div>
    </div>
  )
}
