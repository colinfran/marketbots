import type { CycleDoc } from "@mb/stock-core/db"
import { EngineCard as EngineCardShell } from "@mb/ui/engine-card"
import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { PhaseBadge, StatusBadge } from "@/components/bits"
import { ago, titleCase } from "@/lib/format"
import type { EngineSummary } from "@/lib/queries"

const stream = (state: string) => (state === "connected" ? "live" : state)

/**
 * The engine at a glance (@mb/ui/engine-card) with stock's rows: broker and data health, what's
 * scheduled next and the latest cycle.
 */
export function EngineCard({ engine, last }: { engine: EngineSummary; last: Pick<CycleDoc, "_id" | "phase" | "status" | "started_at" | "report_id" | "error"> | null }) {
  const s = engine.status
  const rows: [string, React.ReactNode][] = s
    ? [
        ["Alpaca API", s.broker.rest],
        ["Trade updates", stream(s.broker.trade_stream.state)],
        ["Market data", stream(s.broker.data_stream.state)],
        ["Market", s.market?.is_open ? "open" : "closed"],
      ]
    : []
  const headline = last && s?.last_cycle?.id === last._id ? s.last_cycle.headline : null
  return (
    <EngineCardShell
      engine={engine}
      rows={rows}
      note={s && engine.online && <p className="text-muted-foreground text-xs">{s.schedule.phase ? `${titleCase(s.schedule.phase)} cycle due now.` : s.schedule.reason}</p>}
      latest={
        last && (
          <>
            <p className="text-muted-foreground mb-1 flex flex-wrap items-center gap-2 text-xs">
              Latest cycle <PhaseBadge phase={last.phase} /> <StatusBadge status={last.status} /> {ago(last.started_at)}
            </p>
            {(headline ?? last.error) && <p className="line-clamp-3 text-sm">{headline ?? last.error}</p>}
            <Link prefetch href={last.report_id ? `/research/${last.report_id}` : "/live"} className="mt-1 inline-flex items-center gap-1 text-sm font-medium hover:underline">
              {last.report_id ? "Full report" : "Watch it live"} <ArrowRightIcon className="size-3.5" aria-hidden />
            </Link>
          </>
        )
      }
    />
  )
}
