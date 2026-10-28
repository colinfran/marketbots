import { Empty } from "./bits"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/table"

/**
 * The parts of the Analytics page both bots show the same way: the news engine's funnel and its
 * research spend, and the rows of the daily AI-cost table. Each app keeps its own scoring tables
 * and lays out the AI-cost table in its own page.
 */

export type WireFunnel = { items: number; triggers: number; eventCycles: number; decisions: number; approved: number; filled: number }

/** Last 7 days: how many stored news items led to triggers, event cycles, decisions and fills. */
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
            ["Event cycles", funnel.eventCycles],
            ["Event decisions", funnel.decisions],
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
          Median time from first seeing an item to the decision: {medianLatencyS === null ? "no event decisions yet" : `${Math.round(medianLatencyS)} s (${latencySamples} decisions, last 30 days)`}
        </p>
      </CardContent>
    </Card>
  )
}

export type SpendDay = { day: string; research: number; gap: number; decision: number }

/** Research, gap-fill and decision spend per day (the bot's day), newest first. With `empty`, no days shows that text instead of an empty table. */
export function SpendByTaskCard({ title, description, dayLabel, days, empty }: { title: string; description?: string; dayLabel: string; days: SpendDay[]; empty?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        {empty && days.length === 0 ? (
          <Empty>{empty}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">{dayLabel}</TableHead>
                <TableHead className="text-right text-xs">Research</TableHead>
                <TableHead className="text-right text-xs">Gap-fill</TableHead>
                <TableHead className="text-right text-xs">Decisions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...days].reverse().map((d) => (
                <TableRow key={d.day}>
                  <TableCell className="font-mono text-xs">{d.day}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">${d.research.toFixed(2)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">${d.gap.toFixed(2)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">${d.decision.toFixed(2)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

export type AiCostDay = { _id: string; cost: number; calls: number; failures: number }

/** The AI-cost table's rows: the last 14 days, newest first. */
export function AiCostRows({ costs }: { costs: AiCostDay[] }) {
  return (
    <TableBody>
      {[...costs]
        .reverse()
        .slice(0, 14)
        .map((c) => (
          <TableRow key={c._id}>
            <TableCell className="font-mono text-xs">{c._id}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">{c.calls}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">{c.failures}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">${c.cost.toFixed(2)}</TableCell>
          </TableRow>
        ))}
    </TableBody>
  )
}
