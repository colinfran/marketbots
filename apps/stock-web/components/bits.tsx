import type { Phase } from "@mb/stock-core/settings"
import { PaperBadge as SharedPaperBadge, StatusBadge as SharedStatusBadge, SymbolLink as SharedSymbolLink, TONE } from "@mb/ui/bits"
import { Badge } from "@mb/ui/components/badge"
import { Skeleton } from "@mb/ui/components/skeleton"
import { cn } from "@/lib/utils"
import { titleCase } from "@/lib/format"

/** Small presentational pieces: the shared ones (@mb/ui/bits) and stock's own. */

export { ActionBadge, Delta, Empty, KV, PageHeader, SectionTitle, Stat } from "@mb/ui/bits"

/** Stock's colors where they differ from the shared map: a skipped decision or cycle is a warning. */
export const STATUS_STYLES: Record<string, string> = { skipped: TONE.warn }

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <SharedStatusBadge status={status} label={label} styles={STATUS_STYLES} />
}

/** A ticker that links to its symbol page (price chart with the bot's trades). */
export function SymbolLink({ symbol, className }: { symbol: string; className?: string }) {
  return <SharedSymbolLink symbol={symbol} href={`/markets/${encodeURIComponent(symbol)}`} className={className} />
}

export function PaperBadge({ className }: { className?: string }) {
  return <SharedPaperBadge title="Every order goes to an Alpaca paper account. No real money." className={className} />
}

const PHASE_STYLE: Record<Phase, string> = {
  premarket: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  intraday: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-300",
  close: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
  postmarket: "border-transparent bg-slate-500/15 text-slate-700 dark:text-slate-300",
}

export function PhaseBadge({ phase }: { phase: Phase }) {
  return (
    <Badge variant="outline" className={PHASE_STYLE[phase]}>
      {titleCase(phase)}
    </Badge>
  )
}

/** Marks cycles the news engine or the seed buy started (scheduled and price-move cycles need no badge). */
export function CycleKindBadge({ kind }: { kind?: string | null }) {
  if (kind !== "event" && kind !== "seed") return null
  return <Badge variant="secondary">{kind === "event" ? "News event" : "Seed"}</Badge>
}

const RESEARCH_MODE_LABEL: Record<string, string> = { full: "full research", gap_fill: "gap-fill research", skipped: "research skipped" }

/** How much Grok research a cycle ran: full, gap-fill (only what our feeds lacked) or skipped. */
export function ResearchModeBadge({ mode, className }: { mode?: string | null; className?: string }) {
  if (!mode) return null
  return (
    <Badge variant="outline" className={cn("font-normal", mode === "skipped" && "text-muted-foreground", className)} title="Grok research this cycle">
      {RESEARCH_MODE_LABEL[mode] ?? mode}
    </Badge>
  )
}

export function BlockSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-40 w-full rounded-xl", className)} />
}
