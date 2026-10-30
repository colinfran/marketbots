import { EngineCard as EngineCardShell } from "@mb/ui/engine-card"
import type { EngineSummary } from "@/lib/data"

/** The engine at a glance (@mb/ui/engine-card) with crypto's rows: data and wallet health. */
export function EngineCard({ engine }: { engine: EngineSummary }) {
  const s = engine.status
  const rows: [string, React.ReactNode][] = s
    ? [
        ["Kraken data", s.kraken.ws === "connected" ? "live" : s.kraken.ws],
        ["Paper wallet", s.paper_wallet.ok ? "ok" : "unavailable"],
        ["Books reconciled", s.reconciliation ? (s.reconciliation.ok ? "yes" : "mismatch") : "—"],
      ]
    : []
  return <EngineCardShell engine={engine} rows={rows} />
}
