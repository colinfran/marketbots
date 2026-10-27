import type { EvidenceItem } from "@mb/crypto-core/db"
import { ArrowDownRightIcon, ArrowUpRightIcon, ExternalLinkIcon, MinusIcon } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { pct, symbolSlug, titleCase, tone, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

/** Small presentational pieces shared across pages. */

export function Delta({ value, percent, className }: { value?: number | null; percent?: number | null; className?: string }) {
  // Round to display precision first so a fraction of a cent doesn't render as a green "+$0.00".
  const basis = Math.round((value ?? percent ?? 0) * 100) / 100
  const Icon = !basis ? MinusIcon : basis > 0 ? ArrowUpRightIcon : ArrowDownRightIcon
  const hasValue = value !== undefined && value !== null
  const hasPct = percent !== undefined && percent !== null
  return (
    <span className={cn("inline-flex items-center gap-0.5 tabular-nums", tone(basis), className)}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {hasValue && usd(value, { sign: true })}
      {hasValue && hasPct && " "}
      {hasPct && (hasValue ? `(${pct(percent)})` : pct(percent))}
    </span>
  )
}

export function Stat({ label, value, sub, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-1 py-4", className)}>
      <CardHeader className="px-4">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums">{value}</CardTitle>
      </CardHeader>
      {sub && <CardContent className="px-4 text-sm">{sub}</CardContent>}
    </Card>
  )
}

export function SymbolLink({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <Link href={`/markets/${symbolSlug(symbol)}`} className={cn("font-mono font-semibold hover:underline", className)}>
      {symbol}
    </Link>
  )
}

export function PaperBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-amber-500/40 bg-amber-500/10 font-semibold tracking-wide text-amber-800 dark:text-amber-300", className)} title="Every order executes in a Kraken CLI paper wallet. No real money.">
      PAPER
    </Badge>
  )
}

const ACTION_STYLE: Record<string, string> = {
  buy: "bg-up/10 text-up border-transparent",
  close: "bg-down/10 text-down border-transparent",
  reduce: "bg-down/10 text-down border-transparent",
  hold: "",
  no_trade: "text-muted-foreground",
}

export function ActionBadge({ action }: { action: string }) {
  return (
    <Badge variant="outline" className={cn("font-mono uppercase", ACTION_STYLE[action])}>
      {action === "no_trade" ? "no trade" : action}
    </Badge>
  )
}

const STATUS_STYLE: Record<string, string> = {
  filled: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  completed: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  done: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  approved: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  partial: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  running: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  scheduled: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  pending: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  processing: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  skipped: "",
  not_applicable: "",
  canceled: "",
  rejected: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
  failed: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
  unknown: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge variant="outline" className={STATUS_STYLE[status] ?? ""}>
      {label ?? (status === "not_applicable" ? "—" : titleCase(status))}
    </Badge>
  )
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{children}</h2>
      {action}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">{children}</p>
}

export function PageHeader({ title, description, action }: { title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-1 max-w-3xl text-sm">{description}</p>}
      </div>
      {action}
    </div>
  )
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

/** A labelled value row for detail panels. */
export function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono tabular-nums">{children}</span>
    </div>
  )
}
