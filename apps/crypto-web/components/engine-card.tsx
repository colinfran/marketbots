import type { CycleDoc } from "@mb/crypto-core/db"
import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { StatusBadge } from "@/components/bits"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { EngineSummary } from "@/lib/data"
import { ago, titleCase, until } from "@/lib/format"

/**
 * The engine at a glance: run state, data and wallet health, AI spend, the next scan and the
 * latest cycle. stockmarketbot's dashboard has the same card with its broker's rows.
 */
export function EngineCard({ engine, last }: { engine: EngineSummary; last: Pick<CycleDoc, "_id" | "status" | "started_at" | "summary" | "error"> | null }) {
  const s = engine.status
  const rows: [string, React.ReactNode][] = s
    ? [
        [
          "AI spend today",
          <span key="spend" className="font-mono tabular-nums">
            ${s.ai.spend_today_usd.toFixed(2)} / ${s.ai.budget_usd}
          </span>,
        ],
        ["Kraken data", s.kraken.ws === "connected" ? "live" : s.kraken.ws],
        ["Paper wallet", s.paper_wallet.ok ? "ok" : "unavailable"],
        ["Books reconciled", s.reconciliation ? (s.reconciliation.ok ? "yes" : "mismatch") : "—"],
        ["Next scan", until(s.next_cycle_at)],
      ]
    : []
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
        {last && (
          <div className="border-t pt-3">
            <p className="text-muted-foreground mb-1 flex items-center gap-2 text-xs">
              Latest cycle <StatusBadge status={last.status} /> {ago(last.started_at)}
            </p>
            <p className="line-clamp-3 text-sm">{last.summary ?? last.error ?? "Running…"}</p>
            <Link href="/live" className="mt-1 inline-flex items-center gap-1 text-sm font-medium hover:underline">
              Watch it live <ArrowRightIcon className="size-3.5" aria-hidden />
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
