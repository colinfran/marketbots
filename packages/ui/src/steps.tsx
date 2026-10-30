import { cn } from "cn"
import { CheckIcon, CircleDashedIcon, LoaderIcon, SparklesIcon, XIcon } from "lucide-react"

/**
 * The building blocks of a cycle trail: the numbered steps of one cycle's thinking process.
 * Each app builds its own trail from its events (`buildTrail`) and lays out its own steps.
 */

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped"

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

export function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <CheckIcon className="text-gain size-4" aria-label="done" />
  if (status === "failed") return <XIcon className="text-loss size-4" aria-label="failed" />
  if (status === "active") return <LoaderIcon className="size-4 motion-safe:animate-spin" aria-label="in progress" />
  return <CircleDashedIcon className="text-muted-foreground size-4" aria-label={status} />
}

/** One numbered step. Its title is greyed out while `muted` (by default: until the step starts). */
export function Step({ n, title, status, muted = status === "pending", aside, children }: { n: number; title: string; status: StepStatus; muted?: boolean; aside?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="relative pb-6 pl-8 last:pb-0">
      <span className="bg-border absolute top-6 bottom-0 left-[11px] w-px" aria-hidden />
      <span className={cn("bg-background absolute top-0 left-0 flex size-6 items-center justify-center rounded-full border", status === "active" && "border-foreground")}>
        <StepIcon status={status} />
      </span>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={cn("text-sm font-semibold", muted && "text-muted-foreground")}>
          {n}. {title}
        </h3>
        {aside && <span className="text-muted-foreground text-xs">{aside}</span>}
      </div>
      {children && <div className="mt-2 space-y-3 text-sm">{children}</div>}
    </li>
  )
}

/** The latest stretch of text a model is writing. */
export function Excerpt({ label, text, icon: Icon = SparklesIcon }: { label: string; text: string; icon?: typeof SparklesIcon }) {
  return (
    <div className="bg-muted/40 rounded-md p-3">
      <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3" aria-hidden /> {label}
      </p>
      <p className="text-muted-foreground line-clamp-4 text-xs leading-relaxed whitespace-pre-wrap">…{text}</p>
    </div>
  )
}
