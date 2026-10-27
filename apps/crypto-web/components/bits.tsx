import type { EvidenceItem } from "@mb/crypto-core/db"
import { PaperBadge as SharedPaperBadge, SymbolLink as SharedSymbolLink } from "@mb/ui/bits"
import { Badge } from "@mb/ui/components/badge"
import { ExternalLinkIcon } from "lucide-react"
import { symbolSlug } from "@/lib/format"

/** Small presentational pieces: the shared ones (@mb/ui/bits) and crypto's own. */

export { ActionBadge, Delta, Empty, KV, PageHeader, SectionTitle, Stat, StatusBadge } from "@mb/ui/bits"

export function SymbolLink({ symbol, className }: { symbol: string; className?: string }) {
  return <SharedSymbolLink symbol={symbol} href={`/markets/${symbolSlug(symbol)}`} className={className} />
}

export function PaperBadge({ className }: { className?: string }) {
  return <SharedPaperBadge title="Every order executes in a Kraken CLI paper wallet. No real money." className={className} />
}

const KIND_LABEL: Record<EvidenceItem["kind"], string> = { fact: "Fact", sourced_claim: "Sourced", estimate: "Estimate", speculation: "Speculation" }

/** AI evidence with its type and (only verified) source link. */
export function EvidenceList({ items, empty = "None given." }: { items: EvidenceItem[]; empty?: string }) {
  if (!items.length) return <p className="text-muted-foreground text-sm">{empty}</p>
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((e, i) => (
        <li key={i} className="flex gap-2">
          <Badge variant="outline" className="mt-0.5 shrink-0 text-[10px] font-normal" title={e.verified_source ? "Backed by a source research retrieved" : undefined}>
            {KIND_LABEL[e.kind]}
          </Badge>
          <span className="leading-snug">
            {e.claim}
            {e.as_of && <span className="text-muted-foreground"> · {e.as_of}</span>}
            {e.source_url && (
              <a href={e.source_url} target="_blank" rel="noopener noreferrer nofollow" className="text-muted-foreground hover:text-foreground ml-1 inline-flex items-center gap-0.5 underline underline-offset-2">
                source <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
