import { CircleIcon } from "lucide-react"
import type { Metadata } from "next"
import Link from "next/link"
import { AgentStatusCard } from "@mb/ui/agent"
import { ActivityFeed, StreamBadge } from "@mb/ui/live"
import { ModelFeed } from "@mb/ui/model-feed"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { Delta, Empty, Stat } from "@/components/bits"
import { EngineCard } from "@/components/engine-card"
import { agentStatusView } from "@/lib/agent"
import { getViewer } from "@/lib/auth"
import { getAccount, getEngine, getSettings } from "@/lib/data"
import { time, usd } from "@/lib/format"
import { pageMetadata, site } from "@/lib/site"

export const metadata: Metadata = {
  ...pageMetadata({ title: site.title, description: site.description, path: "/" }),
  title: { absolute: site.title },
}

/** Live: the account at a glance, and everything the agent and the local model are doing as they do it. */
export default async function LivePage() {
  const [viewer, data, engine, settings] = await Promise.all([getViewer(), getAccount(), getEngine(), getSettings()])
  const status = agentStatusView(engine.status)
  const textShown = viewer.owner || !!settings?.settings.agent?.public_thinking

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Live</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            An AI agent on the bot&apos;s own server trades crypto in a Kraken paper wallet, 24/7. Code watches prices, news and the screens and wakes it when something
            matters; it looks things up step by step and decides, and a risk engine checks every order. Everything the model writes shows here as it writes it.
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
