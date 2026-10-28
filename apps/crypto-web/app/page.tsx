import { CircleIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { ActivityFeed, StreamBadge } from "@mb/ui/live"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, Stat } from "@/components/bits"
import { EngineCard } from "@/components/engine-card"
import { LiveCycleTrail } from "@/components/live/cycle-trail"
import { getViewer } from "@/lib/auth"
import { getAccount, getCycleEvents, getCycles, getEngine } from "@/lib/data"
import { time, usd } from "@/lib/format"
import { pageMetadata, site } from "@/lib/site"

export const metadata: Metadata = {
  ...pageMetadata({ title: site.title, description: site.description, path: "/" }),
  title: { absolute: site.title },
}

/** Live: the account at a glance and the AI at work as it happens. Everything else has one page of its own. */
export default async function LivePage() {
  const [viewer, data, engine, cycles] = await Promise.all([getViewer(), getAccount(), getEngine(), getCycles(1)])
  const latest = cycles[0] ?? null
  const events = latest ? await getCycleEvents(latest._id, viewer) : []

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Live AI trading desk</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            Grok researches the crypto market with live web and X search, decides what to buy, hold or avoid, and a deterministic risk engine sizes and checks every
            order before it executes in a Kraken paper wallet. Running 24/7.
          </p>
        </div>
        <StreamBadge />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <CircleIcon className="fill-gain text-gain size-2.5" aria-hidden />
            Market open 24/7
          </span>
          {data && <span className="text-muted-foreground">Account as of {time(data.account.updated_at)}</span>}
          {!engine.online && <span className="text-loss">The engine is offline.</span>}
        </div>
        {!data ? (
          <Empty>No paper account yet. Start the engine: it creates the wallet on first boot.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Equity" value={usd(data.account.equity_usd)} sub={<Delta value={data.totalPnl} percent={data.totalReturnPct} />} />
            <Stat label="Today (UTC)" value={<Delta value={data.dayPnl} className="text-2xl" />} sub={<Delta percent={data.dayPnlPct} />} />
            <Stat label="Cash" value={usd(data.account.cash_usd)} sub={<span className="text-muted-foreground">fees paid {usd(data.account.fees_usd)}</span>} />
            <Stat
              label="Holdings"
              value={usd(data.marketValue)}
              sub={
                <Link href="/holdings" className="text-muted-foreground hover:underline">
                  {data.positions.length} position{data.positions.length === 1 ? "" : "s"}
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
              Follows the newest cycle as it runs: the market scan and what it flagged, every search and source, the research memo as it&apos;s written, then each decision with
              its risk check, and what was executed. The AI steps only run when the scan finds a setup or a position needs review.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LiveCycleTrail
              cycleId={latest?._id ?? null}
              initialEvents={events}
              stored={latest ? { status: latest.status, summary: latest.summary, error: latest.error, finishedAt: latest.finished_at?.toISOString() ?? null } : null}
            />
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
