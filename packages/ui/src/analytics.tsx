import { Card, CardContent, CardHeader, CardTitle } from "./components/card"

/** The part of the Analytics page both bots show the same way: the news engine's funnel. Each app keeps its own scoring tables. */

export type WireFunnel = { items: number; triggers: number; decisions: number; approved: number; filled: number }

/** Last 7 days: how many stored news items led to triggers, the agent's decisions on them, and fills. */
export function NewsFunnelCard({ funnel, medianLatencyS, latencySamples }: { funnel: WireFunnel; medianLatencyS: number | null; latencySamples: number }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Last 7 days: from news to fills</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {(
          [
            ["Items stored", funnel.items],
            ["Triggers acted on", funnel.triggers],
            ["The agent's decisions on news", funnel.decisions],
            ["Approved by risk", funnel.approved],
            ["Filled", funnel.filled],
          ] as const
        ).map(([label, n]) => (
          <p key={label} className="flex justify-between">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono tabular-nums">{n}</span>
          </p>
        ))}
        <p className="text-muted-foreground pt-2 text-xs">
          Median time from first seeing an item to the decision: {medianLatencyS === null ? "no news decisions yet" : `${Math.round(medianLatencyS)} s (${latencySamples} decisions, last 30 days)`}
        </p>
      </CardContent>
    </Card>
  )
}
