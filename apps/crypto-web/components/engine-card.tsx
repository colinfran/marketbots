import { EngineCard as EngineCardShell } from "@mb/ui/engine-card"
import type { EngineSummary } from "@/lib/data"
import { until } from "@/lib/format"

/** The engine at a glance (@mb/ui/engine-card) with crypto's rows: data and wallet health and the next scan. The latest cycle is beside it on the Live page. */
export function EngineCard({ engine }: { engine: EngineSummary }) {
  const s = engine.status
  const rows: [string, React.ReactNode][] = s
    ? [
        ["Kraken data", s.kraken.ws === "connected" ? "live" : s.kraken.ws],
        ["Paper wallet", s.paper_wallet.ok ? "ok" : "unavailable"],
        ["Books reconciled", s.reconciliation ? (s.reconciliation.ok ? "yes" : "mismatch") : "—"],
        ["Next scan", until(s.next_cycle_at)],
      ]
    : []
  return <EngineCardShell engine={engine} rows={rows} />
}
