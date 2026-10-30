import { cn } from "cn"
import { CheckIcon, CircleDashedIcon, LoaderIcon, XIcon } from "lucide-react"

/** The numbered steps of an agent episode: why it woke, each lookup, the answer. */

export type StepStatus = "pending" | "active" | "done" | "failed" | "skipped"


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
