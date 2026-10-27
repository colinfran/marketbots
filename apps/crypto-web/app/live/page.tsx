import type { Metadata } from "next"
import Link from "next/link"
import { ActivityFeed, StreamBadge } from "@mb/ui/live"
import { Badge } from "@mb/ui/components/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@mb/ui/components/card"
import { NewsThatMatters } from "@mb/ui/wire"
import { PageHeader, SectionTitle, StatusBadge } from "@/components/bits"
import { LiveCycleTrail } from "@/components/live/cycle-trail"
import { getViewer } from "@/lib/auth"
import { getCycleEvents, getCycles, getNotableItems } from "@/lib/data"
import { dateTime, duration } from "@/lib/format"
import { pageMetadata } from "@/lib/site"

export const metadata: Metadata = pageMetadata({
  title: "Watch the AI trade live",
  description:
    "The live thinking process of CryptoMarketBot's Grok-powered AI: the market scan, every web and X search and source it reads, each decision with its risk check, and the orders, as they happen.",
  path: "/live",
})

export default async function LivePage() {
  const viewer = await getViewer()
  const [cycles, notable] = await Promise.all([getCycles(15), getNotableItems(6, 10)])
  const latest = cycles[0] ?? null
  const events = latest ? await getCycleEvents(latest._id, viewer) : []

  return (
    <div className="space-y-8">
      <PageHeader
        title="Live"
        description="Watch the AI work: the market scan and what it flagged, every search and source, the research memo as it's written, then each decision with its risk check, and what was executed."
        action={<StreamBadge />}
      />
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">Latest cycle</CardTitle>
            <CardDescription>Follows the newest cycle as it runs. The AI steps only run when the scan finds a setup or a position needs review.</CardDescription>
          </CardHeader>
          <CardContent>
            <LiveCycleTrail
              cycleId={latest?._id ?? null}
              initialEvents={events}
              stored={latest ? { status: latest.status, summary: latest.summary, error: latest.error, finishedAt: latest.finished_at?.toISOString() ?? null } : null}
            />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Activity</CardTitle>
            <CardDescription>Everything the engine does, newest first.</CardDescription>
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
              <span className="text-muted-foreground">{dateTime(c.started_at)}</span>
              <StatusBadge status={c.status} />
              {c.kind === "event" && <Badge variant="secondary">News event</Badge>}
              {c.kind === "seed" && <Badge variant="secondary">Seed</Badge>}
              <span className="text-muted-foreground text-xs">{duration(c.duration_ms)}</span>
              <span className="text-muted-foreground text-xs">{c.trigger}</span>
              {c.summary && <span className="text-muted-foreground line-clamp-1 max-w-md text-xs">{c.summary}</span>}
              {c.research_id || c.decision_ids.length ? (
                <Link href={`/research/${c._id}`} className="ml-auto text-xs font-medium hover:underline">
                  Research & decisions
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
