import { cn } from "cn"
import { ArrowDownRightIcon, ArrowUpRightIcon, MinusIcon } from "lucide-react"
import Link from "next/link"
import { Badge } from "./components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/card"
import { pct, titleCase, tone, usd } from "./lib/format"

/** Small presentational pieces both dashboards use across pages. */

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

/** A ticker or pair that links to its page; each app passes its own URL for a symbol. */
export function SymbolLink({ symbol, href, className }: { symbol: string; href: string; className?: string }) {
  return (
    <Link href={href} className={cn("font-mono font-semibold hover:underline", className)}>
      {symbol}
    </Link>
  )
}

/** Says where the paper orders go (`title`). */
export function PaperBadge({ title, className }: { title: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("border-amber-500/40 bg-amber-500/10 font-semibold tracking-wide text-amber-800 dark:text-amber-300", className)} title={title}>
      PAPER
    </Badge>
  )
}

/** Buys in the up color, sells and exits in the down color. Each bot's actions, merged. */
const ACTION_STYLE: Record<string, string> = {
  buy: "bg-up/10 text-up border-transparent",
  buy_option: "bg-up/10 text-up border-transparent",
  sell: "bg-down/10 text-down border-transparent",
  close: "bg-down/10 text-down border-transparent",
  reduce: "bg-down/10 text-down border-transparent",
  close_option: "bg-down/10 text-down border-transparent",
  no_trade: "text-muted-foreground",
}

const ACTION_LABEL: Record<string, string> = { no_trade: "no trade", adjust_exits: "adjust", buy_option: "buy option", close_option: "close option", hold_option: "hold option" }

export function ActionBadge({ action }: { action: string }) {
  return (
    <Badge variant="outline" className={cn("font-mono uppercase", ACTION_STYLE[action])}>
      {ACTION_LABEL[action] ?? action}
    </Badge>
  )
}

/** Status badge colors. */
export const TONE = {
  good: "border-transparent bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  busy: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-300",
  warn: "border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300",
  bad: "border-transparent bg-red-500/15 text-red-700 dark:text-red-300",
} as const

/** Both bots' statuses, merged (neither bot uses the other's names). "skipped" differs, so each bot sets it. */
export const STATUS_STYLE: Record<string, string> = {
  filled: TONE.good,
  completed: TONE.good,
  done: TONE.good,
  approved: TONE.good,
  executed: TONE.good,
  succeeded: TONE.good,
  open: TONE.good,
  partial: TONE.busy,
  running: TONE.busy,
  scheduled: TONE.busy,
  pending: TONE.busy,
  processing: TONE.busy,
  opening: TONE.busy,
  closing: TONE.busy,
  rejected: TONE.warn,
  failed: TONE.bad,
  unknown: TONE.bad,
  timed_out: TONE.bad,
  not_applicable: "",
  noop: "",
  closed: "",
  canceled: "",
}

const STATUS_LABEL: Record<string, string> = { not_applicable: "—", noop: "No-op" }

/** `styles` overrides the shared colors (a bot's own "skipped"). */
export function StatusBadge({ status, label, styles }: { status: string; label?: string; styles?: Record<string, string> }) {
  return (
    <Badge variant="outline" className={styles?.[status] ?? STATUS_STYLE[status] ?? ""}>
      {label ?? STATUS_LABEL[status] ?? titleCase(status)}
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

/** A labelled value row for detail panels. */
export function KV({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5 text-sm last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-mono tabular-nums">{children}</span>
    </div>
  )
}

/** A 0–100% bar. */
export function Meter({ value, className }: { value: number | null; className?: string }) {
  return (
    <div className={cn("bg-muted h-1.5 overflow-hidden rounded-full", className)} role="presentation">
      <div className="bg-primary h-full rounded-full transition-[width]" style={{ width: `${Math.max(0, Math.min(100, value ?? 0))}%` }} />
    </div>
  )
}
