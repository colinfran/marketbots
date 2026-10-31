import { formatTime } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { AgentStatusCard } from "@mb/ui/agent"
import { ActivityFeed, StreamBadge } from "@mb/ui/live"
import { ModelFeed } from "@mb/ui/model-feed"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, Stat } from "@/components/bits"
import { EngineCard } from "@/components/engine-card"
import { MarketStatus } from "@/components/market-status"
import { agentStatusView } from "@/lib/agent"
import { getViewer } from "@/lib/auth"
import { usd } from "@/lib/format"
import { getEngine, getLiveAccount, getSettings } from "@/lib/queries"
import { pageMetadata, site } from "@/lib/site"

export const metadata: Metadata = {
  ...pageMetadata({ title: site.title, description: site.description, path: "/" }),
  title: { absolute: site.title },
}

/** Live: the account at a glance, and everything the agent and the local model are doing as they do it. */
export default async function LivePage() {
  const [viewer, live, engine, settings] = await Promise.all([getViewer(), getLiveAccount(), getEngine(), getSettings()])
  const status = agentStatusView(engine.status)
  const textShown = viewer.owner || settings.agent.public_thinking
  const market = engine.status?.market
  const invested = (live?.positions.reduce((sum, p) => sum + p.marketValue, 0) ?? 0) + (live?.optionsValue ?? 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Live</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            An AI agent on the bot&apos;s own server trades stocks and defined-risk options with a {usd(settings.account.starting_capital, { whole: true })} paper account. Code
            watches prices, news, the setup screen and the session and wakes it when something matters; it looks things up step by step and decides, and the bot&apos;s risk
            rules check every order. Everything the model writes shows here as it writes it. The goal: finish every day green.
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
                <Link prefetch href="/holdings" className="text-muted-foreground hover:underline">
                  {live.positions.length} stock{live.positions.length === 1 ? "" : "s"} · {live.options.length} options position{live.options.length === 1 ? "" : "s"}
                </Link>
              }
            />
          </div>
        )}
      </div>

      <AgentStatusCard status={status} online={engine.online} owner={viewer.owner} />

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">The model, live</CardTitle>
            <CardDescription>
              Every call the engine makes to the local model, as it is written, about once a second: the agent&apos;s steps (its thinking, each lookup it asks for, its
              answer), article summaries and research.{textShown ? "" : " The model's own text is shown to the owner."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ModelFeed textShown={textShown} />
          </CardContent>
        </Card>
        <div className="space-y-4 lg:col-span-2">
          <EngineCard engine={engine} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity</CardTitle>
              <CardDescription>Everything the engine does, newest first: wake-ups, lookups, answers, orders, fills. News shows up here when it matters; everything our feeds saw is on News.</CardDescription>
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
