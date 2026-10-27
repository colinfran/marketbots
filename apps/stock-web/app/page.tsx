import { formatDateTime, formatTime, marketDay } from "@mb/stock-core/time"
import { ArrowRightIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { ActivityFeed, CurrentWork } from "@mb/ui/live"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, PhaseBadge, SectionTitle, Stat, StatusBadge } from "@/components/bits"
import { DailyPnlChart, EquityChart } from "@/components/charts"
import { EngineCard } from "@/components/engine-card"
import { MarketStatus } from "@/components/market-status"
import { DecisionsTable, OptionsTable, PositionsTable, TradesTable } from "@/components/tables"
import { titleCase, usd } from "@/lib/format"
import { getCycles, getEngine, getEquitySeries, getLatestReport, getLiveAccount, getSettings, listDailyStats, listDecisions, listTrades } from "@/lib/queries"
import { pageMetadata, site } from "@/lib/site"

export const metadata: Metadata = {
  ...pageMetadata({ title: site.title, description: site.description, path: "/" }),
  title: { absolute: site.title },
}

export default async function DashboardPage() {
  const today = marketDay()
  const [live, engine, stats, series, latest, decisions, trades, settings, cycles] = await Promise.all([
    getLiveAccount(),
    getEngine(),
    listDailyStats(),
    getEquitySeries(),
    getLatestReport(),
    listDecisions(today),
    listTrades(10),
    getSettings(),
    getCycles(1),
  ])
  const green = stats.filter((s) => s.pnl > 0).length
  const benchmarked = stats.filter((s) => s.spy_pct != null)
  const beatSpy = benchmarked.filter((s) => s.pnl_pct > s.spy_pct!).length
  const market = engine.status?.market
  const days = stats
    .slice(0, 60)
    .reverse()
    .map((s) => ({ day: s.trading_day, pnl: s.pnl, pnl_pct: s.pnl_pct }))

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Live AI trading desk</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
          Grok researches the web and X, decides, and trades stocks and defined-risk options with a {usd(settings.account.starting_capital, { whole: true })} paper account every market day.
          Every search, decision and risk check streams live. The goal: finish every day green.
        </p>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {market && live && <MarketStatus open={market.open} close={market.close} nextOpen={market.next_open ?? new Date(live.clock.next_open)} renderedAt={new Date()} />}
          {live && <span className="text-muted-foreground">Account as of {formatTime(live.asOf)}</span>}
          {engine.status && <span className="text-muted-foreground">Bot: {engine.status.schedule.phase ? `${titleCase(engine.status.schedule.phase)} cycle due` : engine.status.schedule.reason}</span>}
          {engine.status?.last_cycle && (
            <span className="text-muted-foreground inline-flex items-center gap-1.5">
              Last cycle <PhaseBadge phase={engine.status.last_cycle.phase} /> <StatusBadge status={engine.status.last_cycle.status} /> {formatDateTime(engine.status.last_cycle.at)}
            </span>
          )}
          {!engine.online && <span className="text-loss">The engine is offline.</span>}
        </div>
        {!live ? (
          <Empty>No account data yet. It appears once the engine has started and synced with Alpaca.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Equity" value={usd(live.equity)} sub={<Delta value={live.totalPnl} percent={live.totalPnlPct} />} />
            <Stat label="Today" value={<Delta value={live.dayPnl} className="text-2xl" />} sub={<Delta percent={live.dayPnlPct} />} />
            <Stat
              label="Cash"
              value={usd(live.cash)}
              sub={
                <span className="text-muted-foreground">
                  {live.positions.length} stock{live.positions.length === 1 ? "" : "s"} · {live.options.length} options position{live.options.length === 1 ? "" : "s"}
                  {live.options.length > 0 && ` (${usd(live.optionsValue, { whole: true })})`}
                </span>
              }
            />
            <Stat
              label="Green days"
              value={stats.length ? `${green}/${stats.length}` : "—"}
              sub={
                <span className="text-muted-foreground">
                  {stats.length ? `${Math.round((green / stats.length) * 100)}% of days profitable` : "No completed days yet"}
                  {benchmarked.length > 0 && ` · beat SPY ${beatSpy}/${benchmarked.length}`}
                </span>
              }
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 lg:row-span-2">
          <CardHeader>
            <CardTitle className="text-base">What the AI is doing</CardTitle>
            <CardDescription>Live from the engine: research, decisions, risk checks and orders as they happen.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CurrentWork />
            <div className="border-t pt-3">
              <ActivityFeed limit={12} className="max-h-[28rem]" compact />
            </div>
          </CardContent>
        </Card>
        <EngineCard engine={engine} last={cycles[0] ?? null} />
        <Card>
          <CardHeader>
            <CardDescription className="flex items-center gap-2">Latest report {latest && <PhaseBadge phase={latest.phase} />}</CardDescription>
            <CardTitle className="text-base leading-snug">{latest ? latest.report.headline : "No reports yet"}</CardTitle>
          </CardHeader>
          {latest && (
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground leading-relaxed">{latest.report.summary}</p>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">{titleCase(latest.report.market.sentiment)}</Badge>
                <Badge variant="secondary">{titleCase(latest.report.market.regime)}</Badge>
                <Badge variant="secondary">Stance: {titleCase(latest.report.market.stance)}</Badge>
              </div>
              <p>
                <span className="font-medium">Next focus:</span> <span className="text-muted-foreground">{latest.report.next_focus}</span>
              </p>
              <Link href={`/research/${latest._id}`} className="inline-flex items-center gap-1 font-medium hover:underline">
                Full report <ArrowRightIcon className="size-3.5" />
              </Link>
            </CardContent>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Account equity</CardTitle>
            <CardDescription>Dashed line is the {usd(settings.account.starting_capital, { whole: true })} starting balance.</CardDescription>
          </CardHeader>
          <CardContent>
            <EquityChart series={series} baseline={settings.account.starting_capital} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Daily P&L</CardTitle>
            <CardDescription>Each bar is one trading day. Bars above zero are green days.</CardDescription>
          </CardHeader>
          <CardContent>
            <DailyPnlChart days={days} />
          </CardContent>
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
          Stock positions
        </SectionTitle>
        <PositionsTable positions={live?.positions ?? []} />
      </section>
      <section>
        <SectionTitle
          action={
            <Link href="/trades?tab=options" className="text-muted-foreground text-sm hover:underline">
              All options
            </Link>
          }
        >
          Options positions
        </SectionTitle>
        <OptionsTable positions={live?.options ?? []} />
      </section>
      <section>
        <SectionTitle
          action={
            <Link href={`/journal/${today}`} className="text-muted-foreground text-sm hover:underline">
              Today&apos;s journal
            </Link>
          }
        >
          Today&apos;s decisions
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
        <TradesTable trades={trades} />
      </section>
    </div>
  )
}
