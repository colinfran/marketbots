import { formatTime } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { ActivityFeed, StreamBadge } from "@mb/ui/live"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { NewsThatMatters } from "@mb/ui/wire"
import { CycleKindBadge, PageHeader, PhaseBadge, SectionTitle, StatusBadge } from "@/components/bits"
import { LiveCycleTrail } from "@/components/live/cycle-trail"
import { getViewer } from "@/lib/auth"
import { duration } from "@/lib/format"
import { getCycleEvents, getCycles, getNotableItems, getWireForCycle } from "@/lib/queries"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Watch the AI trade live",
  description:
    "The live thinking process of StockMarketBot's Grok-powered AI: the news its own engine flagged, every web and X search, every source it reads, its market read, each stock and options decision with every risk check, and the orders, as they happen.",
  path: "/live",
})

export default async function LivePage() {
  const viewer = await getViewer()
  const [cycles, notable] = await Promise.all([getCycles(15), getNotableItems(6, 10)])
  const latest = cycles[0] ?? null
  const [events, wire] = await Promise.all([latest ? getCycleEvents(latest._id, viewer) : [], getWireForCycle(latest).catch(() => null)])

  return (
    <div className="space-y-8">
      <PageHeader
        title="Live"
        description="Watch the AI work: what broker data it gathered, what our own news engine gave it, every search and source, the research memo as it's written, its market read, then each decision with every risk check the code ran, and what was executed."
        action={<StreamBadge />}
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Latest cycle</CardTitle>
            <CardDescription>Follows the newest cycle as it runs. Model reasoning appears when the AI provider returns reasoning summaries.</CardDescription>
          </CardHeader>
          <CardContent>
            <LiveCycleTrail cycleId={latest?._id ?? null} initialEvents={events} triggerItems={wire?.items.map((i) => ({ id: i.id, title: i.title, url: i.url })) ?? []} />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Activity</CardTitle>
            <CardDescription>Everything the engine does, newest first. News shows up here only when it matters.</CardDescription>
          </CardHeader>
          <CardContent>
            <ActivityFeed limit={120} className="max-h-[48rem]" />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">News that matters</CardTitle>
          <CardDescription>What our own news engine saw in the last 6 hours that touches a holding, the market as a whole, or a trade the AI is weighing. Everything else is on the Research page.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewsThatMatters initial={notable} />
        </CardContent>
      </Card>
      <section>
        <SectionTitle>Recent cycles</SectionTitle>
        <div className="divide-y rounded-xl border text-sm">
          {cycles.map((c) => (
            <div key={c._id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3">
              <PhaseBadge phase={c.phase} />
              <span className="text-muted-foreground">{formatTime(c.started_at)}</span>
              <StatusBadge status={c.status} />
              <CycleKindBadge kind={c.kind} />
              <span className="text-muted-foreground text-xs">{duration(c.duration_ms)}</span>
              <span className="text-muted-foreground text-xs">{c.kind === "event" ? c.trigger.replace(/^event:\s*/, "") : c.trigger}</span>
              {c.report_id ? (
                <Link href={`/research/${c.report_id}`} className="ml-auto text-xs font-medium hover:underline">
                  Report
                </Link>
              ) : (
                c.error && <span className="text-loss ml-auto line-clamp-1 max-w-md text-xs">{c.error}</span>
              )}
            </div>
          ))}
          {cycles.length === 0 && <p className="text-muted-foreground p-6 text-center">No cycles yet.</p>}
        </div>
      </section>
    </div>
  )
}
