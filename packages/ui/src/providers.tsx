"use client"

import { ThemeProvider } from "next-themes"
import { TooltipProvider } from "./components/tooltip"
import { type BotKit, KitProvider } from "./kit"
import { LiveRefresh } from "./live"
import { PullToRefresh } from "./pull-to-refresh"
import { type AnyEvent, StreamProvider } from "./stream"

/** Theme, tooltips, the bot's kit and the live stream, around every page; pull-to-refresh in the Home Screen app. */
export function Providers<E extends AnyEvent>({ kit, children, initialEvents }: { kit: BotKit<E>; children: React.ReactNode; initialEvents: E[] }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <KitProvider kit={kit}>
          <StreamProvider initialEvents={initialEvents} config={kit.stream}>
            <LiveRefresh />
            <PullToRefresh />
            {children}
          </StreamProvider>
        </KitProvider>
      </TooltipProvider>
    </ThemeProvider>
  )
}
