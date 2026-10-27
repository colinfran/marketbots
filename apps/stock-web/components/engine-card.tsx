import type { CycleDoc } from "@mb/stock-core/db"
import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { PhaseBadge, StatusBadge } from "@/components/bits"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ago, titleCase } from "@/lib/format"
import type { EngineSummary } from "@/lib/queries"

const stream = (state: string) => (state === "connected" ? "live" : state)

/**
 * The engine at a glance: run state, broker and data health, AI spend, what's scheduled next and
 * the latest cycle. cryptomarketbot's dashboard has the same card with its venue's rows.
 */
export function EngineCard({ engine, last }: { engine: EngineSummary; last: Pick<CycleDoc, "_id" | "phase" | "status" | "started_at" | "report_id" | "error"> | null }) {
  const s = engine.status
  const rows: [string, React.ReactNode][] = s
    ? [
        [
          "AI spend today",
          <span key="spend" className="font-mono tabular-nums">
            ${s.ai.spend_today_usd.toFixed(2)} / ${s.ai.budget_usd}
          </span>,
        ],
        ["Alpaca API", s.broker.rest],
        ["Trade updates", stream(s.broker.trade_stream.state)],
        ["Market data", stream(s.broker.data_stream.state)],
        ["Market", s.market?.is_open ? "open" : "closed"],
      ]
    : []
  const headline = last && s?.last_cycle?.id === last._id ? s.last_cycle.headline : null
  return (
    <Card>
      <CardHeader>
        <CardDescription>Engine</CardDescription>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {engine.online ? titleCase(s?.status ?? "unknown") : "Offline"}
          {s?.kill_switch && <Badge variant="destructive">Kill switch</Badge>}
          {!engine.online && <span className="text-muted-foreground text-xs font-normal">last heartbeat {engine.heartbeatAgeS === null ? "never" : `${engine.heartbeatAgeS}s ago`}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {rows.length > 0 && (
          <dl className="text-muted-foreground grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd className="text-foreground text-right">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {s && engine.online && <p className="text-muted-foreground text-xs">{s.schedule.phase ? `${titleCase(s.schedule.phase)} cycle due now.` : s.schedule.reason}</p>}
        {last && (
          <div className="border-t pt-3">
            <p className="text-muted-foreground mb-1 flex flex-wrap items-center gap-2 text-xs">
              Latest cycle <PhaseBadge phase={last.phase} /> <StatusBadge status={last.status} /> {ago(last.started_at)}
            </p>
            {(headline ?? last.error) && <p className="line-clamp-3 text-sm">{headline ?? last.error}</p>}
            <Link prefetch href={last.report_id ? `/research/${last.report_id}` : "/live"} className="mt-1 inline-flex items-center gap-1 text-sm font-medium hover:underline">
              {last.report_id ? "Full report" : "Watch it live"} <ArrowRightIcon className="size-3.5" aria-hidden />
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
