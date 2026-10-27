"use client"

import type { EngineEvent } from "@mb/stock-core/events"
import { Providers as SharedProviders } from "@mb/ui/providers"
import { kit } from "./kit"

/** The shared providers (@mb/ui/providers), with this bot's kit. */
export function Providers({ children, initialEvents }: { children: React.ReactNode; initialEvents: EngineEvent[] }) {
  return (
    <SharedProviders kit={kit} initialEvents={initialEvents}>
      {children}
    </SharedProviders>
  )
}
