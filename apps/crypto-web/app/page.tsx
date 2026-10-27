import { ArrowRightIcon, CircleIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { ActivityFeed, CurrentWork } from "@mb/ui/live"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { ActionBadge, Delta, Empty, SectionTitle, Stat, StatusBadge } from "@/components/bits"
import { DailyPnlChart, EquityChart } from "@/components/charts"
import { EngineCard } from "@/components/engine-card"
import { DecisionsTable, FillsTable, PositionsTable } from "@/components/tables"
import { getViewer } from "@/lib/auth"
import { getAccount, getCycles, getDailyStats, getDecisions, getEngine, getEquitySeries, getFills, getLatestAiCycle } from "@/lib/data"
import { ago, dateTime, pct, time, titleCase, until, usd } from "@/lib/format"
import { pageMetadata, site } from "@/lib/site"

export const metadata: Metadata = {
  ...pageMetadata({ title: site.title, description: site.description, path: "/" }),
  title: { absolute: site.title },
}

export default async function DashboardPage() {
  const [viewer, data, engine, curve, cycles, stats, latestAi, decisions, fills] = await Promise.all([
    getViewer(),
    getAccount(),
    getEngine(),
    getEquitySeries(30),
    getCycles(1),
    getDailyStats(90),
    getLatestAiCycle(),
    getDecisions({ limit: 10 }),
    getFills(10),
  ])
  const s = engine.status
  const last = cycles[0] ?? null
  // Today (UTC) is still running, so only finished days count toward green days.
  const today = new Date().toISOString().slice(0, 10)
  const finished = stats.filter((d) => d.day < today)
  const green = finished.filter((d) => d.pnl_usd > 0).length
  const days = [...stats].reverse().map((d) => ({ day: d.day, pnl: d.pnl_usd, pnl_pct: d.pnl_pct }))
  const read = latestAi?.cycle.summary?.split(" — ")[0] ?? null

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Live AI trading desk</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          Grok researches the crypto market with live web and X search, decides what to buy, hold or avoid, and a deterministic risk engine sizes and checks every
          order before it executes in a Kraken paper wallet. Running 24/7.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CircleIcon className="fill-gain text-gain size-2.5" aria-hidden />
            Market open 24/7
          </span>
          {data && <span className="text-muted-foreground">Account as of {time(data.account.updated_at)}</span>}
          {s && engine.online && <span className="text-muted-foreground">Bot: next scan {until(s.next_cycle_at)}</span>}
          {last && (
            <span className="text-muted-foreground inline-flex items-center gap-1.5">
              Last cycle <StatusBadge status={last.status} /> {dateTime(last.started_at)}
            </span>
          )}
          {!engine.online && <span className="text-loss">The engine is offline.</span>}
        </div>
        {!data ? (
          <Empty>No paper account yet. Start the engine: it creates the wallet on first boot.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Equity" value={usd(data.account.equity_usd)} sub={<Delta value={data.totalPnl} percent={data.totalReturnPct} />} />
            <Stat label="Today (UTC)" value={<Delta value={data.dayPnl} className="text-2xl" />} sub={<Delta percent={data.dayPnlPct} />} />
            <Stat
              label="Cash"
              value={usd(data.account.cash_usd)}
              sub={
                <span className="text-muted-foreground">
                  {data.positions.length} position{data.positions.length === 1 ? "" : "s"}
                  {data.positions.length > 0 && ` (${usd(data.marketValue, { whole: true })})`} · fees {usd(data.account.fees_usd)}
                </span>
              }
            />
            <Stat
              label="Green days"
              value={finished.length ? `${green}/${finished.length}` : "—"}
              sub={<span className="text-muted-foreground">{finished.length ? `${Math.round((green / finished.length) * 100)}% of days profitable` : "No completed days yet"}</span>}
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 lg:row-span-2">
          <CardHeader>
            <CardTitle className="text-base">What the AI is doing</CardTitle>
            <CardDescription>Live from the engine: market scans, research, decisions, risk checks and orders as they happen.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CurrentWork />
            <div className="border-t pt-3">
              <ActivityFeed limit={12} className="max-h-[28rem]" compact />
            </div>
          </CardContent>
        </Card>
        <EngineCard engine={engine} last={last} />
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">Latest AI research {latestAi && <span>· {ago(latestAi.cycle.started_at)}</span>}</CardDescription>
            <CardTitle className="text-base leading-snug">{latestAi ? (latestAi.research?.subjects.join(", ") ?? latestAi.decisions.map((d) => d.symbol).join(", ")) : "No AI research yet"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {!latestAi ? (
              <p className="text-muted-foreground leading-relaxed">The AI researches when the market scan finds a setup or an open position needs review.</p>
            ) : (
              <>
                {read && <p className="text-muted-foreground line-clamp-4 leading-relaxed">{read}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {latestAi.cycle.regime && <Badge variant="secondary">{titleCase(latestAi.cycle.regime.label)}</Badge>}
                  {latestAi.research && <Badge variant="secondary">{latestAi.research.sources.length} sources</Badge>}
                </div>
                <ul className="space-y-1">
                  {latestAi.decisions.map((d) => (
                    <li key={d._id} className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-semibold">{d.symbol}</span>
                      <ActionBadge action={d.action} />
                      <span className="text-muted-foreground">conviction {d.ai.conviction}</span>
                      {d.execution.status !== "not_applicable" && <StatusBadge status={d.execution.status} />}
                    </li>
                  ))}
                </ul>
                <Link href={`/research/${latestAi.cycle._id}`} className="inline-flex items-center gap-1 font-medium hover:underline">
                  Research & decisions <ArrowRightIcon className="size-3.5" aria-hidden />
                </Link>
              </>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Account equity, last 30 days</CardTitle>
            <CardDescription>
              Dashed line is the {usd(data?.account.starting_usd ?? 10_000, { whole: true })} starting balance.
              {data?.drawdownPct !== null && data?.drawdownPct !== undefined && data.drawdownPct < 0 && ` Currently ${pct(data.drawdownPct)} below the peak.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <EquityChart points={curve} baseline={data?.account.starting_usd ?? 10_000} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily P&L</CardTitle>
            <CardDescription>Each bar is one UTC day. Bars above zero are green days.</CardDescription>
          </CardHeader>
          <CardContent>{days.length ? <DailyPnlChart days={days} /> : <Empty>No days recorded yet.</Empty>}</CardContent>
        </Card>
      </div>

      <section>
        <SectionTitle
          action={
            <Link href="/holdings" className="text-muted-foreground text-sm hover:underline">
              All holdings
            </Link>
          }
        >
          Open positions
        </SectionTitle>
        <PositionsTable positions={data?.positions ?? []} owner={viewer.owner} />
      </section>
      <section>
        <SectionTitle
          action={
            <Link href="/research" className="text-muted-foreground text-sm hover:underline">
              All AI research
            </Link>
          }
        >
          Recent decisions
        </SectionTitle>
        <DecisionsTable decisions={decisions} />
      </section>
      <section>
        <SectionTitle
          action={
            <Link href="/trades" className="text-muted-foreground text-sm hover:underline">
              All trades
            </Link>
          }
        >
          Recent trades
        </SectionTitle>
        <FillsTable fills={fills} />
      </section>
    </div>
  )
}
