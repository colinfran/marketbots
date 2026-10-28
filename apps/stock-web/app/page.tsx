import { formatTime } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { ActivityFeed, StreamBadge } from "@mb/ui/live"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, Stat } from "@/components/bits"
import { EngineCard } from "@/components/engine-card"
import { LiveCycleTrail } from "@/components/live/cycle-trail"
import { MarketStatus } from "@/components/market-status"
import { getViewer } from "@/lib/auth"
import { usd } from "@/lib/format"
import { getCycleEvents, getCycles, getEngine, getLiveAccount, getSettings, getWireForCycle } from "@/lib/queries"
import { pageMetadata, site } from "@/lib/site"

export const metadata: Metadata = {
  ...pageMetadata({ title: site.title, description: site.description, path: "/" }),
  title: { absolute: site.title },
}

/** Live: the account at a glance and the AI at work as it happens. Everything else has one page of its own. */
export default async function LivePage() {
  const [viewer, live, engine, settings, cycles] = await Promise.all([getViewer(), getLiveAccount(), getEngine(), getSettings(), getCycles(1)])
  const latest = cycles[0] ?? null
  const [events, wire] = await Promise.all([latest ? getCycleEvents(latest._id, viewer) : [], getWireForCycle(latest).catch(() => null)])
  const market = engine.status?.market
  const invested = (live?.positions.reduce((sum, p) => sum + p.marketValue, 0) ?? 0) + (live?.optionsValue ?? 0)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Live AI trading desk</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Grok researches the web and X, decides, and trades stocks and defined-risk options with a {usd(settings.account.starting_capital, { whole: true })} paper account every market
            day. Every search, decision and risk check streams live. The goal: finish every day green.
          </p>
        </div>
        <StreamBadge />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {market && live && <MarketStatus open={market.open} close={market.close} nextOpen={market.next_open ?? new Date(live.clock.next_open)} renderedAt={new Date()} />}
          {live && <span className="text-muted-foreground">Account as of {formatTime(live.asOf)}</span>}
          {!engine.online && <span className="text-loss">The engine is offline.</span>}
        </div>
        {!live ? (
          <Empty>No account data yet. It appears once the engine has started and synced with Alpaca.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Equity" value={usd(live.equity)} sub={<Delta value={live.totalPnl} percent={live.totalPnlPct} />} />
            <Stat label="Today" value={<Delta value={live.dayPnl} className="text-2xl" />} sub={<Delta percent={live.dayPnlPct} />} />
            <Stat label="Cash" value={usd(live.cash)} />
            <Stat
              label="Holdings"
              value={usd(invested)}
              sub={
                <Link href="/holdings" className="text-muted-foreground hover:underline">
                  {live.positions.length} stock{live.positions.length === 1 ? "" : "s"} · {live.options.length} options position{live.options.length === 1 ? "" : "s"}
                </Link>
              }
            />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Latest cycle</CardTitle>
            <CardDescription>
              Follows the newest cycle as it runs: what broker data it gathered, what our own news engine gave it, every search and source, the research memo as it&apos;s
              written, its market read, then each decision with every risk check the code ran, and what was executed. Model reasoning appears when the AI provider returns
              reasoning summaries.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LiveCycleTrail cycleId={latest?._id ?? null} initialEvents={events} triggerItems={wire?.items.map((i) => ({ id: i.id, title: i.title, url: i.url })) ?? []} />
          </CardContent>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          <EngineCard engine={engine} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
              <CardDescription>Everything the engine does, newest first. News shows up here when it matters; everything our feeds saw is on News.</CardDescription>
            </CardHeader>
            <CardContent>
              <ActivityFeed limit={120} className="max-h-[48rem]" />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
