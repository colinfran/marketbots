import { Badge } from "./components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/card"
import { titleCase } from "./lib/format"

/** What the card needs from a bot's engine summary (both bots' `engine_status` have these fields). */
export type EngineCardEngine = {
  online: boolean
  heartbeatAgeS: number | null
  status: { status: string; kill_switch: boolean; ai: { calls_today: number } } | null
}

/**
 * The engine at a glance: run state, AI calls today, the bot's own health rows (venue or broker,
 * market) and an optional note.
 */
export function EngineCard({ engine, rows, note }: { engine: EngineCardEngine; rows: [string, React.ReactNode][]; note?: React.ReactNode }) {
  const s = engine.status
  const all: [string, React.ReactNode][] = s
    ? [
        [
          "AI calls today",
          <span key="calls" className="font-mono tabular-nums">
            {s.ai.calls_today}
          </span>,
        ],
        ...rows,
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
        {all.length > 0 && (
          <dl className="text-muted-foreground grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {all.map(([label, value]) => (
              <div key={label} className="contents">
                <dt>{label}</dt>
                <dd className="text-foreground text-right">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {note}
      </CardContent>
    </Card>
  )
}
