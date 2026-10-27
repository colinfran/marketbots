import { formatDay } from "@mb/stock-core/time"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { ReportView } from "@/components/report-view"
import { getViewer } from "@/lib/auth"
import { titleCase } from "@/lib/format"
import { getCycleEvents, getReport, getReportMeta, getWireForCycle, isCoreReview } from "@/lib/queries"
import { jsonLd, pageMetadata, site } from "@/lib/site"

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const meta = await getReportMeta(id).catch(() => null)
  if (!meta) return { title: "Report not found", robots: { index: false } }
  return pageMetadata({
    title: clip(meta.report.headline, 70),
    description: clip(`${titleCase(meta.phase)} AI market report for ${formatDay(meta.trading_day)}. ${meta.report.summary}`, 160),
    path: `/research/${id}`,
    type: "article",
    publishedTime: meta.created_at.toISOString(),
  })
}

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [data, viewer] = await Promise.all([getReport(id), getViewer()])
  if (!data) {
    // A core book review's trades and cycle carry the review's id where a report's would be.
    if (await isCoreReview(id)) redirect(`/core#review-${id}`)
    notFound()
  }
  const [events, wire] = await Promise.all([getCycleEvents(data.report.cycle_id, viewer), getWireForCycle(data.cycle).catch(() => null)])
  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: clip(data.report.report.headline, 110),
    description: data.report.report.summary,
    datePublished: data.report.created_at.toISOString(),
    dateModified: data.report.created_at.toISOString(),
    mainEntityOfPage: `${site.url}/research/${id}`,
    image: `${site.url}/research/${id}/opengraph-image`,
    author: { "@type": "Person", name: site.author.name, url: site.author.url },
    publisher: { "@type": "Person", name: site.author.name, url: site.author.url },
  }
  return (
    <div className="space-y-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={jsonLd(article)} />
      <Link href={`/journal/${data.report.trading_day}`} className="text-muted-foreground text-sm hover:underline">
        ← {formatDay(data.report.trading_day)}
      </Link>
      <ReportView doc={data.report} decisions={data.decisions} cycle={data.cycle} events={events} wire={wire} />
    </div>
  )
}
