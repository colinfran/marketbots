"use client"

import type { LucideIcon } from "lucide-react"
import { createContext, useContext, type ComponentType, type ReactNode } from "react"
import type { AnyEvent, StreamConfig } from "./stream"

/**
 * What a dashboard tells the shared client components about its bot: brand, formatting, links,
 * and the event catalog that drives the live UI. Each app builds one in components/kit.tsx and
 * hands it to <Providers>. The kit holds only per-bot data and renderers for per-bot payloads
 * (the same event name can carry a different payload in each bot); the components themselves
 * have no bot switches.
 */

export type FeedFilter = "ai" | "news" | "trades" | "system"

export type EventCatalog<E extends AnyEvent = AnyEvent> = {
  /** Cycle states as words (status pill, current work, live trail). */
  stateLabels: Record<string, string>
  /** Activity-feed icons by event type (default: a dot). */
  icons: Partial<Record<string, LucideIcon>>
  /** The activity feed's filter tabs, after "All". */
  filters: Record<FeedFilter, (e: E) => boolean>
  /** Events after which server-rendered data is refreshed. */
  refreshOn: ReadonlySet<string>
  /** Debug-level events the feed still lists (the thinking trail). */
  feedDebug: ReadonlySet<string>
  /** Events the feed never lists. */
  feedHidden: ReadonlySet<string>
  /** The feed line for an event. */
  summary(e: E): ReactNode
  /** The extra line under an event (thesis, risk reasons, a source link…). */
  detail(e: E): ReactNode
  /** Links under an event (its symbol, its cycle or report). */
  links(e: E): ReactNode
  /** Current work: the running cycle's events worth a line, and how each reads. */
  work: { events: ReadonlySet<string>; text(e: E): string }
}

export type BotKit<E extends AnyEvent = AnyEvent> = {
  /** "CryptoMarketBot", "StockMarketBot". */
  name: string
  /** The bot's mark (header, status pill), sized by className. */
  Mark: ComponentType<{ className?: string }>
  stream: StreamConfig
  format: {
    price(value: number | null | undefined): string
    /** Clock time for live feeds. */
    time(value: Date | string | number | null | undefined): string
    /** Date and time for tooltips and dossier rows. */
    dateTime(value: Date | string): string
  }
  /** The page for a symbol. */
  symbolHref(symbol: string): string
  /** Who published a news item (a domain, a feed name). */
  sourceLabel(source: string, domain?: string | null): string
  /** Status badge colors where the bot differs from the shared map. */
  statusStyles: Record<string, string>
  /** What a trigger's link is called ("cycle", "report"). */
  triggerLink: string
  /** Extra classes on the status pill's cycle-state label. */
  pillStateClassName?: string
  events: EventCatalog<E>
}

const KitContext = createContext<BotKit | null>(null)

export function KitProvider<E extends AnyEvent>({ kit, children }: { kit: BotKit<E>; children: ReactNode }) {
  return <KitContext.Provider value={kit as unknown as BotKit}>{children}</KitContext.Provider>
}

export const useKit = (): BotKit => {
  const kit = useContext(KitContext)
  if (!kit) throw new Error("useKit must be used inside <Providers>")
  return kit
}
