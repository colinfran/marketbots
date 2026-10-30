import { PaperBadge as SharedPaperBadge, StatusBadge as SharedStatusBadge, SymbolLink as SharedSymbolLink, TONE } from "@mb/ui/bits"

/** Small presentational pieces: the shared ones (@mb/ui/bits) and stock's own. */

export { ActionBadge, Delta, Empty, KV, PageHeader, SectionTitle, Stat } from "@mb/ui/bits"

/** Stock's colors where they differ from the shared map: a skipped decision is a warning; a planned trade is pending. */
export const STATUS_STYLES: Record<string, string> = { skipped: TONE.warn, planned: TONE.busy }

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
