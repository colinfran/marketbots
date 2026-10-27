import type { Phase } from "@mb/stock-core/settings"
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { pct, titleCase, tone, usd } from "@/lib/format"
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

/** A ticker that links to its symbol page (price chart with the bot's trades). */
export function SymbolLink({ symbol, className }: { symbol: string; className?: string }) {
  return (
    <Link prefetch href={`/markets/${encodeURIComponent(symbol)}`} className={cn("font-mono font-semibold hover:underline", className)}>
      {symbol}
    </Link>
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

const GOOD = "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
const BUSY = "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300"
const WARN = "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300"
const BAD = "border-transparent bg-red-500/15 text-red-700 dark:text-red-300"

const STATUS_STYLE: Record<string, string> = {
  executed: GOOD,
  succeeded: GOOD,
  filled: GOOD,
  done: GOOD,
  open: GOOD,
  running: BUSY,
  scheduled: BUSY,
  pending: BUSY,
  processing: BUSY,
  opening: BUSY,
  closing: BUSY,
  rejected: WARN,
  skipped: WARN,
  failed: BAD,
  timed_out: BAD,
  noop: "",
  closed: "",
  canceled: "",
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge variant="outline" className={STATUS_STYLE[status] ?? ""}>
      {label ?? (status === "noop" ? "No-op" : titleCase(status))}
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

const ACTION_LABEL: Record<string, string> = { adjust_exits: "adjust", buy_option: "buy option", close_option: "close option", hold_option: "hold option" }

export function ActionBadge({ action }: { action: string }) {
  const style = action === "buy" || action === "buy_option" ? "bg-gain/10 text-gain border-transparent" : action === "sell" || action === "close_option" ? "bg-loss/10 text-loss border-transparent" : ""
  return (
    <Badge variant="outline" className={cn("font-mono uppercase", style)}>
      {ACTION_LABEL[action] ?? action}
    </Badge>
  )
}

export function PaperBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-amber-500/40 bg-amber-500/10 font-semibold tracking-wide text-amber-800 dark:text-amber-300", className)} title="Every order goes to an Alpaca paper account. No real money.">
      PAPER
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

export function BlockSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-40 w-full rounded-xl", className)} />
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

/** A labelled value row for detail panels. */
export function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono tabular-nums">{children}</span>
    </div>
  )
}
