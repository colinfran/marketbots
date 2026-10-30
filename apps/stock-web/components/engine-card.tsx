import { EngineCard as EngineCardShell } from "@mb/ui/engine-card"
import type { EngineSummary } from "@/lib/queries"

const stream = (state: string) => (state === "connected" ? "live" : state)

/** The engine at a glance (@mb/ui/engine-card) with stock's rows: broker and data health and the market. */
export function EngineCard({ engine }: { engine: EngineSummary }) {
  const s = engine.status
  const rows: [string, React.ReactNode][] = s
    ? [
        ["Alpaca API", s.broker.rest],
        ["Trade updates", stream(s.broker.trade_stream.state)],
        ["Market data", stream(s.broker.data_stream.state)],
        ["Market", s.market?.is_open ? "open" : "closed"],
      ]
    : []
  return <EngineCardShell engine={engine} rows={rows} />
}
