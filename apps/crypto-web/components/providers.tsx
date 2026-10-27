"use client"

import type { EngineEvent } from "@mb/crypto-core/events"
import { ThemeProvider } from "next-themes"
import { LiveRefresh } from "@/components/live/live-ui"
import { StreamProvider } from "@/components/live/stream"
import { TooltipProvider } from "@/components/ui/tooltip"

export function Providers({ children, initialEvents }: { children: React.ReactNode; initialEvents: EngineEvent[] }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <StreamProvider initialEvents={initialEvents}>
          <LiveRefresh />
          {children}
        </StreamProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
