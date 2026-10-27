import type { CycleDoc } from "@mb/crypto-core/db"
import { EngineCard as EngineCardShell } from "@mb/ui/engine-card"
import { ArrowRightIcon } from "lucide-react"
import Link from "next/link"
import { StatusBadge } from "@/components/bits"
import type { EngineSummary } from "@/lib/data"
import { ago, until } from "@/lib/format"

/**
 * The engine at a glance (@mb/ui/engine-card) with crypto's rows: data and wallet health, the
 * next scan and the latest cycle.
 */
export function EngineCard({ engine, last }: { engine: EngineSummary; last: Pick<CycleDoc, "_id" | "status" | "started_at" | "summary" | "error"> | null }) {
  const s = engine.status
  const rows: [string, React.ReactNode][] = s
    ? [
        ["Kraken data", s.kraken.ws === "connected" ? "live" : s.kraken.ws],
        ["Paper wallet", s.paper_wallet.ok ? "ok" : "unavailable"],
        ["Books reconciled", s.reconciliation ? (s.reconciliation.ok ? "yes" : "mismatch") : "—"],
        ["Next scan", until(s.next_cycle_at)],
      ]
    : []
  return (
    <EngineCardShell
      engine={engine}
      rows={rows}
      latest={
        last && (
          <>
            <p className="text-muted-foreground mb-1 flex items-center gap-2 text-xs">
              Latest cycle <StatusBadge status={last.status} /> {ago(last.started_at)}
            </p>
            <p className="line-clamp-3 text-sm">{last.summary ?? last.error ?? "Running…"}</p>
            <Link href="/live" className="mt-1 inline-flex items-center gap-1 text-sm font-medium hover:underline">
              Watch it live <ArrowRightIcon className="size-3.5" aria-hidden />
            </Link>
          </>
        )
      }
    />
  )
}
